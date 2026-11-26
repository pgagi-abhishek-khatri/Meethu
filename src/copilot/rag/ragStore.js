// Chunks, their vectors and the keyword index, inside the copilot's own SQLite file. Search is a plain loop over
// the project's vectors held in memory (a few thousand chunks = a few ms) merged with SQLite FTS5 keyword hits.
const { toBuffer, fromBuffer, topK, rrf } = require("./vectors");
const {
  createTemporalStore,
  migrateTemporalSchema,
  CHUNK_TEMPORAL_COLUMNS,
  TEMPORAL_INDEXES,
  NOT_DRAFT_SQL,
} = require("./temporalStore");
const { createDeltaIngest } = require("./deltaIngest");
const { createAuthoritativeLookup } = require("./authoritativeLookup");
const { createTemporalRouter } = require("../core/okf/temporalRouter");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS copilot_project_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL, added_at INTEGER
);
CREATE TABLE IF NOT EXISTS copilot_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER NOT NULL, project_id INTEGER NOT NULL, ord INTEGER NOT NULL,
  text TEXT NOT NULL, meta TEXT, embed TEXT, hash TEXT, dims INTEGER, vec BLOB
);
CREATE INDEX IF NOT EXISTS copilot_chunks_file ON copilot_chunks(file_id);
CREATE INDEX IF NOT EXISTS copilot_chunks_project ON copilot_chunks(project_id);
CREATE INDEX IF NOT EXISTS copilot_chunks_hash ON copilot_chunks(hash);
CREATE VIRTUAL TABLE IF NOT EXISTS copilot_chunks_fts USING fts5(text, tokenize = 'unicode61 remove_diacritics 2');
`;

// File columns added to copilot_project_files: what happened when it was indexed.
const FILE_COLUMNS = [
  ["kind", "TEXT"],
  ["status", "TEXT"], // queued | reading | analysing | embedding | ready | error
  ["stage", "TEXT"],
  ["error", "TEXT"],
  ["note", "TEXT"], // e.g. "partial: only the first 64k tokens were read"
  ["summary", "TEXT"],
  ["profile", "TEXT"], // JSON file profile (profile.js): brief, abstract, topics, facts, terms
  ["profile_v", "INTEGER"],
  ["hash", "TEXT"],
  ["bytes", "INTEGER"],
  ["chunk_count", "INTEGER"],
  ["tokens", "INTEGER"],
  ["cost", "REAL"],
  ["indexed_at", "INTEGER"],
];

// Words that say nothing about the subject; a question's "what is the" must not match every chunk.
const STOP = new Set(
  "the and for are but not you your yours his her its our their they them this that these those with from into over about what which who whom whose when where why how does did doing done have has had was were been being will would could should can cant cannot may might must shall than then there here also just very much many more most some any all each every other such only own same too out off per via get got let say said tell told know want need like make made give gave take took see saw look looks look going".split(
    " "
  )
);

// FTS5 query from free text: each word quoted (so punctuation cannot break the syntax), joined by OR; short words dropped.
// A word that is an identifier also contributes its parts ("retrieveChunks" -> retrieve, chunks), and neighbouring
// plain words contribute their joined form ("load config" -> loadconfig): the passage may spell the name the other way,
// and the index keeps "loadConfig" as the single token "loadconfig".
const MAX_FTS_TERMS = 32;
function ftsQuery(text) {
  const words = String(text).match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [];
  const keep = (w) => w.length > 2 && !STOP.has(w);
  const out = new Set();
  const add = (w) => {
    if (out.size < MAX_FTS_TERMS && keep(w)) out.add(w);
  };
  const lower = words.map((w) => w.toLowerCase());
  lower.slice(0, 24).forEach(add);
  words.slice(0, 24).forEach((w) => {
    const parts = w
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/\s+/)
      .map((p) => p.toLowerCase());
    if (parts.length > 1) parts.forEach(add);
  });
  const plain = lower.filter((w) => keep(w) && w.length >= 4).slice(0, 5);
  for (let i = 0; i + 1 < plain.length; i++) add(plain[i] + plain[i + 1]); // at most four joins
  return [...out].map((w) => `"${w.replace(/"/g, "")}"`).join(" OR ");
}

function createRagStore(db, { addColumn, now = Date.now } = {}) {
  // The store opens before the RAG log exists, so the log is bound late through configure().
  let log = () => {};
  db.exec(SCHEMA);
  for (const [c, t] of FILE_COLUMNS) {
    if (typeof addColumn === "function") {
      addColumn("copilot_project_files", c, t);
    } else {
      const has = db
        .prepare("PRAGMA table_info(copilot_project_files)")
        .all()
        .some((col) => col.name === c);
      if (!has) db.exec(`ALTER TABLE copilot_project_files ADD COLUMN ${c} ${t}`);
    }
  }

  // project id -> { ids, data } kept until the project's chunks change (including temporal mutations)
  const matrices = new Map();
  const invalidateMatrices = (projectId = null) => {
    if (projectId == null) {
      matrices.clear();
      return;
    }
    const prefix = `${projectId}:`;
    for (const key of matrices.keys()) if (key.startsWith(prefix)) matrices.delete(key);
  };

  // Phase 2: Idempotent Temporal Schema Migration & Store
  migrateTemporalSchema(db, { addColumn });
  const temporal = createTemporalStore(db, { now, onMutate: invalidateMatrices });

  const q = {
    file: db.prepare("SELECT * FROM copilot_project_files WHERE id = ?"),
    insert: db.prepare(
      "INSERT INTO copilot_chunks (file_id, project_id, ord, text, meta, embed, hash, dims, vec) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ),
    insertFts: db.prepare("INSERT INTO copilot_chunks_fts (rowid, text) VALUES (?, ?)"),
    ids: db.prepare("SELECT id FROM copilot_chunks WHERE file_id = ?"),
    // Legacy rows only: versioned rows carry lineage that a legacy re-ingest must not erase.
    legacyIds: db.prepare(
      "SELECT id FROM copilot_chunks WHERE file_id = ? AND feature_id IS NULL AND version IS NULL"
    ),
    delFts: db.prepare("DELETE FROM copilot_chunks_fts WHERE rowid = ?"),
    delChunks: db.prepare("DELETE FROM copilot_chunks WHERE file_id = ?"),
    delLegacyChunks: db.prepare(
      "DELETE FROM copilot_chunks WHERE file_id = ? AND feature_id IS NULL AND version IS NULL"
    ),
    byHash: db.prepare(
      "SELECT hash, vec FROM copilot_chunks WHERE hash IN (SELECT value FROM json_each(?)) AND dims = ?"
    ),
    vectors: db.prepare(
      "SELECT id, vec FROM copilot_chunks WHERE project_id = ? AND dims = ? AND vec IS NOT NULL"
    ),
    activeVectors: db.prepare(
      `SELECT id, vec FROM copilot_chunks
       WHERE project_id = ? AND dims = ?
         AND (lifecycle_status IS NULL OR lifecycle_status = 'active')
         AND (valid_from IS NULL OR valid_from <= ?)
         AND (valid_to IS NULL OR valid_to > ?)
         AND vec IS NOT NULL`
    ),
    // Next instant at which the active set changes by time alone (a chunk starts or expires).
    nextActiveBoundary: db.prepare(
      `SELECT MIN(t) AS t FROM (
         SELECT valid_from AS t FROM copilot_chunks
          WHERE project_id = ? AND valid_from > ? AND lifecycle_status IS NOT 'draft'
         UNION ALL
         SELECT valid_to AS t FROM copilot_chunks
          WHERE project_id = ? AND valid_to > ? AND lifecycle_status IS NOT 'draft'
       )`
    ),
    historicalVectors: db.prepare(
      `SELECT c.id, c.vec FROM copilot_chunks c
       WHERE c.project_id = ? AND c.dims = ?
         AND (c.valid_from IS NULL OR c.valid_from <= ?)
         AND (c.valid_to IS NULL OR c.valid_to > ?)
         AND ${NOT_DRAFT_SQL}
         AND c.vec IS NOT NULL`
    ),
    count: db.prepare("SELECT COUNT(*) AS n FROM copilot_chunks WHERE project_id = ?"),
    countAll: db.prepare("SELECT COUNT(*) AS n FROM copilot_chunks"),
    ready: db.prepare(
      "SELECT COUNT(*) AS n FROM copilot_project_files WHERE project_id = ? AND status = 'ready'"
    ),
    readyFiles: db.prepare(
      "SELECT id, name, kind, summary, profile, chunk_count FROM copilot_project_files WHERE project_id = ? AND status = 'ready' ORDER BY id"
    ),
    fts: db.prepare(
      `SELECT c.id AS id FROM copilot_chunks_fts f JOIN copilot_chunks c ON c.id = f.rowid
       WHERE copilot_chunks_fts MATCH ? AND c.project_id = ? ORDER BY bm25(copilot_chunks_fts) LIMIT ?`
    ),
    activeFts: db.prepare(
      `SELECT c.id AS id FROM copilot_chunks_fts f JOIN copilot_chunks c ON c.id = f.rowid
       WHERE copilot_chunks_fts MATCH ? AND c.project_id = ?
         AND (c.lifecycle_status IS NULL OR c.lifecycle_status = 'active')
         AND (c.valid_from IS NULL OR c.valid_from <= ?)
         AND (c.valid_to IS NULL OR c.valid_to > ?)
       ORDER BY bm25(copilot_chunks_fts) LIMIT ?`
    ),
    historicalFts: db.prepare(
      `SELECT c.id AS id FROM copilot_chunks_fts f JOIN copilot_chunks c ON c.id = f.rowid
       WHERE copilot_chunks_fts MATCH ? AND c.project_id = ?
         AND (c.valid_from IS NULL OR c.valid_from <= ?)
         AND (c.valid_to IS NULL OR c.valid_to > ?)
         AND ${NOT_DRAFT_SQL}
       ORDER BY bm25(copilot_chunks_fts) LIMIT ?`
    ),
    chunk: db.prepare(
      `SELECT c.id, c.file_id, c.ord, c.text, c.meta, c.embed, c.feature_id, c.version, c.lifecycle_status,
              c.valid_from, c.valid_to, f.name AS file
       FROM copilot_chunks c
       JOIN copilot_project_files f ON f.id = c.file_id WHERE c.id = ?`
    ),
    projectBytes: db.prepare(
      "SELECT COALESCE(SUM(bytes), 0) AS n FROM copilot_project_files WHERE project_id = ?"
    ),
    fileChunks: db.prepare("SELECT text, meta FROM copilot_chunks WHERE file_id = ? ORDER BY ord"),
    staleProfiles: db.prepare(
      "SELECT id, project_id, name, kind FROM copilot_project_files WHERE status = 'ready' AND (profile_v IS NULL OR profile_v < ?)"
    ),
    unindexed: db.prepare(
      "SELECT id, project_id, path, name FROM copilot_project_files WHERE status IS NULL OR status IN ('queued','reading','analysing','embedding')"
    ),
  };

  return {
    file: (id) => q.file.get(id) ?? null,
    setFile(id, patch) {
      const keys = Object.keys(patch).filter((k) => FILE_COLUMNS.some(([c]) => c === k));
      if (!keys.length) return;
      db.prepare(
        `UPDATE copilot_project_files SET ${keys.map((k) => `${k} = @${k}`).join(", ")} WHERE id = @id`
      ).run({ ...patch, id });
    },
    // Files that were mid-index when the app closed (or never indexed): to be started again.
    unfinished: () => q.unindexed.all(),
    projectBytes: (projectId) => q.projectBytes.get(projectId).n,
    chunkCount: (projectId) => q.count.get(projectId).n,
    totalChunks: () => q.countAll.get().n,
    hasIndex: (projectId) => q.ready.get(projectId).n > 0,

    // chunks: [{ text, meta, embed: "text"|"media", hash, vec: Float32Array|null }] replace the file's old ones in one step.
    replaceChunks(fileId, projectId, chunks, dims) {
      db.transaction(() => {
        for (const { id } of q.legacyIds.all(fileId)) q.delFts.run(id);
        q.delLegacyChunks.run(fileId);
        chunks.forEach((c, ord) => {
          const id = Number(
            q.insert.run(
              fileId,
              projectId,
              ord,
              c.text,
              JSON.stringify(c.meta ?? {}),
              c.embed ?? "text",
              c.hash ?? null,
              c.vec ? dims : null,
              c.vec ? toBuffer(c.vec) : null
            ).lastInsertRowid
          );
          q.insertFts.run(id, c.text);
        });
      })();
      invalidateMatrices(projectId);
    },
    // Every chunk of the file, versioned or not: a deleted file must leave no searchable text behind.
    deleteFileChunks(fileId, projectId) {
      db.transaction(() => {
        for (const { id } of q.ids.all(fileId)) q.delFts.run(id);
        q.delChunks.run(fileId);
      })();
      invalidateMatrices(projectId);
    },
    removeFile(fileId, projectId) {
      this.deleteFileChunks(fileId, projectId);
    },
    // hash -> Float32Array for chunks whose text was embedded before (an edited file re-embeds only what changed).
    cachedVectors(hashes, dims) {
      const out = new Map();
      if (!hashes.length) return out;
      for (const r of q.byHash.all(JSON.stringify(hashes), dims))
        out.set(r.hash, fromBuffer(r.vec));
      return out;
    },

    // Project vector matrix. Defaults to active-only chunks to prevent superseded leakage;
    // pass { includeInactive: true } for full audit/legacy scans or { asOfStart, asOfEnd } for point-in-time.
    matrix(projectId, dims, { includeInactive = false, asOfStart = null, asOfEnd = null } = {}) {
      if (asOfStart != null || asOfEnd != null) {
        const start = Number(asOfStart ?? asOfEnd);
        const end = Number(asOfEnd ?? asOfStart);
        const rows = q.historicalVectors.all(projectId, dims, end, start);
        const data = new Float32Array(rows.length * dims);
        rows.forEach((r, i) => data.set(fromBuffer(r.vec), i * dims));
        return { ids: rows.map((r) => r.id), data };
      }
      const mode = includeInactive ? "all" : "active";
      const key = `${projectId}:${dims}:${mode}`;
      const cached = matrices.get(key);
      // Time alone can start or retire a chunk, so an active matrix is only reusable until its next boundary.
      if (cached && !(cached.expiresAt != null && now() >= cached.expiresAt)) return cached;
      const at = now();
      const rows = includeInactive
        ? q.vectors.all(projectId, dims)
        : q.activeVectors.all(projectId, dims, at, at);
      const data = new Float32Array(rows.length * dims);
      rows.forEach((r, i) => data.set(fromBuffer(r.vec), i * dims));
      const m = { ids: rows.map((r) => r.id), data };
      if (!includeInactive)
        m.expiresAt = q.nextActiveBoundary.get(projectId, at, projectId, at).t ?? null;
      matrices.set(key, m);
      return m;
    },
    // Builds the active matrix if it is missing or expired, so the next search finds it ready.
    warm(projectId, dims) {
      this.matrix(projectId, dims);
    },
    keyword(
      projectId,
      text,
      k = 12,
      { includeInactive = false, asOfStart = null, asOfEnd = null } = {}
    ) {
      const query = ftsQuery(text);
      if (!query) return [];
      try {
        if (asOfStart != null || asOfEnd != null) {
          const start = Number(asOfStart ?? asOfEnd);
          const end = Number(asOfEnd ?? asOfStart);
          return q.historicalFts.all(query, projectId, end, start, k).map((r) => r.id);
        }
        return includeInactive
          ? q.fts.all(query, projectId, k).map((r) => r.id)
          : q.activeFts.all(query, projectId, now(), now(), k).map((r) => r.id);
      } catch {
        return []; // a syntax edge case must never break an answer
      }
    },
    vector(projectId, vec, k = 12, opts = {}) {
      const m = this.matrix(projectId, vec.length, opts);
      return m.ids.length ? topK(m, vec, k) : [];
    },
    // Cosine of the given chunks to a query vector (chunks a keyword search found outside the vector top k).
    // -> Map(id -> score); ids not in this project are left out.
    similarity(projectId, ids, vec, opts = {}) {
      const m = this.matrix(projectId, vec.length, opts);
      m.row ??= new Map(m.ids.map((id, r) => [id, r]));
      const out = new Map();
      for (const id of ids) {
        const r = m.row.get(id);
        if (r == null) continue;
        let s = 0;
        const o = r * vec.length;
        for (let i = 0; i < vec.length; i++) s += m.data[o + i] * vec[i];
        out.set(id, s);
      }
      return out;
    },
    chunk(id) {
      const r = q.chunk.get(id);
      return r ? { ...r, meta: JSON.parse(r.meta || "{}") } : null;
    },
    // One row per ready file: what it is (summary, and the profile parsed when there is one).
    catalog: (projectId) =>
      q.readyFiles.all(projectId).map((r) => {
        let profile = null;
        try {
          profile = r.profile ? JSON.parse(r.profile) : null;
        } catch (error) {
          log({ event: "corrupt_profile", file_id: r.id, error: error.message });
        }
        return { ...r, profile };
      }),
    // A file's chunks in order, for writing its profile again without reading the file again.
    fileChunks: (fileId) =>
      q.fileChunks.all(fileId).map((r) => ({ text: r.text, meta: JSON.parse(r.meta || "{}") })),
    // Ready files whose profile is missing or older than `version`.
    staleProfiles: (version) => q.staleProfiles.all(version),
    rrf,
    invalidateMatrices,

    // Phase 2: Temporal Store Engine Integration
    temporal,
    insertTemporalChunk: (chunkData, metadata) => temporal.insertTemporalChunk(chunkData, metadata),
    getActiveFeatureChunks: (projectId, featureId) =>
      temporal.getActiveFeatureChunks(projectId, featureId),
    getFeatureAt: (projectId, featureId, targetTime) =>
      temporal.getFeatureAt(projectId, featureId, targetTime),
    getFeatureInRange: (projectId, featureId, rangeStart, rangeEnd) =>
      temporal.getFeatureInRange(projectId, featureId, rangeStart, rangeEnd),
    getFeatureLineage: (projectId, featureId) => temporal.getFeatureLineage(projectId, featureId),
    supersedeChunk: (predecessorId, successorId, effectiveTime) =>
      temporal.supersedeChunk(predecessorId, successorId, effectiveTime),
    deprecateChunk: (chunkId, effectiveTime) => temporal.deprecateChunk(chunkId, effectiveTime),
    activateSuccessorVersion: (params) => temporal.activateSuccessorVersion(params),
    validateTemporalIntegrity: (projectId, featureId) =>
      temporal.validateTemporalIntegrity(projectId, featureId),

    // Active-only matrix and vector search
    activeMatrix(projectId, dims) {
      return this.matrix(projectId, dims, { includeInactive: false });
    },
    // Historical point-in-time matrix
    historicalMatrix(projectId, dims, targetTime, rangeEnd = null) {
      const start = Number(targetTime);
      const end = rangeEnd != null ? Number(rangeEnd) : start;
      return this.matrix(projectId, dims, { asOfStart: start, asOfEnd: end });
    },
    // Phase 3: Incremental Semantic Delta Ingestion
    createDeltaIngest(opts = {}) {
      return createDeltaIngest({
        db,
        ragStore: this,
        temporalStore: temporal,
        now,
        ...opts,
      });
    },
    // Phase 4: Authoritative Lookup Service
    createAuthoritativeLookup(opts = {}) {
      return createAuthoritativeLookup({
        db,
        ragStore: this,
        temporalStore: temporal,
        now,
        ...opts,
      });
    },
    // Phase 5: Temporal OKF Router Gate
    createTemporalRouter(opts = {}) {
      return createTemporalRouter({
        temporalStore: temporal,
        now,
        ...opts,
      });
    },
  };
}

module.exports = {
  createRagStore,
  createDeltaIngest,
  createAuthoritativeLookup,
  createTemporalRouter,
  ftsQuery,
  FILE_COLUMNS,
  CHUNK_TEMPORAL_COLUMNS,
  TEMPORAL_INDEXES,
};
