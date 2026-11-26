// Phase 2.3: a deterministic, code-aware query rewrite replaces the LLM query writer on the fast path.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { rewriteQuery, splitIdentifier } = require("../../src/copilot/rag/queryRewrite");
const { createRetriever } = require("../../src/copilot/rag/retrieve");
const { RAG } = require("../../src/copilot/rag/config");

test("splits camelCase, PascalCase, snake_case and kebab-case", () => {
  assert.deepEqual(splitIdentifier("retrieveChunks"), ["retrieve", "chunks"]);
  assert.deepEqual(splitIdentifier("HTTPServerConfig"), ["http", "server", "config"]);
  assert.deepEqual(splitIdentifier("handle_user_login"), ["handle", "user", "login"]);
  assert.deepEqual(splitIdentifier("feature-flag-store"), ["feature", "flag", "store"]);
  assert.deepEqual(splitIdentifier("plain"), ["plain"]);
});

test("keeps symbols and paths whole and adds their parts; drops question filler", () => {
  const r = rewriteQuery("where is retrieveChunks used in rag/retrieve.js");
  const all = r.queries.join(" ").toLowerCase();
  for (const t of ["retrievechunks", "retrieve", "chunks", "rag/retrieve.js"])
    assert.ok(all.includes(t), t);
  for (const w of ["where", " is ", " in "]) assert.equal(all.includes(w), false, w);
  assert.ok(r.symbols.includes("retrieveChunks"));
  assert.ok(r.terms.length >= 2);
});

test("backticked and quoted text is treated as a symbol", () => {
  const r = rewriteQuery("what does `load_config` do when the file is missing");
  assert.ok(r.symbols.includes("load_config"));
  assert.ok(r.queries[0].includes("load_config"));
});

test("plain prose becomes its content words", () => {
  const r = rewriteQuery("what is the refund rule for annual plans");
  assert.deepEqual(r.terms.sort(), ["annual", "plans", "refund", "rule"].sort());
});

test("nothing to search for reports needsModel", () => {
  const r = rewriteQuery("uh yeah okay so");
  assert.equal(r.queries.length, 0);
  assert.equal(r.needsModel, true);
});

test("bounded: a huge transcript tail yields a short query", () => {
  const r = rewriteQuery(Array.from({ length: 400 }, (_, i) => `word${i}`).join(" "));
  assert.ok(r.terms.length <= 16);
});

// --- wiring into retrieve ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function retriever({ expandMs = 50 } = {}) {
  const seenKeyword = [];
  const rag = {
    hasIndex: () => true,
    catalog: () => [],
    keyword: (_pid, query) => (seenKeyword.push(query), [1]),
    vector: () => [{ id: 1, score: 0.9 }],
    similarity: () => new Map(),
    rrf: () => [{ id: 1 }],
    chunk: () => ({ file: "a.md", file_id: 1, text: "answer", meta: {} }),
  };
  const calls = { expand: 0 };
  const expand = async () => {
    calls.expand += 1;
    await sleep(expandMs);
    return { queries: ["written by model"] };
  };
  const r = createRetriever({
    rag,
    clients: () => ({ embed: { embedQueries: async () => ({ vectors: [[1, 0]], cost: 0 }) } }),
    cfg: RAG,
  });
  return { r, calls, expand, seenKeyword };
}

test("fast path: no model call, the rewrite is searched by keyword", async () => {
  const { r, calls, expand, seenKeyword } = retriever();
  const out = await r.retrieve({ query: "where is retrieveChunks used", projectIds: [1], expand });
  assert.equal(calls.expand, 0);
  assert.ok(seenKeyword.some((q) => /retrieve/i.test(q) && /chunks/i.test(q)));
  assert.ok(out.queries.length >= 2);
});

test("fast path: an unusable moment still falls back to the model", async () => {
  const { r, calls, expand } = retriever();
  await r.retrieve({ query: "uh yeah okay so", projectIds: [1], expand });
  assert.equal(calls.expand, 1);
});

test("an expander that is already paid for is still used", async () => {
  const { r, calls, expand } = retriever();
  const free = Object.assign(async () => ({ queries: ["prepaid query"] }), { free: true });
  const out = await r.retrieve({
    query: "where is retrieveChunks used",
    projectIds: [1],
    expand: free,
  });
  assert.ok(out.queries.includes("prepaid query"));
  assert.equal(calls.expand, 0);
  void expand;
});

test("deep path waits for the model, but no longer than the cap", async () => {
  const { r, expand } = retriever({ expandMs: 4000 });
  const t = Date.now();
  const out = await r.retrieve({
    query: "where is retrieveChunks used",
    projectIds: [1],
    deep: true,
    expand,
  });
  const ms = Date.now() - t;
  assert.ok(ms < RAG.queryWaitMs.deep + 800, `took ${ms}ms`);
  assert.equal(typeof out.text, "string");
});
