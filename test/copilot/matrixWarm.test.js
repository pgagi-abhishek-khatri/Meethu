// Phase 2.5: the vector matrix is rebuilt while the decider thinks (prefetch), not when the answer needs it.
// ELECTRON_RUN_AS_NODE=1 npx electron --test test/copilot/matrixWarm.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openStore } = require("../../src/copilot/main/store");
const { createRetriever } = require("../../src/copilot/rag/retrieve");
const { RAG } = require("../../src/copilot/rag/config");

let canOpen = true;
try {
  const D = require("better-sqlite3");
  new D(":memory:").close();
} catch {
  canOpen = false;
}
const sqlite = { skip: canOpen ? false : "better-sqlite3 is not built for this runtime" };

test("prefetch asks the store to warm each indexed project's matrix", () => {
  const warmed = [];
  const rag = {
    hasIndex: (id) => id !== 3,
    warm: (id, dims) => warmed.push([id, dims]),
  };
  const r = createRetriever({
    rag,
    clients: () => ({ embed: { embedQueries: async () => ({ vectors: [[1]] }) } }),
    cfg: RAG,
  });
  r.prefetch("what is the price", [1, 2, 3]);
  assert.deepEqual(warmed, [
    [1, RAG.dims],
    [2, RAG.dims],
  ]);
});

test("a store without warm() (older fakes) is still fine", () => {
  const r = createRetriever({
    rag: { hasIndex: () => true },
    clients: () => ({ embed: { embedQueries: async () => ({ vectors: [[1]] }) } }),
    cfg: RAG,
  });
  assert.doesNotThrow(() => r.prefetch("anything at all", [1]));
});

test("warm() rebuilds an invalidated matrix once; searching then reuses it", sqlite, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mw-"));
  const store = openStore({ dbPath: path.join(dir, "c.db") });
  const pid = store.projects.create("P");
  const rag = store.rag;
  assert.equal(typeof rag.warm, "function");
  const before = rag.matrix(pid, 4);
  rag.invalidateMatrices(pid);
  rag.warm(pid, 4);
  const warmed = rag.matrix(pid, 4);
  assert.notEqual(warmed, before, "a fresh matrix was built by warm");
  assert.equal(rag.matrix(pid, 4), warmed, "and the search reuses it");
});
