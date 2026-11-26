// Phase 2.6: a question that differs only in case, spacing or end punctuation reuses the cached embedding, and the
// cache evicts the least recently used question, not the oldest one.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createEmbedClient } = require("../../src/copilot/rag/embedClient");

const okFetch = (log) => async (_url, init) => {
  const body = JSON.parse(init.body);
  log.push(body.input);
  return {
    ok: true,
    json: async () => ({
      data: body.input.map((_, i) => ({ index: i, embedding: [1, i + 1, 0, 0] })),
      usage: { total_tokens: 1, cost: 0 },
    }),
  };
};

test("case, spacing and trailing punctuation do not cost another round trip", async () => {
  const log = [];
  const c = createEmbedClient({ apiKey: "k", dims: 4, fetchImpl: okFetch(log) });
  await c.embedQueries(["What is the refund rule"]);
  const again = await c.embedQueries(["  what is  the refund rule?  ", "WHAT IS THE REFUND RULE."]);
  assert.equal(log.length, 1);
  assert.equal(again.cached, 2);
});

test("a genuinely different question is still embedded", async () => {
  const log = [];
  const c = createEmbedClient({ apiKey: "k", dims: 4, fetchImpl: okFetch(log) });
  await c.embedQueries(["refund rule"]);
  await c.embedQueries(["holiday policy"]);
  assert.equal(log.length, 2);
});

test("the cache is least-recently-used: a question asked again survives eviction", async () => {
  const log = [];
  const c = createEmbedClient({ apiKey: "k", dims: 4, fetchImpl: okFetch(log), cacheSize: 2 });
  await c.embedQueries(["alpha question"]);
  await c.embedQueries(["beta question"]);
  await c.embedQueries(["alpha question"]); // touch: alpha is now the newest
  await c.embedQueries(["gamma question"]); // evicts beta, not alpha
  const before = log.length;
  await c.embedQueries(["alpha question"]);
  assert.equal(log.length, before, "alpha is still cached");
  await c.embedQueries(["beta question"]);
  assert.equal(log.length, before + 1, "beta was evicted");
});

test("the text sent to the model keeps the speaker's original wording", async () => {
  const log = [];
  const c = createEmbedClient({ apiKey: "k", dims: 4, fetchImpl: okFetch(log) });
  await c.embedQueries(["Where is retrieveChunks?"]);
  assert.match(log[0][0], /query: Where is retrieveChunks\?$/);
});

test("one call with more distinct questions than the cache holds still gets every vector", async () => {
  const log = [];
  const c = createEmbedClient({ apiKey: "k", dims: 4, fetchImpl: okFetch(log), cacheSize: 2 });
  const r = await c.embedQueries(["one", "two", "three", "four"]);
  assert.equal(r.vectors.length, 4);
  assert.ok(r.vectors.every((v) => v && v.length === 4));
});

test("a cached question is not lost when the same call's new questions evict it", async () => {
  const log = [];
  const c = createEmbedClient({ apiKey: "k", dims: 4, fetchImpl: okFetch(log), cacheSize: 2 });
  await c.embedQueries(["cached one"]);
  const r = await c.embedQueries(["cached one", "new a", "new b", "new c"]);
  assert.equal(r.vectors.length, 4);
  assert.ok(r.vectors.every((v) => v && v.length === 4));
});
