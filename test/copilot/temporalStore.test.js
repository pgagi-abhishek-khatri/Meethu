// test/copilot/temporalStore.test.js
// Automated test suite for Phase 2: Bi-Temporal Database Migration & Version-Aware Knowledge Storage

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let Database;
let canOpen = true;
try {
  Database = require("better-sqlite3");
  new Database(":memory:").close();
} catch {
  canOpen = false;
}

const sqlite = { skip: canOpen ? false : "better-sqlite3 is not built for this runtime (use ELECTRON_RUN_AS_NODE=1)" };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "copilot-temporal-"));

const { createRagStore } = require("../../src/copilot/rag/ragStore");
const {
  createTemporalStore,
  migrateTemporalSchema,
  CHUNK_TEMPORAL_COLUMNS,
  TEMPORAL_INDEXES,
  VALID_LIFECYCLE_STATUSES,
} = require("../../src/copilot/rag/temporalStore");
const { toBuffer, fromBuffer, normalize } = require("../../src/copilot/rag/vectors");
const { createOkfRegistry } = require("../../src/copilot/core/okf/registry");

const okfDir = path.resolve(__dirname, "../../OKF");

// Helper to create a dummy 4-dimensional normalized vector
function dummyVec(val = 1) {
  return normalize(Float32Array.from([val, 0.5, 0.25, 0.1]));
}

// ============================================================================
// 1. MIGRATION & SCHEMA INTEGRITY TESTS
// ============================================================================

test("M01: Fresh database creation initializes all 17 columns and 7 indexes", sqlite, () => {
  const db = new Database(":memory:");
  const rag = createRagStore(db);

  const columns = db
    .prepare("PRAGMA table_info(copilot_chunks)")
    .all()
    .map((c) => c.name);

  const expectedColumns = [
    "id",
    "file_id",
    "project_id",
    "ord",
    "text",
    "meta",
    "embed",
    "hash",
    "dims",
    "vec",
    "feature_id",
    "version",
    "lifecycle_status",
    "superseded_by_id",
    "transaction_time",
    "valid_from",
    "valid_to",
  ];

  assert.equal(columns.length, 17, `Expected 17 columns, found: ${columns.join(", ")}`);
  for (const exp of expectedColumns) {
    assert.ok(columns.includes(exp), `Column '${exp}' must exist in copilot_chunks`);
  }

  const indexes = db
    .prepare("PRAGMA index_list(copilot_chunks)")
    .all()
    .map((i) => i.name);

  assert.ok(indexes.includes("idx_copilot_chunks_feature_active"));
  assert.ok(indexes.includes("idx_copilot_chunks_temporal"));
  assert.ok(indexes.includes("idx_copilot_chunks_version"));
  assert.ok(indexes.includes("idx_copilot_chunks_superseded_by"));
  assert.ok(indexes.includes("copilot_chunks_file"));
  assert.ok(indexes.includes("copilot_chunks_project"));
  assert.ok(indexes.includes("copilot_chunks_hash"));

  db.close();
});

test("M02: Existing legacy database migration preserves records, vectors, and FTS5 data", sqlite, () => {
  const db = new Database(":memory:");

  // 1. Construct old legacy schema (exact 10 columns from before Phase 2)
  db.exec(`
    CREATE TABLE copilot_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER NOT NULL, project_id INTEGER NOT NULL, ord INTEGER NOT NULL,
      text TEXT NOT NULL, meta TEXT, embed TEXT, hash TEXT, dims INTEGER, vec BLOB
    );
    CREATE INDEX copilot_chunks_file ON copilot_chunks(file_id);
    CREATE INDEX copilot_chunks_project ON copilot_chunks(project_id);
    CREATE INDEX copilot_chunks_hash ON copilot_chunks(hash);
    CREATE VIRTUAL TABLE copilot_chunks_fts USING fts5(text, tokenize = 'unicode61 remove_diacritics 2');
    CREATE TABLE copilot_project_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL, added_at INTEGER
    );
  `);

  // 2. Pre-populate with legacy records and embeddings
  const originalVec = dummyVec(2.5);
  const insertLegacy = db.prepare(
    "INSERT INTO copilot_chunks (file_id, project_id, ord, text, meta, embed, hash, dims, vec) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const insertFts = db.prepare("INSERT INTO copilot_chunks_fts (rowid, text) VALUES (?, ?)");

  const legacyRowId = Number(
    insertLegacy.run(1, 42, 0, "Legacy single pipeline architecture specification text", JSON.stringify({ page: 1 }), "text", "hash-101", 4, toBuffer(originalVec)).lastInsertRowid
  );
  insertFts.run(legacyRowId, "Legacy single pipeline architecture specification text");

  // Verify before migration
  const beforeCols = db.prepare("PRAGMA table_info(copilot_chunks)").all().map((c) => c.name);
  assert.equal(beforeCols.length, 10);

  // 3. Run migration via createRagStore
  const rag = createRagStore(db);

  // 4. Verify post-migration state
  const afterCols = db.prepare("PRAGMA table_info(copilot_chunks)").all().map((c) => c.name);
  assert.equal(afterCols.length, 17);

  // Verify legacy record is intact and has default active lifecycle status
  const row = db.prepare("SELECT * FROM copilot_chunks WHERE id = ?").get(legacyRowId);
  assert.equal(row.text, "Legacy single pipeline architecture specification text");
  assert.equal(row.file_id, 1);
  assert.equal(row.project_id, 42);
  assert.equal(row.dims, 4);
  assert.equal(row.lifecycle_status, "active", "Legacy chunks must default to active lifecycle_status");
  assert.equal(row.feature_id, null, "Legacy chunks must have NULL feature_id");
  assert.equal(row.version, null, "Legacy chunks must have NULL version");
  assert.equal(row.superseded_by_id, null);

  // Verify vector embedding is bit-for-bit preserved
  const restoredVec = fromBuffer(row.vec);
  assert.equal(restoredVec.length, 4);
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(restoredVec[i] - originalVec[i]) < 1e-6, `Vector element ${i} mismatch`);
  }

  // Verify FTS5 search still finds the legacy record
  const ftsHits = rag.keyword(42, "pipeline architecture");
  assert.ok(ftsHits.includes(legacyRowId), "FTS5 search must continue to find legacy records post-migration");

  db.close();
});

test("M03: Repeated migration is strictly idempotent", sqlite, () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE copilot_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER NOT NULL, project_id INTEGER NOT NULL, ord INTEGER NOT NULL,
      text TEXT NOT NULL, meta TEXT, embed TEXT, hash TEXT, dims INTEGER, vec BLOB
    );
  `);

  // Run migration 5 times sequentially
  for (let i = 0; i < 5; i++) {
    const res = migrateTemporalSchema(db);
    if (i === 0) {
      assert.equal(res.migrated, true);
      assert.equal(res.addedColumns.length, 7);
    } else {
      assert.equal(res.migrated, false);
      assert.equal(res.addedColumns.length, 0);
    }
  }

  const cols = db.prepare("PRAGMA table_info(copilot_chunks)").all();
  assert.equal(cols.length, 17);

  db.close();
});

test("M04: Partially migrated database completes missing columns safely", sqlite, () => {
  const db = new Database(":memory:");
  // Simulate a partially migrated table that only got 2 of the 7 new columns
  db.exec(`
    CREATE TABLE copilot_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER NOT NULL, project_id INTEGER NOT NULL, ord INTEGER NOT NULL,
      text TEXT NOT NULL, meta TEXT, embed TEXT, hash TEXT, dims INTEGER, vec BLOB,
      feature_id TEXT, version TEXT
    );
  `);

  const res = migrateTemporalSchema(db);
  assert.equal(res.migrated, true);
  assert.equal(res.addedColumns.length, 5); // Added the remaining 5 columns

  const cols = db.prepare("PRAGMA table_info(copilot_chunks)").all().map((c) => c.name);
  assert.equal(cols.length, 17);
  assert.ok(cols.includes("lifecycle_status"));
  assert.ok(cols.includes("valid_from"));
  assert.ok(cols.includes("valid_to"));

  db.close();
});

// ============================================================================
// 2. TEMPORAL INSERTION & VALIDATION TESTS
// ============================================================================

test("T01: Insert temporal chunk with feature identity and SemVer", sqlite, () => {
  const db = new Database(":memory:");
  const rag = createRagStore(db);
  const temporal = rag.temporal;

  const inserted = temporal.insertTemporalChunk({
    file_id: 1,
    project_id: 10,
    ord: 0,
    text: "Distributed 4-pipeline streaming ingestion specification",
    meta: { section: "Ingestion Architecture", page: 4 },
    feature_id: "feat:ingestion_pipeline",
    version: "2.0.0",
    lifecycle_status: "active",
    valid_from: 1700000000000,
    valid_to: null,
  });

  assert.ok(inserted.id > 0);
  assert.equal(inserted.feature_id, "feat:ingestion_pipeline");
  assert.equal(inserted.version, "2.0.0");
  assert.equal(inserted.lifecycle_status, "active");
  assert.equal(inserted.valid_from, 1700000000000);
  assert.equal(inserted.valid_to, null);

  // Retrieve active
  const active = temporal.getActiveFeatureChunks(10, "feat:ingestion_pipeline");
  assert.equal(active.length, 1);
  assert.equal(active[0].id, inserted.id);
  assert.equal(active[0].version, "2.0.0");
  assert.equal(active[0].text, "Distributed 4-pipeline streaming ingestion specification");

  db.close();
});

test("T02: Legacy chunk insertion with NULL feature metadata works seamlessly", sqlite, () => {
  const db = new Database(":memory:");
  const rag = createRagStore(db);
  const temporal = rag.temporal;

  const legacy = temporal.insertTemporalChunk({
    file_id: 2,
    project_id: 10,
    ord: 0,
    text: "General meeting notes without canonical feature link",
    feature_id: null,
    version: null,
  });

  assert.ok(legacy.id > 0);
  assert.equal(legacy.feature_id, null);
  assert.equal(legacy.version, null);
  assert.equal(legacy.lifecycle_status, "active");

  db.close();
});

test("T03: Rejection of invalid lifecycle status", sqlite, () => {
  const db = new Database(":memory:");
  const rag = createRagStore(db);
  const temporal = rag.temporal;

  assert.throws(
    () => {
      temporal.insertTemporalChunk({
        file_id: 1,
        project_id: 10,
        text: "Test",
        lifecycle_status: "invalid_status_xyz",
      });
    },
    /Invalid lifecycle_status 'invalid_status_xyz'/
  );

  db.close();
});

test("T04: Rejection of invalid temporal interval (valid_to <= valid_from)", sqlite, () => {
  const db = new Database(":memory:");
  const rag = createRagStore(db);
  const temporal = rag.temporal;

  assert.throws(
    () => {
      temporal.insertTemporalChunk({
        file_id: 1,
        project_id: 10,
        text: "Test",
        valid_from: 2000,
        valid_to: 1000, // Inverted!
      });
    },
    /valid_to \(1000\) must be strictly greater than valid_from \(2000\)/
  );

  assert.throws(
    () => {
      temporal.insertTemporalChunk({
        file_id: 1,
        project_id: 10,
        text: "Test",
        valid_from: 2000,
        valid_to: 2000, // Equal is also invalid
      });
    },
    /valid_to \(2000\) must be strictly greater than valid_from \(2000\)/
  );

  db.close();
});

// ============================================================================
// 3. SUPERSESSION & LINEAGE INTEGRITY TESTS
// ============================================================================

test("T05: Successful chunk supersession updates predecessor lifecycle and interval", sqlite, () => {
  const db = new Database(":memory:");
  const rag = createRagStore(db);
  const temporal = rag.temporal;

  // 1. Insert predecessor (v1)
  const v1 = temporal.insertTemporalChunk({
    file_id: 1,
    project_id: 5,
    text: "Single pipeline architecture",
    feature_id: "feat:ingestion_pipeline",
    version: "1.0.0",
    lifecycle_status: "active",
    valid_from: 1000,
  });

  // 2. Insert successor (v2)
  const v2 = temporal.insertTemporalChunk({
    file_id: 2,
    project_id: 5,
    text: "4 parallel distributed pipelines",
    feature_id: "feat:ingestion_pipeline",
    version: "2.0.0",
    lifecycle_status: "active",
    valid_from: 2000,
  });

  // 3. Supersede v1 with v2
  const res = temporal.supersedeChunk(v1.id, v2.id, 2000);
  assert.equal(res.predecessor_id, v1.id);
  assert.equal(res.successor_id, v2.id);
  assert.equal(res.valid_to, 2000);
  assert.equal(res.lifecycle_status, "superseded");

  // Check database row for v1
  const v1Row = db.prepare("SELECT * FROM copilot_chunks WHERE id = ?").get(v1.id);
  assert.equal(v1Row.lifecycle_status, "superseded");
  assert.equal(v1Row.superseded_by_id, v2.id);
  assert.equal(v1Row.valid_to, 2000);

  // Check active feature chunks (only v2 is active!)
  const activeChunks = temporal.getActiveFeatureChunks(5, "feat:ingestion_pipeline");
  assert.equal(activeChunks.length, 1);
  assert.equal(activeChunks[0].id, v2.id);
  assert.equal(activeChunks[0].version, "2.0.0");

  db.close();
});

test("T06: Rejection of self-supersession and non-existent chunks", sqlite, () => {
  const db = new Database(":memory:");
  const rag = createRagStore(db);
  const temporal = rag.temporal;

  const c1 = temporal.insertTemporalChunk({
    file_id: 1,
    project_id: 5,
    text: "Specification",
    feature_id: "feat:spec",
    version: "1.0.0",
    valid_from: 1000,
  });

  // Self-supersession
  assert.throws(
    () => {
      temporal.supersedeChunk(c1.id, c1.id, 2000);
    },
    /Self-supersession is forbidden/
  );

  // Non-existent successor
  assert.throws(
    () => {
      temporal.supersedeChunk(c1.id, 999999, 2000);
    },
    /Successor chunk #999999 does not exist/
  );

  // Non-existent predecessor
  assert.throws(
    () => {
      temporal.supersedeChunk(999999, c1.id, 2000);
    },
    /Predecessor chunk #999999 does not exist/
  );

  db.close();
});

test("T07: Feature ID mismatch rejection in supersession", sqlite, () => {
  const db = new Database(":memory:");
  const rag = createRagStore(db);
  const temporal = rag.temporal;

  const c1 = temporal.insertTemporalChunk({
    file_id: 1,
    project_id: 5,
    text: "Pipeline spec",
    feature_id: "feat:ingestion_pipeline",
    version: "1.0.0",
    valid_from: 1000,
  });

  const c2 = temporal.insertTemporalChunk({
    file_id: 2,
    project_id: 5,
    text: "Auth spec",
    feature_id: "feat:auth_sso",
    version: "1.0.0",
    valid_from: 2000,
  });

  assert.throws(
    () => {
      temporal.supersedeChunk(c1.id, c2.id, 2000);
    },
    /Feature ID mismatch/
  );

  db.close();
});

test("T08: Circular supersession detection", sqlite, () => {
  const db = new Database(":memory:");
  const rag = createRagStore(db);
  const temporal = rag.temporal;

  const c1 = temporal.insertTemporalChunk({
    file_id: 1,
    project_id: 5,
    text: "V1",
    feature_id: "feat:pipeline",
    version: "1.0.0",
    valid_from: 1000,
  });

  const c2 = temporal.insertTemporalChunk({
    file_id: 1,
    project_id: 5,
    text: "V2",
    feature_id: "feat:pipeline",
    version: "2.0.0",
    valid_from: 2000,
  });

  temporal.supersedeChunk(c1.id, c2.id, 2000);

  // Attempting to have c2 superseded by c1 creates a cycle: c1 -> c2 -> c1
  assert.throws(
    () => {
      temporal.supersedeChunk(c2.id, c1.id, 3000);
    },
    /Circular supersession detected/
  );

  db.close();
});

test("T09: Transactional version activation is atomic with rollback on error", sqlite, () => {
  const db = new Database(":memory:");
  const rag = createRagStore(db);
  const temporal = rag.temporal;

  const v1 = temporal.insertTemporalChunk({
    file_id: 1,
    project_id: 5,
    text: "Initial spec",
    feature_id: "feat:pipeline",
    version: "1.0.0",
    valid_from: 1000,
  });

  // Successful atomic activation
  const activation = temporal.activateSuccessorVersion({
    predecessorId: v1.id,
    newChunkData: {
      text: "Upgraded spec v2",
      version: "2.0.0",
    },
    effectiveTime: 2000,
  });

  assert.ok(activation.successor.id > 0);
  assert.equal(activation.successor.version, "2.0.0");
  assert.equal(activation.successor.lifecycle_status, "active");

  const v1After = db.prepare("SELECT * FROM copilot_chunks WHERE id = ?").get(v1.id);
  assert.equal(v1After.lifecycle_status, "superseded");
  assert.equal(v1After.superseded_by_id, activation.successor.id);
  assert.equal(v1After.valid_to, 2000);

  // Failed activation rolls back (e.g. invalid lifecycle status in new data)
  assert.throws(
    () => {
      temporal.activateSuccessorVersion({
        predecessorId: activation.successor.id,
        newChunkData: {
          text: "Broken v3",
          version: "3.0.0",
          lifecycle_status: "illegal_status_trigger_rollback",
        },
        effectiveTime: 3000,
      });
    },
    /Invalid lifecycle_status/
  );

  // Verify that activation.successor remains untouched (still active, valid_to is still null)
  const v2AfterRollback = db.prepare("SELECT * FROM copilot_chunks WHERE id = ?").get(activation.successor.id);
  assert.equal(v2AfterRollback.lifecycle_status, "active");
  assert.equal(v2AfterRollback.valid_to, null);
  assert.equal(v2AfterRollback.superseded_by_id, null);

  db.close();
});

// ============================================================================
// 4. HISTORICAL POINT-IN-TIME RETRIEVAL TESTS
// ============================================================================

test("T10: Historical point-in-time retrieval across version intervals", sqlite, () => {
  const db = new Database(":memory:");
  const rag = createRagStore(db);
  const temporal = rag.temporal;

  // v1 is valid in [1000, 2000)
  const v1 = temporal.insertTemporalChunk({
    file_id: 1,
    project_id: 100,
    text: "Version 1: 1 single synchronous data ingestion pipeline handling 50 req/sec",
    feature_id: "feat:ingestion_pipeline",
    version: "1.0.0",
    lifecycle_status: "superseded",
    valid_from: 1000,
    valid_to: 2000,
  });

  // v2 is valid in [2000, null) (currently active)
  const v2 = temporal.insertTemporalChunk({
    file_id: 2,
    project_id: 100,
    text: "Version 2: 4 parallel streaming pipelines handling 2,000 req/sec",
    feature_id: "feat:ingestion_pipeline",
    version: "2.0.0",
    lifecycle_status: "active",
    valid_from: 2000,
    valid_to: null,
  });

  // 1. Query at targetTime = 1500 (Falls strictly inside v1)
  const at1500 = temporal.getFeatureAt(100, "feat:ingestion_pipeline", 1500);
  assert.equal(at1500.length, 1);
  assert.equal(at1500[0].id, v1.id);
  assert.equal(at1500[0].version, "1.0.0");
  assert.ok(at1500[0].text.includes("Version 1: 1 single synchronous"));

  // 2. Query at targetTime = 2000 (Exact boundary transition -> returns v2)
  const at2000 = temporal.getFeatureAt(100, "feat:ingestion_pipeline", 2000);
  assert.equal(at2000.length, 1);
  assert.equal(at2000[0].id, v2.id);
  assert.equal(at2000[0].version, "2.0.0");
  assert.ok(at2000[0].text.includes("Version 2: 4 parallel"));

  // 3. Query at targetTime = 2500 (Current / future time -> returns v2)
  const at2500 = temporal.getFeatureAt(100, "feat:ingestion_pipeline", 2500);
  assert.equal(at2500.length, 1);
  assert.equal(at2500[0].id, v2.id);
  assert.equal(at2500[0].version, "2.0.0");

  // 4. Query before v1 existed (targetTime = 500) -> returns empty
  const at500 = temporal.getFeatureAt(100, "feat:ingestion_pipeline", 500);
  assert.equal(at500.length, 0);

  db.close();
});

test("T11: Feature version lineage retrieval ordered chronologically", sqlite, () => {
  const db = new Database(":memory:");
  const rag = createRagStore(db);
  const temporal = rag.temporal;

  temporal.insertTemporalChunk({
    file_id: 1,
    project_id: 200,
    text: "v1 chunk",
    feature_id: "feat:auth",
    version: "1.0.0",
    valid_from: 1000,
    valid_to: 2000,
  });

  temporal.insertTemporalChunk({
    file_id: 2,
    project_id: 200,
    text: "v2 chunk",
    feature_id: "feat:auth",
    version: "2.0.0",
    valid_from: 2000,
    valid_to: 3000,
  });

  temporal.insertTemporalChunk({
    file_id: 3,
    project_id: 200,
    text: "v3 chunk",
    feature_id: "feat:auth",
    version: "3.0.0",
    valid_from: 3000,
    valid_to: null,
  });

  const lineage = temporal.getFeatureLineage(200, "feat:auth");
  assert.equal(lineage.length, 3);
  assert.equal(lineage[0].version, "1.0.0");
  assert.equal(lineage[1].version, "2.0.0");
  assert.equal(lineage[2].version, "3.0.0");

  db.close();
});

// ============================================================================
// 5. TEMPORAL INTEGRITY VALIDATOR TESTS
// ============================================================================

test("T12: Temporal integrity validation detects broken pointers and invalid intervals", sqlite, () => {
  const db = new Database(":memory:");
  const rag = createRagStore(db);
  const temporal = rag.temporal;

  // Insert valid chunk
  const c1 = temporal.insertTemporalChunk({
    file_id: 1,
    project_id: 300,
    text: "Good chunk",
    feature_id: "feat:check",
    version: "1.0.0",
    valid_from: 1000,
  });

  const check1 = temporal.validateTemporalIntegrity(300, "feat:check");
  assert.equal(check1.valid, true);
  assert.equal(check1.errors.length, 0);

  // Directly corrupt database row to simulate dangling pointer
  db.prepare("UPDATE copilot_chunks SET superseded_by_id = 999999 WHERE id = ?").run(c1.id);
  const check2 = temporal.validateTemporalIntegrity(300, "feat:check");
  assert.equal(check2.valid, false);
  assert.ok(check2.errors.some((e) => e.includes("references non-existent successor chunk #999999")));

  // Corrupt interval
  db.prepare("UPDATE copilot_chunks SET valid_to = 500 WHERE id = ?").run(c1.id);
  const check3 = temporal.validateTemporalIntegrity(300, "feat:check");
  assert.equal(check3.valid, false);
  assert.ok(check3.errors.some((e) => e.includes("invalid interval: valid_to (500) <= valid_from (1000)")));

  db.close();
});

// ============================================================================
// 6. BACKWARD COMPATIBILITY & RAG INTEGRATION
// ============================================================================

test("T13: Existing replaceChunks and removeFile operations continue functioning flawlessly", sqlite, () => {
  const db = new Database(":memory:");
  const rag = createRagStore(db);

  const vec1 = dummyVec(1.0);
  const vec2 = dummyVec(2.0);

  // Ingest via existing replaceChunks method
  rag.replaceChunks(
    10,
    1,
    [
      { text: "First passage in file", meta: { page: 1 }, vec: vec1, hash: "h1" },
      { text: "Second passage in file", meta: { page: 2 }, vec: vec2, hash: "h2" },
    ],
    4
  );

  assert.equal(rag.chunkCount(1), 2);
  assert.equal(rag.totalChunks(), 2);

  // Vector similarity on project matrix
  const mat = rag.matrix(1, 4);
  assert.equal(mat.ids.length, 2);

  const topHits = rag.vector(1, vec1, 2);
  assert.equal(topHits.length, 2);
  assert.equal(topHits[0].id, mat.ids[0]);

  // FTS search
  const ftsHits = rag.keyword(1, "passage");
  assert.equal(ftsHits.length, 2);

  // Remove file
  rag.removeFile(10, 1);
  assert.equal(rag.chunkCount(1), 0);
  assert.equal(rag.totalChunks(), 0);

  db.close();
});

// ============================================================================
// DRAFT EXCLUSION IN HISTORICAL READS
// ============================================================================

test("getFeatureAt excludes draft chunks", sqlite, () => {
  const db = new Database(":memory:");
  const rag = createRagStore(db);
  const temporal = rag.temporal;
  temporal.insertTemporalChunk({
    file_id: 1, project_id: 7, text: "unapproved draft", feature_id: "feat:x", version: "1.0.0",
    lifecycle_status: "draft", valid_from: 100, valid_to: null,
  });
  assert.deepEqual(temporal.getFeatureAt(7, "feat:x", 200), []);
  assert.deepEqual(temporal.getFeatureInRange(7, "feat:x", 100, 300), []);
  db.close();
});

test("getFeatureAt at valid_to returns only successor", sqlite, () => {
  const db = new Database(":memory:");
  const temporal = createRagStore(db).temporal;
  temporal.insertTemporalChunk({
    file_id: 1, project_id: 7, text: "old", feature_id: "feat:x", version: "1.0.0",
    lifecycle_status: "superseded", valid_from: 100, valid_to: 150,
  });
  const next = temporal.insertTemporalChunk({
    file_id: 2, project_id: 7, text: "new", feature_id: "feat:x", version: "2.0.0",
    lifecycle_status: "active", valid_from: 150, valid_to: null,
  });
  const at = temporal.getFeatureAt(7, "feat:x", 150);
  assert.deepEqual(at.map((c) => c.id), [next.id]);
  db.close();
});

test("getFeatureAt still returns superseded chunk inside its window", sqlite, () => {
  const db = new Database(":memory:");
  const temporal = createRagStore(db).temporal;
  const old = temporal.insertTemporalChunk({
    file_id: 1, project_id: 7, text: "old", feature_id: "feat:x", version: "1.0.0",
    lifecycle_status: "superseded", valid_from: 100, valid_to: 150,
  });
  assert.deepEqual(temporal.getFeatureAt(7, "feat:x", 120).map((c) => c.id), [old.id]);
  assert.deepEqual(temporal.getFeatureAt(7, "feat:x", 150), []);
  db.close();
});

test("historical keyword/vector search excludes drafts", sqlite, () => {
  const db = new Database(":memory:");
  const rag = createRagStore(db);
  const temporal = rag.temporal;
  const vec = dummyVec(1);
  const draft = temporal.insertTemporalChunk({
    file_id: 1, project_id: 7, text: "zebra pricing draft", vec, feature_id: "feat:x", version: "1.0.0",
    lifecycle_status: "draft", valid_from: 100, valid_to: null,
  });
  const dep = temporal.insertTemporalChunk({
    file_id: 1, project_id: 7, ord: 1, text: "zebra pricing deprecated", vec, feature_id: "feat:y", version: "1.0.0",
    lifecycle_status: "deprecated", valid_from: 100, valid_to: 400,
  });
  const opts = { asOfStart: 200, asOfEnd: 200 };
  const kw = rag.keyword(7, "zebra", 12, opts);
  assert.deepEqual(kw, [dep.id]);
  assert.ok(!kw.includes(draft.id));
  const m = rag.matrix(7, vec.length, opts);
  assert.deepEqual(m.ids, [dep.id]);
  db.close();
});

// ============================================================================
// Time-aware "active": the clock alone must start or retire a chunk
// ============================================================================

function clockedRag() {
  const db = new Database(":memory:");
  const clock = { t: 1000 };
  const rag = createRagStore(db, { now: () => clock.t });
  return { db, rag, clock };
}
const ins = (rag, over) =>
  rag.temporal.insertTemporalChunk({
    file_id: 1, project_id: 7, ord: 0, text: "quokka pricing", vec: dummyVec(1),
    feature_id: "feat:q", version: "1.0.0", lifecycle_status: "active", ...over,
  });

test("future-dated active chunk is not searchable before valid_from", sqlite, () => {
  const { db, rag } = clockedRag();
  const c = ins(rag, { valid_from: 2000, valid_to: null });
  assert.deepEqual(rag.matrix(7, 4).ids, []);
  assert.deepEqual(rag.keyword(7, "quokka"), []);
  assert.equal(c.lifecycle_status, "active");
  db.close();
});

test("becomes searchable once clock passes valid_from without any write", sqlite, () => {
  const { db, rag, clock } = clockedRag();
  const c = ins(rag, { valid_from: 2000, valid_to: null });
  assert.deepEqual(rag.matrix(7, 4).ids, []); // cached with expiresAt = 2000
  clock.t = 2000;
  assert.deepEqual(rag.matrix(7, 4).ids, [c.id]);
  assert.deepEqual(rag.keyword(7, "quokka"), [c.id]);
  db.close();
});

test("chunk with elapsed valid_to leaves active matrix without a write", sqlite, () => {
  const { db, rag, clock } = clockedRag();
  const c = ins(rag, { valid_from: 500, valid_to: 3000 });
  assert.deepEqual(rag.matrix(7, 4).ids, [c.id]);
  clock.t = 3000; // valid_to is exclusive
  assert.deepEqual(rag.matrix(7, 4).ids, []);
  assert.deepEqual(rag.keyword(7, "quokka"), []);
  db.close();
});

test("getActiveFeatureChunks and keyword search agree on a future-dated chunk", sqlite, () => {
  const { db, rag, clock } = clockedRag();
  ins(rag, { valid_from: 2000, valid_to: null });
  assert.deepEqual(rag.temporal.getActiveFeatureChunks(7, "feat:q"), []);
  assert.deepEqual(rag.keyword(7, "quokka"), []);
  assert.equal(rag.temporal.countActiveFeatureChunks(7, "feat:q"), 0);
  clock.t = 2500;
  assert.equal(rag.temporal.getActiveFeatureChunks(7, "feat:q").length, 1);
  assert.equal(rag.keyword(7, "quokka").length, 1);
  assert.equal(rag.temporal.countActiveFeatureChunks(7, "feat:q"), 1);
  db.close();
});

// ============================================================================
// Task 4: lifecycle guards in supersession
// ============================================================================

test("supersedeChunk rejects an already-superseded predecessor and leaves valid_to unchanged", sqlite, () => {
  const db = new Database(":memory:");
  const temporal = createRagStore(db).temporal;
  const a = temporal.insertTemporalChunk({ file_id: 1, project_id: 1, text: "a", feature_id: "f", valid_from: 1000 });
  const b = temporal.insertTemporalChunk({ file_id: 1, project_id: 1, text: "b", feature_id: "f", valid_from: 2000 });
  const c = temporal.insertTemporalChunk({ file_id: 1, project_id: 1, text: "c", feature_id: "f", valid_from: 3000 });
  temporal.supersedeChunk(a.id, b.id, 2000);

  assert.throws(
    () => temporal.supersedeChunk(a.id, c.id, 3000),
    new RegExp(`Predecessor chunk #${a.id} is not active \\(status=superseded\\)`)
  );
  const row = db.prepare("SELECT valid_to, superseded_by_id FROM copilot_chunks WHERE id = ?").get(a.id);
  assert.equal(row.valid_to, 2000);
  assert.equal(row.superseded_by_id, b.id);
  db.close();
});

test("activateSuccessorVersion honours effectiveTime when newChunkData.valid_from is undefined", sqlite, () => {
  const db = new Database(":memory:");
  const temporal = createRagStore(db).temporal;
  const a = temporal.insertTemporalChunk({ file_id: 1, project_id: 1, text: "a", feature_id: "f", valid_from: 1000 });
  const res = temporal.activateSuccessorVersion({
    predecessorId: a.id,
    newChunkData: { text: "b", valid_from: undefined },
    effectiveTime: 5000,
  });
  assert.equal(res.successor.valid_from, 5000);
  db.close();
});

test("onMutate is called once after activateSuccessorVersion commits and not at all when it rolls back", sqlite, () => {
  const db = new Database(":memory:");
  const calls = [];
  createRagStore(db);
  const temporal = createTemporalStore(db, {
    onMutate: (p) => calls.push({ p, inTx: db.inTransaction }),
  });
  const a = temporal.insertTemporalChunk({ file_id: 1, project_id: 7, text: "a", feature_id: "f", valid_from: 1000 });
  calls.length = 0;

  temporal.activateSuccessorVersion({ predecessorId: a.id, newChunkData: { text: "b" }, effectiveTime: 2000 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].p, 7);
  assert.equal(calls[0].inTx, false);

  // Fail AFTER the successor insert queued a notification: the predecessor is already superseded,
  // so the non-active guard throws at the primary supersede step.
  // A different project from the later success, so a leaked queue entry shows up as an extra call.
  const o1 = temporal.insertTemporalChunk({ file_id: 2, project_id: 8, text: "x", feature_id: "g", valid_from: 1000 });
  const o2 = temporal.insertTemporalChunk({ file_id: 2, project_id: 8, text: "y", feature_id: "g", valid_from: 2000 });
  temporal.supersedeChunk(o1.id, o2.id, 2000);
  const sup = { id: o1.id };
  const before = db.prepare("SELECT * FROM copilot_chunks ORDER BY id").all();
  calls.length = 0;
  assert.throws(
    () =>
      temporal.activateSuccessorVersion({
        predecessorId: sup.id,
        newChunkData: { text: "c" },
        effectiveTime: 3000,
      }),
    /is not active/
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(db.prepare("SELECT * FROM copilot_chunks ORDER BY id").all(), before);

  // Leaked deferral state would swallow or duplicate this notification.
  const live = db.prepare("SELECT id FROM copilot_chunks WHERE lifecycle_status='active' AND project_id = 7").get();
  calls.length = 0;
  temporal.activateSuccessorVersion({ predecessorId: live.id, newChunkData: { text: "d" }, effectiveTime: 4000 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].p, 7);
  db.close();
});

// ============================================================================
// Unregistered feature ids are surfaced, not rejected
// ============================================================================

function chunkFor(featureId, ord) {
  return {
    file_id: 1,
    project_id: 10,
    ord,
    text: `chunk ${ord}`,
    feature_id: featureId,
    version: "1.0.0",
    lifecycle_status: "active",
    valid_from: 1700000000000,
    valid_to: null,
  };
}

test("inserting an unregistered feature_id logs unregistered_feature and still inserts", sqlite, () => {
  const db = new Database(":memory:");
  createRagStore(db);
  const records = [];
  const temporal = createTemporalStore(db, {
    featureRegistry: { getFeatureById: () => null },
    log: (r) => records.push(r),
  });

  const row = temporal.insertTemporalChunk(chunkFor("feat:dynamic", 0));
  assert.ok(row.id > 0, "the chunk is still inserted");
  assert.deepEqual(records, [{ event: "unregistered_feature", feature_id: "feat:dynamic" }]);

  temporal.insertTemporalChunk(chunkFor("feat:dynamic", 1));
  assert.equal(records.length, 1, "logged once per feature id, not per chunk");
  db.close();
});

test("inserting a registered feature_id does not log", sqlite, () => {
  const db = new Database(":memory:");
  createRagStore(db);
  const records = [];
  const temporal = createTemporalStore(db, {
    featureRegistry: { getFeatureById: (id) => ({ id }) },
    log: (r) => records.push(r),
  });
  temporal.insertTemporalChunk(chunkFor("feat:known", 0));
  assert.deepEqual(records, []);
  db.close();
});
