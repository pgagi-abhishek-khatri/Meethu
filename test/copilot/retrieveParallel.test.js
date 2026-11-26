// Phase 2.2: routers, authoritative lookups, the query embedding and the query writer run side by side.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createRetriever } = require("../../src/copilot/rag/retrieve");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STEP = 120;

function fakes({ temporal = null, alsByProject = {}, writerQueries = [] } = {}) {
  const seen = { writerAborted: false, embedCalls: 0, alsCalls: [] };
  const rag = {
    hasIndex: () => true,
    catalog: () => [],
    keyword: () => [1],
    vector: () => [{ id: 1, score: 0.9 }],
    similarity: () => new Map(),
    rrf: () => [{ id: 1 }],
    chunk: () => ({ file: "a.md", file_id: 1, text: "the answer text", meta: {} }),
  };
  const clients = () => ({
    embed: {
      embedQueries: async () => {
        seen.embedCalls += 1;
        await sleep(STEP);
        return { vectors: [[1, 0]], cost: 0 };
      },
    },
  });
  const temporalRouter = {
    routeTemporalQuery: async () => {
      await sleep(STEP);
      return temporal ?? { status: "NONE" };
    },
  };
  const als = {
    lookup: async ({ projectId }) => {
      seen.alsCalls.push(projectId);
      await sleep(STEP);
      return alsByProject[projectId] ?? { status: "NONE" };
    },
  };
  const expand = async (_q, { signal }) => {
    signal.addEventListener("abort", () => (seen.writerAborted = true));
    await sleep(STEP);
    return { queries: writerQueries };
  };
  return { rag, clients, temporalRouter, als, expand, seen };
}

const make = (f) =>
  createRetriever({
    rag: f.rag,
    clients: f.clients,
    als: f.als,
    temporalRouter: f.temporalRouter,
    embedWaitMs: 2500,
  });

test("four slow dependencies cost about one, not four", async () => {
  const f = fakes();
  const t = Date.now();
  const r = await make(f).retrieve({
    query: "what is the refund rule",
    projectIds: [1, 2],
    expand: f.expand,
  });
  const ms = Date.now() - t;
  assert.ok(r.text.includes("the answer text"), "still answers");
  // serial was router + 2x lookup + embed/writer = ~4 steps; parallel is ~1
  assert.ok(ms < STEP * 2.5, `took ${ms}ms (serial would be ~${STEP * 4}ms)`);
});

test("the first project that resolves wins, even when a later one answers sooner", async () => {
  const f = fakes({
    alsByProject: {
      1: {
        status: "RESOLVED",
        facts: [{ text: "from one", source_name: "one.md" }],
        feature: { canonical_name: "F" },
        version: { version: "1" },
      },
      2: {
        status: "RESOLVED",
        facts: [{ text: "from two", source_name: "two.md" }],
        feature: { canonical_name: "F" },
        version: { version: "2" },
      },
    },
  });
  const r = await make(f).retrieve({ query: "what is the refund rule", projectIds: [1, 2] });
  assert.match(r.text, /from one/);
  assert.doesNotMatch(r.text, /from two/);
});

test("a resolved temporal answer wins over the lookups and cancels the query writer", async () => {
  const f = fakes({
    temporal: {
      status: "RESOLVED",
      passages: "old spec passage",
      evidence: [{ source: "spec.md", version: "1", role: "x" }],
      plan: { intent: "HISTORICAL_STATE" },
    },
    alsByProject: {
      1: {
        status: "RESOLVED",
        facts: [{ text: "als", source_name: "a.md" }],
        feature: {},
        version: {},
      },
    },
  });
  const r = await make(f).retrieve({
    query: "what did the spec say last month",
    projectIds: [1],
    deep: true, // the fast path no longer starts the writer at all
    expand: f.expand,
  });
  assert.match(r.text, /old spec passage/);
  assert.doesNotMatch(r.text, /als/);
  assert.equal(f.seen.writerAborted, true, "the writer's answer is no longer wanted");
});

test("a failing router or lookup does not stop the search", async () => {
  const f = fakes();
  f.temporalRouter.routeTemporalQuery = async () => {
    throw new Error("router down");
  };
  f.als.lookup = async () => {
    throw new Error("als down");
  };
  const r = await make(f).retrieve({ query: "what is the refund rule", projectIds: [1] });
  assert.ok(r.text.includes("the answer text"));
});
