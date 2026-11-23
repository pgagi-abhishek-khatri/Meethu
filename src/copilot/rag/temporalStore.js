// src/copilot/rag/temporalStore.js
// Bi-temporal storage engine, schema migration, and lifecycle management for copilot_chunks.
// Pure, Electron-free. Handles versioning, supersession graphs, and point-in-time retrieval.

const { toBuffer, fromBuffer } = require("./vectors");

const CHUNK_TEMPORAL_COLUMNS = [
  ["feature_id", "TEXT"],
  ["version", "TEXT"],
  ["lifecycle_status", "TEXT NOT NULL DEFAULT 'active'"],
  ["superseded_by_id", "INTEGER"],
  ["transaction_time", "INTEGER"],
  ["valid_from", "INTEGER"],
  ["valid_to", "INTEGER"],
];

const TEMPORAL_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_copilot_chunks_feature_active ON copilot_chunks(project_id, feature_id, lifecycle_status)",
  "CREATE INDEX IF NOT EXISTS idx_copilot_chunks_temporal ON copilot_chunks(project_id, feature_id, valid_from, valid_to)",
  "CREATE INDEX IF NOT EXISTS idx_copilot_chunks_version ON copilot_chunks(project_id, feature_id, version)",
  "CREATE INDEX IF NOT EXISTS idx_copilot_chunks_superseded_by ON copilot_chunks(superseded_by_id)",
];

const VALID_LIFECYCLE_STATUSES = new Set(["active", "superseded", "deprecated", "draft"]);

// Drafts are inserted with valid_to = NULL, so the time window alone would treat unapproved text as authoritative.
// IS NOT keeps NULL (legacy active) rows; superseded/deprecated stay visible historically, bounded by valid_to.
const NOT_DRAFT_SQL = "c.lifecycle_status IS NOT 'draft'";

/**
 * Idempotently migrates the copilot_chunks table with temporal columns and indexes.
 * Preserves all existing records, embeddings, vector dimensions, and FTS5 data.
 *
 * @param {Object} db - better-sqlite3 database instance
 * @param {Object} [options]
 * @param {Function} [options.addColumn] - Custom addColumn helper if available
 * @returns {{ migrated: boolean, addedColumns: string[], existingColumns: string[] }}
 */
function migrateTemporalSchema(db, { addColumn } = {}) {
  const existingCols = db
    .prepare("PRAGMA table_info(copilot_chunks)")
    .all()
    .map((c) => c.name);

  const existingColSet = new Set(existingCols);
  const addedColumns = [];

  const execAddColumn = (column, typeDef) => {
    if (typeof addColumn === "function") {
      addColumn("copilot_chunks", column, typeDef);
    } else {
      db.exec(`ALTER TABLE copilot_chunks ADD COLUMN ${column} ${typeDef}`);
    }
  };

  for (const [colName, colType] of CHUNK_TEMPORAL_COLUMNS) {
    if (!existingColSet.has(colName)) {
      execAddColumn(colName, colType);
      addedColumns.push(colName);
    }
  }

  // Create temporal indexes idempotently
  for (const idxSql of TEMPORAL_INDEXES) {
    db.exec(idxSql);
  }

  return {
    migrated: addedColumns.length > 0,
    addedColumns,
    existingColumns: existingCols,
  };
}

/**
 * Creates the Temporal Store Engine instance.
 *
 * @param {Object} db - better-sqlite3 database instance
 * @param {Object} [options]
 * @param {Function} [options.now=Date.now] - Epoch ms provider
 * @param {Object} [options.featureRegistry=null] - Canonical feature registry for validation
 * @returns {Object} Temporal store API
 */
function createTemporalStore(db, { now = Date.now, featureRegistry = null, onMutate = null } = {}) {
  // Ensure schema and indexes exist
  migrateTemporalSchema(db);

  const notifyMutate = (projectId) => {
    if (typeof onMutate === "function") {
      try {
        onMutate(projectId);
      } catch {}
    }
  };

  const q = {
    insertChunk: db.prepare(
      `INSERT INTO copilot_chunks (
        file_id, project_id, ord, text, meta, embed, hash, dims, vec,
        feature_id, version, lifecycle_status, superseded_by_id, transaction_time, valid_from, valid_to
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    insertFts: db.prepare("INSERT INTO copilot_chunks_fts (rowid, text) VALUES (?, ?)"),
    getChunkById: db.prepare("SELECT * FROM copilot_chunks WHERE id = ?"),
    getActiveFeatureChunks: db.prepare(
      `SELECT c.*, f.name AS file
       FROM copilot_chunks c
       LEFT JOIN copilot_project_files f ON f.id = c.file_id
       WHERE c.project_id = ? AND c.feature_id = ? AND c.lifecycle_status = 'active'
         AND (c.valid_to IS NULL OR c.valid_to > ?)
       ORDER BY c.valid_from DESC, c.version DESC, c.ord ASC`
    ),
    getFeatureAt: db.prepare(
      `SELECT c.*, f.name AS file
       FROM copilot_chunks c
       LEFT JOIN copilot_project_files f ON f.id = c.file_id
       WHERE c.project_id = ? AND c.feature_id = ?
         AND c.valid_from <= ? AND (c.valid_to IS NULL OR c.valid_to > ?)
         AND ${NOT_DRAFT_SQL}
       ORDER BY c.version DESC, c.ord ASC`
    ),
    getFeatureInRange: db.prepare(
      `SELECT c.*, f.name AS file
       FROM copilot_chunks c
       LEFT JOIN copilot_project_files f ON f.id = c.file_id
       WHERE c.project_id = ? AND c.feature_id = ?
         AND c.valid_from <= ? AND (c.valid_to IS NULL OR c.valid_to > ?)
         AND ${NOT_DRAFT_SQL}
       ORDER BY c.valid_from DESC, c.version DESC, c.ord ASC`
    ),
    getFeatureLineage: db.prepare(
      `SELECT c.id, c.file_id, c.project_id, c.ord, c.text, c.meta,
              c.feature_id, c.version, c.lifecycle_status, c.superseded_by_id, c.transaction_time, c.valid_from, c.valid_to,
              f.name AS file
       FROM copilot_chunks c
       LEFT JOIN copilot_project_files f ON f.id = c.file_id
       WHERE c.project_id = ? AND c.feature_id = ?
       ORDER BY c.valid_from ASC, c.id ASC`
    ),
    updateSupersede: db.prepare(
      "UPDATE copilot_chunks SET lifecycle_status = 'superseded', valid_to = ?, superseded_by_id = ? WHERE id = ?"
    ),
    updateDeprecate: db.prepare(
      "UPDATE copilot_chunks SET lifecycle_status = 'deprecated', valid_to = COALESCE(valid_to, ?) WHERE id = ?"
    ),
    chunksByProjectAndFeature: db.prepare(
      "SELECT id, version, lifecycle_status, superseded_by_id, valid_from, valid_to FROM copilot_chunks WHERE project_id = ? AND feature_id = ?"
    ),
    countActiveFeatureChunks: db.prepare(
      "SELECT COUNT(*) as count FROM copilot_chunks WHERE project_id = ? AND feature_id = ? AND lifecycle_status = 'active' AND (valid_to IS NULL OR valid_to > ?)"
    ),
  };

  /**
   * Parses row metadata and vector buffer.
   */
  function formatChunkRow(row) {
    if (!row) return null;
    let meta = {};
    try {
      meta = typeof row.meta === "string" ? JSON.parse(row.meta) : row.meta || {};
    } catch {}
    return {
      ...row,
      meta,
      superseded_reason: meta.superseded_reason || null,
      vec: row.vec ? fromBuffer(row.vec) : null,
    };
  }

  /**
   * Validates chunk temporal fields before insertion or transition.
   */
  function validateChunkFields({
    feature_id = null,
    version = null,
    lifecycle_status = "active",
    valid_from = null,
    valid_to = null,
  }) {
    if (lifecycle_status && !VALID_LIFECYCLE_STATUSES.has(lifecycle_status)) {
      throw new Error(
        `Invalid lifecycle_status '${lifecycle_status}'. Allowed: ${Array.from(VALID_LIFECYCLE_STATUSES).join(", ")}`
      );
    }

    if (valid_from != null) {
      if (typeof valid_from !== "number" || isNaN(valid_from)) {
        throw new Error(`valid_from must be a valid numeric timestamp, got '${valid_from}'`);
      }
    }

    if (valid_to != null) {
      if (typeof valid_to !== "number" || isNaN(valid_to)) {
        throw new Error(`valid_to must be a valid numeric timestamp or null, got '${valid_to}'`);
      }
      if (valid_from != null && valid_to <= valid_from) {
        throw new Error(
          `valid_to (${valid_to}) must be strictly greater than valid_from (${valid_from})`
        );
      }
    }

    if (feature_id != null) {
      if (typeof feature_id !== "string" || feature_id.trim().length === 0) {
        throw new Error(`feature_id must be a non-empty string or null`);
      }
      // If canonical feature registry is available, optionally check registration
      if (featureRegistry && typeof featureRegistry.getFeatureById === "function") {
        const canonical = featureRegistry.getFeatureById(feature_id);
        if (!canonical) {
          // Warning or permissible dynamic feature
        }
      }
    }
  }

  /**
   * A. Insert a temporal chunk record with full bi-temporal metadata.
   */
  function insertTemporalChunk(chunkData, metadata = {}) {
    const file_id = chunkData.file_id ?? metadata.file_id ?? 0;
    const project_id = chunkData.project_id ?? metadata.project_id ?? 0;
    const ord = chunkData.ord ?? metadata.ord ?? 0;
    const text = String(chunkData.text ?? "");
    const meta = {
      ...(chunkData.meta ?? metadata.meta ?? {}),
      ...(chunkData.superseded_reason ? { superseded_reason: chunkData.superseded_reason } : {}),
      ...(metadata.superseded_reason ? { superseded_reason: metadata.superseded_reason } : {}),
    };
    const embed = chunkData.embed ?? metadata.embed ?? "text";
    const hash = chunkData.hash ?? metadata.hash ?? null;
    const dims = chunkData.vec ? (chunkData.dims ?? chunkData.vec.length) : null;
    const vecBlob = chunkData.vec ? toBuffer(chunkData.vec) : null;

    const feature_id = chunkData.feature_id ?? metadata.feature_id ?? null;
    const version = chunkData.version ?? metadata.version ?? null;
    const lifecycle_status = chunkData.lifecycle_status ?? metadata.lifecycle_status ?? "active";
    const superseded_by_id = chunkData.superseded_by_id ?? metadata.superseded_by_id ?? null;

    const currentTime = now();
    const transaction_time = chunkData.transaction_time ?? metadata.transaction_time ?? currentTime;
    const valid_from = chunkData.valid_from ?? metadata.valid_from ?? currentTime;
    const valid_to = chunkData.valid_to ?? metadata.valid_to ?? null;

    validateChunkFields({
      feature_id,
      version,
      lifecycle_status,
      valid_from,
      valid_to,
    });

    let insertedId = null;

    db.transaction(() => {
      const res = q.insertChunk.run(
        file_id,
        project_id,
        ord,
        text,
        JSON.stringify(meta),
        embed,
        hash,
        dims,
        vecBlob,
        feature_id,
        version,
        lifecycle_status,
        superseded_by_id,
        transaction_time,
        valid_from,
        valid_to
      );
      insertedId = Number(res.lastInsertRowid);
      q.insertFts.run(insertedId, text);
    })();
    notifyMutate(project_id);

    return {
      id: insertedId,
      file_id,
      project_id,
      ord,
      text,
      meta,
      feature_id,
      version,
      lifecycle_status,
      superseded_by_id,
      transaction_time,
      valid_from,
      valid_to,
    };
  }

  /**
   * B. Retrieve active feature chunks for a given project and feature.
   */
  function getActiveFeatureChunks(projectId, featureId) {
    if (!featureId) return [];
    const currentTime = now();
    const rows = q.getActiveFeatureChunks.all(projectId, featureId, currentTime);
    return rows.map(formatChunkRow);
  }

  /**
   * C. Retrieve feature chunks at a specific point in time (historical retrieval).
   */
  function getFeatureAt(projectId, featureId, targetTime) {
    if (!featureId || targetTime == null) return [];
    const t = Number(targetTime);
    if (isNaN(t)) throw new Error(`Invalid targetTime '${targetTime}'`);
    const rows = q.getFeatureAt.all(projectId, featureId, t, t);
    return rows.map(formatChunkRow);
  }

  /**
   * C2. Retrieve feature chunks overlapping a historical time range [rangeStart, rangeEnd].
   * Ensures month/quarter/year queries (e.g. "August 2026") match mid-month effective dates.
   */
  function getFeatureInRange(projectId, featureId, rangeStart, rangeEnd = null) {
    if (!featureId || rangeStart == null) return [];
    const start = Number(rangeStart);
    const end = rangeEnd != null ? Number(rangeEnd) : start;
    if (isNaN(start) || isNaN(end)) {
      throw new Error(`Invalid range [${rangeStart}, ${rangeEnd}]`);
    }
    const rows = q.getFeatureInRange.all(projectId, featureId, end, start);
    return rows.map(formatChunkRow);
  }

  /**
   * D. Retrieve entire version lineage for a feature.
   */
  function getFeatureLineage(projectId, featureId) {
    if (!featureId) return [];
    const rows = q.getFeatureLineage.all(projectId, featureId);
    return rows.map(formatChunkRow);
  }

  /**
   * E. Supersede an existing chunk with a successor chunk.
   */
  function supersedeChunk(predecessorId, successorId, effectiveTime = null) {
    const predId = Number(predecessorId);
    const succId = Number(successorId);

    if (predId === succId) {
      throw new Error(`Self-supersession is forbidden: chunk ${predId} cannot supersede itself`);
    }

    const pred = q.getChunkById.get(predId);
    if (!pred) {
      throw new Error(`Predecessor chunk #${predId} does not exist`);
    }

    const succ = q.getChunkById.get(succId);
    if (!succ) {
      throw new Error(`Successor chunk #${succId} does not exist`);
    }

    if (pred.feature_id && succ.feature_id && pred.feature_id !== succ.feature_id) {
      throw new Error(
        `Feature ID mismatch: Predecessor feature '${pred.feature_id}' does not match successor '${succ.feature_id}'`
      );
    }

    const effTime = effectiveTime != null ? Number(effectiveTime) : (succ.valid_from ?? now());

    if (pred.valid_from != null && effTime <= pred.valid_from) {
      throw new Error(
        `Supersede effectiveTime (${effTime}) must be strictly greater than predecessor valid_from (${pred.valid_from})`
      );
    }

    // Circularity check: traverse successor's superseded_by chain
    let curr = succ;
    const visited = new Set([predId, succId]);
    while (curr && curr.superseded_by_id) {
      if (curr.superseded_by_id === predId) {
        throw new Error(
          `Circular supersession detected: chunk ${succId} eventually supersedes ${predId}`
        );
      }
      if (visited.has(curr.superseded_by_id)) break;
      visited.add(curr.superseded_by_id);
      curr = q.getChunkById.get(curr.superseded_by_id);
    }

    db.transaction(() => {
      q.updateSupersede.run(effTime, succId, predId);
    })();
    notifyMutate(pred.project_id);

    return {
      predecessor_id: predId,
      successor_id: succId,
      valid_to: effTime,
      lifecycle_status: "superseded",
    };
  }

  /**
   * F. Deprecate an existing chunk.
   */
  function deprecateChunk(chunkId, effectiveTime = null) {
    const id = Number(chunkId);
    const chunk = q.getChunkById.get(id);
    if (!chunk) {
      throw new Error(`Chunk #${id} not found`);
    }

    const effTime = effectiveTime != null ? Number(effectiveTime) : now();

    db.transaction(() => {
      q.updateDeprecate.run(effTime, id);
    })();
    notifyMutate(chunk.project_id);

    return {
      chunk_id: id,
      lifecycle_status: "deprecated",
      valid_to: chunk.valid_to ?? effTime,
    };
  }

  /**
   * G. Transactional Version Activation.
   * Atomically inserts the successor chunk and marks the predecessor as superseded.
   * When preserveUnchangedHashes is provided, unchanged sibling chunks whose content hash
   * remains present in the updated document are preserved as active rather than re-embedded.
   */
  function activateSuccessorVersion({
    predecessorId,
    newChunkData,
    effectiveTime = null,
    preserveUnchangedHashes = null,
  }) {
    const predId = Number(predecessorId);
    const pred = q.getChunkById.get(predId);
    if (!pred) {
      throw new Error(`Predecessor chunk #${predId} not found`);
    }

    const effTime = effectiveTime != null ? Number(effectiveTime) : now();
    const preservedSet =
      preserveUnchangedHashes instanceof Set
        ? preserveUnchangedHashes
        : Array.isArray(preserveUnchangedHashes)
          ? new Set(preserveUnchangedHashes)
          : null;

    let newChunk = null;

    db.transaction(() => {
      // 1. Insert new successor chunk as active
      newChunk = insertTemporalChunk(
        {
          file_id: pred.file_id,
          project_id: pred.project_id,
          feature_id: pred.feature_id,
          lifecycle_status: "active",
          valid_from: effTime,
          valid_to: null,
          transaction_time: now(),
          ...newChunkData,
        }
      );

      // 2. Update primary predecessor (unless it is an unchanged sibling explicitly preserved)
      if (!preservedSet || !pred.hash || !preservedSet.has(pred.hash)) {
        supersedeChunk(predId, newChunk.id, effTime);
      }

      // 3. Atomically supersede older active chunks for this feature belonging to predecessor files or earlier validity,
      // skipping any unchanged sibling section still present in preserveUnchangedHashes.
      const targetFeat = newChunkData.feature_id || pred.feature_id;
      const targetProj = newChunkData.project_id || pred.project_id;
      if (targetFeat && targetProj) {
        const olderChunks = db.prepare(
          `SELECT id, valid_from, hash FROM copilot_chunks 
           WHERE project_id = ? AND feature_id = ? AND lifecycle_status = 'active' AND id != ?
             AND (file_id != ? OR (valid_from IS NOT NULL AND valid_from < ?))`
        ).all(targetProj, targetFeat, newChunk.id, newChunk.file_id, effTime);

        for (const oc of olderChunks) {
          if (preservedSet && oc.hash && preservedSet.has(oc.hash)) {
            continue;
          }
          try {
            const ocEff = (oc.valid_from != null && effTime > oc.valid_from) ? effTime : (oc.valid_from != null ? oc.valid_from + 1 : effTime);
            supersedeChunk(oc.id, newChunk.id, ocEff);
          } catch (e) {
            // Ignore if already superseded
          }
        }
      }
    })();

    return {
      predecessor_id: predId,
      successor: newChunk,
      effective_time: effTime,
    };
  }

  /**
   * H. Validate Temporal Integrity of records within a project and feature.
   */
  function validateTemporalIntegrity(projectId, featureId) {
    const errors = [];
    const warnings = [];

    const rows = q.chunksByProjectAndFeature.all(projectId, featureId);
    if (rows.length === 0) {
      return { valid: true, errors: [], warnings: [] };
    }

    let activeCount = 0;
    const rowMap = new Map();

    for (const r of rows) {
      rowMap.set(r.id, r);

      if (r.lifecycle_status === "active") {
        activeCount++;
      }

      // Check interval
      if (r.valid_to != null && r.valid_from != null) {
        if (r.valid_to <= r.valid_from) {
          errors.push(
            `Chunk #${r.id} has invalid interval: valid_to (${r.valid_to}) <= valid_from (${r.valid_from})`
          );
        }
      }

      // Check superseded pointer
      if (r.superseded_by_id != null) {
        if (r.superseded_by_id === r.id) {
          errors.push(`Chunk #${r.id} supersedes itself`);
        } else {
          const succ = q.getChunkById.get(r.superseded_by_id);
          if (!succ) {
            errors.push(
              `Chunk #${r.id} references non-existent successor chunk #${r.superseded_by_id}`
            );
          }
        }
      }
    }

    // Check multiple active versions
    if (activeCount > 1) {
      warnings.push(
        `Feature '${featureId}' has ${activeCount} active chunk versions in project ${projectId}`
      );
    }

    // Check circular supersession chains
    for (const r of rows) {
      if (r.superseded_by_id) {
        let curr = r;
        const visited = new Set([r.id]);
        while (curr && curr.superseded_by_id) {
          if (visited.has(curr.superseded_by_id)) {
            errors.push(
              `Circular supersession detected starting at chunk #${r.id} -> #${curr.superseded_by_id}`
            );
            break;
          }
          visited.add(curr.superseded_by_id);
          curr = rowMap.get(curr.superseded_by_id) || q.getChunkById.get(curr.superseded_by_id);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      checkedCount: rows.length,
    };
  }

  return {
    migrateSchema: () => migrateTemporalSchema(db),
    insertTemporalChunk,
    getActiveFeatureChunks,
    getFeatureAt,
    getFeatureInRange,
    getFeatureLineage,
    supersedeChunk,
    deprecateChunk,
    activateSuccessorVersion,
    validateTemporalIntegrity,
  };
}

module.exports = {
  migrateTemporalSchema,
  createTemporalStore,
  CHUNK_TEMPORAL_COLUMNS,
  TEMPORAL_INDEXES,
  VALID_LIFECYCLE_STATUSES,
  NOT_DRAFT_SQL,
};
