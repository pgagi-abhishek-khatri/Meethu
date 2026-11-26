// Phase 2.7: a live question's embedding gives up on a hung connection quickly and retries once, fast.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { postJson } = require("../../src/copilot/rag/openrouter");
const { createEmbedClient } = require("../../src/copilot/rag/embedClient");

// A fetch whose first call never answers (until its signal aborts); later calls succeed.
function hangingOnce(log) {
  let n = 0;
  return (_url, init) => {
    n += 1;
    const body = JSON.parse(init.body);
    log.push(n);
    if (n === 1)
      return new Promise((_, reject) =>
        init.signal.addEventListener("abort", () => reject(init.signal.reason))
      );
    return Promise.resolve({
      ok: true,
      json: async () => ({
        data: body.input.map((_, i) => ({ index: i, embedding: [1, 0, 0, 0] })),
        usage: { total_tokens: 1, cost: 0 },
      }),
    });
  };
}

test("postJson: backoffMs sets the wait before a retry", async () => {
  const waits = [];
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    if (n === 1)
      return { ok: false, status: 503, text: async () => "busy", headers: { get: () => null } };
    return { ok: true, json: async () => ({ ok: 1 }) };
  };
  await postJson(
    "/x",
    {},
    { apiKey: "k", fetchImpl, retries: 2, backoffMs: 50, sleep: async (ms) => waits.push(ms) }
  );
  assert.equal(waits.length, 1);
  assert.ok(waits[0] >= 50 && waits[0] < 50 + 260, `waited ${waits[0]}ms`);
});

test("a hung query embedding is cut off and retried once, well inside the search's wait", async () => {
  const log = [];
  const c = createEmbedClient({
    apiKey: "k",
    dims: 4,
    fetchImpl: hangingOnce(log),
    queryTimeoutMs: 80,
    queryRetries: 1,
    queryBackoffMs: 10,
  });
  const t = Date.now();
  const r = await c.embedQueries(["what is the refund rule"]);
  const ms = Date.now() - t;
  assert.equal(r.vectors.length, 1);
  assert.equal(log.length, 2, "one hung attempt, one retry");
  assert.ok(ms < 600, `took ${ms}ms`);
});

test("document embedding keeps the patient defaults", async () => {
  const log = [];
  const c = createEmbedClient({
    apiKey: "k",
    dims: 4,
    fetchImpl: hangingOnce(log),
    queryTimeoutMs: 20,
  });
  // the first call hangs; with the default (long) timeout a file batch would wait, so just prove queries are the
  // only lane with the short limit by checking a doc call is not aborted at 20ms
  const p = c.embedDocs([{ text: "x" }]);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(
    log.length,
    1,
    "still waiting on its first attempt, not retried at the query timeout"
  );
  void p;
});
