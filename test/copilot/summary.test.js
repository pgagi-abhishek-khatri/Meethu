const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRollingSummary,
  buildSummaryMessages,
  DEFAULT_SUMMARY_CONFIG: PROD,
} = require("../../src/copilot/core/summary/rollingSummary");
// The tests below use a small window so they stay short; the shipped numbers are pinned in the last test.
const CFG = {
  ...PROD,
  keepRaw: 5,
  minSegments: 5,
  minChars: 600,
  minIntervalMs: 30000,
  failureBackoffMs: 60000,
};
const { fakeClock } = require("./helpers");

const segs = (n, from = 1) =>
  Array.from({ length: n }, (_, i) => ({
    id: from + i,
    source: i % 2 ? "mic" : "system",
    text: `segment ${from + i} about the budget`,
    final: true,
  }));
const label = (s) => (s.source === "mic" ? "USER" : "OTHER-1");

const make = (reply = async () => ({ text: "Budget talks." })) => {
  const clock = fakeClock();
  const calls = [];
  const summary = createRollingSummary({
    llm: async (req) => (calls.push(req), reply(req)),
    label,
    cfg: CFG,
    now: clock.now,
  });
  return { clock, calls, summary };
};

test("waits until enough segments have aged out of the raw window", async () => {
  const { calls, summary } = make();
  assert.equal(summary.maybeUpdate(segs(CFG.keepRaw + CFG.minSegments - 1)), null);
  assert.equal(calls.length, 0);
  const p = summary.maybeUpdate(segs(CFG.keepRaw + CFG.minSegments));
  assert.ok(p);
  await p;
  assert.equal(summary.text, "Budget talks.");
  assert.equal(summary.coveredUpToId, CFG.minSegments);
});

test("the newest segments are never summarized and only unsummarized ones are sent", async () => {
  const { clock, calls, summary } = make();
  const t = segs(14);
  await summary.maybeUpdate(t);
  const sent = calls[0].messages[1].content;
  assert.ok(sent.includes("segment 9 about"));
  assert.equal(sent.includes("segment 10 about"), false); // the last keepRaw (5) stay raw
  clock.advance(CFG.minIntervalMs + 1);
  await clock.advance(CFG.minIntervalMs + 1);
  await summary.maybeUpdate(segs(24));
  const second = calls[1].messages[1].content;
  assert.ok(second.includes("Current summary:\nBudget talks."));
  assert.equal(second.includes("segment 9 about"), false);
  assert.ok(second.includes("segment 10 about"));
});

test("updates are rate limited and never overlap", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { clock, summary } = make(async () => (await gate, { text: "ok" }));
  const first = summary.maybeUpdate(segs(20));
  assert.equal(summary.maybeUpdate(segs(20)), null); // still updating
  release();
  await first;
  assert.equal(summary.maybeUpdate(segs(20)), null); // too soon
  await clock.advance(CFG.minIntervalMs);
  assert.ok(summary.maybeUpdate(segs(40)));
});

test("a failure keeps the old summary, backs off and counts", async () => {
  let fail = true;
  const { clock, summary } = make(async () => {
    if (fail) throw new Error("boom");
    return { text: "recovered" };
  });
  await summary.maybeUpdate(segs(20));
  assert.equal(summary.stats.failures, 1);
  assert.equal(summary.text, "");
  fail = false;
  await clock.advance(CFG.minIntervalMs);
  assert.equal(summary.maybeUpdate(segs(20)), null); // still backing off
  await clock.advance(CFG.failureBackoffMs);
  await summary.maybeUpdate(segs(20));
  assert.equal(summary.text, "recovered");
  const empty = make(async () => ({ text: "   " }));
  await empty.summary.maybeUpdate(segs(20));
  assert.equal(empty.summary.stats.failures, 1);
});

test("the prompt asks for a short plain summary", () => {
  const [system, user] = buildSummaryMessages("", ["USER: hi"], 60);
  assert.match(system.content, /at most 60 words/);
  assert.match(user.content, /\(none yet\)/);
});

test("a backlog is folded in chunks, oldest first, chained without waiting for the interval", async () => {
  const { calls, summary } = make();
  const result = await summary.maybeUpdate(segs(CFG.keepRaw + 53));
  assert.equal(calls.length, 3, "53 aged segments = 24 + 24 + 5");
  assert.equal(result.calls, 3);
  assert.equal(result.covered, 53);
  assert.equal(summary.coveredUpToId, 53);
  const first = calls[0].messages[1].content;
  assert.ok(first.includes("segment 1 about") && first.includes("segment 24 about"));
  assert.equal(first.includes("segment 25 about"), false);
  assert.ok(calls[1].messages[1].content.includes("segment 25 about"));
  assert.equal(summary.stats.gaps, 0);
});

test("one call never reads more than the character limit", async () => {
  const { calls, summary } = make();
  const big = Array.from({ length: 30 }, (_, i) => ({
    id: i + 1,
    source: "system",
    text: "x".repeat(1200),
    final: true,
  }));
  await summary.maybeUpdate(big);
  for (const c of calls) assert.ok(c.messages[1].content.length < CFG.maxCharsPerCall + 600);
  assert.ok(calls.length >= 2);
});

test("a huge backlog leaves a gap: only the newest chunk is summarized and the model is told", async () => {
  const { calls, summary } = make();
  const total = CFG.keepRaw + CFG.maxBacklogSegments + 40;
  const result = await summary.maybeUpdate(segs(total));
  const first = calls[0].messages[1].content;
  assert.match(first, /earlier lines were skipped/);
  assert.equal(first.includes("segment 1 about"), false);
  assert.ok(first.includes(`segment ${total - CFG.keepRaw} about`));
  assert.equal(summary.stats.gaps, 1);
  assert.equal(summary.stats.segmentsSkipped, CFG.maxBacklogSegments + 40 - CFG.maxLinesPerCall);
  assert.equal(summary.coveredUpToId, total - CFG.keepRaw);
  assert.equal(calls.length, 1, "nothing is left to chain");
  assert.ok(result.skipped > 0);
});

test("chaining stops after maxChain calls and resumes on the next update", async () => {
  const { calls, summary } = make();
  const small = { ...CFG, maxLinesPerCall: 5, maxChain: 2, minIntervalMs: 0 };
  const clock = fakeClock();
  const s = createRollingSummary({
    llm: async (req) => (calls.push(req), { text: "ok" }),
    label,
    cfg: small,
    now: clock.now,
  });
  await s.maybeUpdate(segs(5 + 20));
  assert.equal(calls.length, 2);
  assert.equal(s.coveredUpToId, 10);
  await s.maybeUpdate(segs(5 + 20));
  assert.equal(calls.length, 4);
  assert.equal(s.coveredUpToId, 20);
});

test("the OpenRouter client switches reasoning off for DeepSeek and not for other models", async () => {
  const {
    createOpenRouterLlm,
    DEFAULT_SUMMARY_MODEL,
  } = require("../../src/copilot/core/summary/rollingSummary");
  assert.equal(DEFAULT_SUMMARY_MODEL, "deepseek/deepseek-v4.1-flash:nitro");
  const bodies = [];
  const fetchImpl = async (url, init) => (
    bodies.push(JSON.parse(init.body)),
    { ok: true, json: async () => ({ choices: [{ message: { content: "hi" } }] }) }
  );
  await createOpenRouterLlm({ apiKey: "k", model: DEFAULT_SUMMARY_MODEL, fetchImpl })({
    messages: [],
  });
  await createOpenRouterLlm({ apiKey: "k", model: "google/gemini-3.5-flash-lite", fetchImpl })({
    messages: [],
  });
  assert.deepEqual(bodies[0].reasoning, { enabled: false });
  assert.equal("reasoning" in bodies[1], false);
});

test("shipped setting: the last 15 messages stay verbatim and one summary call runs per 15 new messages", async () => {
  const calls = [];
  const s = createRollingSummary({
    llm: async (r) => (calls.push(r), { text: "ok" }),
    label,
    now: fakeClock().now,
  });
  assert.equal(s.maybeUpdate(segs(15 + 14)), null, "14 aged messages: not yet");
  await s.maybeUpdate(segs(15 + 15));
  assert.equal(calls.length, 1);
  assert.equal(s.coveredUpToId, 15);
  assert.equal(
    s.maybeUpdate(segs(15 + 15 + 10)),
    null,
    "10 more: not yet, however much time passed"
  );
});
