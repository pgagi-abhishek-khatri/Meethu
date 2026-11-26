// Phase 2.6: the authoritative-lookup cache ignores spacing/end-punctuation noise and evicts least recently used.
// ELECTRON_RUN_AS_NODE=1 npx electron --test test/copilot/alsCache.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

let Database = null;
try {
  Database = require("better-sqlite3");
  new Database(":memory:").close();
} catch {
  Database = null;
}
const sqlite = { skip: Database ? false : "better-sqlite3 is not built for this runtime" };

function setup({ maxCacheSize } = {}) {
  const { createRagStore } = require("../../src/copilot/rag/ragStore");
  const { createFeatureRegistry } = require("../../src/copilot/core/okf/featureRegistry");
  const { createAuthoritativeLookup } = require("../../src/copilot/rag/authoritativeLookup");
  const db = new Database(":memory:");
  const ragStore = createRagStore(db);
  const featureRegistry = createFeatureRegistry({ okfDir: path.resolve(__dirname, "../../OKF") });
  featureRegistry.load();
  ragStore.temporal.insertTemporalChunk({
    file_id: 1,
    project_id: "p",
    feature_id: "feat:ingestion_pipeline",
    version: "2.0.0",
    lifecycle_status: "active",
    text: "The pipeline handles 2,000 req/sec.",
    meta: { source: "spec.pdf" },
    valid_from: 1000,
  });
  return createAuthoritativeLookup({
    db,
    ragStore,
    temporalStore: ragStore.temporal,
    featureRegistry,
    ...(maxCacheSize ? { maxCacheSize } : {}),
  });
}

test("spacing and trailing punctuation reuse the cached lookup", sqlite, async () => {
  const als = setup();
  const a = await als.lookup({ projectId: "p", query: "what is feat:ingestion_pipeline" });
  const b = await als.lookup({ projectId: "p", query: "  what is   feat:ingestion_pipeline?  " });
  assert.equal(b, a, "the same cached result object");
});

test("a different case is not assumed to mean the same thing", sqlite, async () => {
  const als = setup();
  const a = await als.lookup({ projectId: "p", query: "what is feat:ingestion_pipeline" });
  const b = await als.lookup({ projectId: "p", query: "WHAT IS feat:ingestion_pipeline" });
  assert.notEqual(b, a);
});

test("least recently used goes first when the cache is full", sqlite, async () => {
  const als = setup({ maxCacheSize: 2 });
  const q = (s) => ({ projectId: "p", query: `${s} feat:ingestion_pipeline` });
  const a = await als.lookup(q("alpha"));
  await als.lookup(q("beta"));
  assert.equal(await als.lookup(q("alpha")), a); // touch alpha
  await als.lookup(q("gamma")); // evicts beta
  assert.equal(await als.lookup(q("alpha")), a, "alpha survived");
});
