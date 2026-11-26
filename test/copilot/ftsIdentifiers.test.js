// Phase 4.2: a question that names an identifier finds the passage that spells it another way.
// ELECTRON_RUN_AS_NODE=1 npx electron --test test/copilot/ftsIdentifiers.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { ftsQuery, createRagStore } = require("../../src/copilot/rag/ragStore");

let Database = null;
try {
  Database = require("better-sqlite3");
  new Database(":memory:").close();
} catch {
  Database = null;
}
const sqlite = { skip: Database ? false : "better-sqlite3 is not built for this runtime" };
const terms = (q) => (q.match(/"([^"]+)"/g) ?? []).map((t) => t.slice(1, -1));

test("camelCase and snake_case words contribute their parts as well as themselves", () => {
  const t = terms(ftsQuery("retrieveChunks"));
  for (const w of ["retrievechunks", "retrieve", "chunks"]) assert.ok(t.includes(w), w);
  const s = terms(ftsQuery("load_user_config"));
  for (const w of ["load", "user", "config"]) assert.ok(s.includes(w), w);
});

test("adjacent plain words also contribute their joined form (a doc may spell it camelCase)", () => {
  assert.ok(terms(ftsQuery("where is the load config")).includes("loadconfig"));
});

test("existing behaviour holds: stop words and tiny words dropped, terms unique, capped", () => {
  const t = terms(ftsQuery("the of is refund refund rule"));
  assert.deepEqual(t.filter((w) => w === "refund").length, 1);
  assert.ok(!t.includes("the") && !t.includes("of"));
  assert.ok(
    terms(ftsQuery(Array.from({ length: 80 }, (_, i) => `word${i}x`).join(" "))).length <= 32
  );
  assert.equal(ftsQuery("a"), "");
});

test("quotes in input cannot break the query syntax", () => {
  assert.doesNotThrow(() => terms(ftsQuery('say "hello" AND NOT (x) OR *')));
});

test("end to end: either spelling finds either spelling", sqlite, () => {
  const rag = createRagStore(new Database(":memory:"));
  rag.replaceChunks(
    1,
    10,
    [{ text: "The loop calls retrieve_chunks to fetch rows from the store." }],
    0
  );
  rag.replaceChunks(2, 10, [{ text: "function loadConfig reads the yaml settings file." }], 0);
  const has = (q, n) =>
    assert.equal(rag.keyword(10, q, 5, { includeInactive: true }).length >= 1, true, `${q} (${n})`);
  has("where is retrieveChunks used", "camel query, snake doc");
  has("which function does load config", "plain words, camel doc");
  has("loadConfig", "same spelling");
});
