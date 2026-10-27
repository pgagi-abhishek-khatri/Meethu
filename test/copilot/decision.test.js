const test = require("node:test");
const assert = require("node:assert/strict");

const d = require("../../src/copilot/core/decision");

const CFG = d.DEFAULT_DECISION_CONFIG;
const NOW = 1_000_000;
const seg = (id, source, text, agoS = 5, speaker) => ({
  id,
  source,
  text,
  speaker,
  at: NOW - agoS * 1000,
  final: true,
});
const input = (over = {}) => ({
  now: NOW,
  meeting: { title: "Q3 plan", type: "client call" },
  summary: "Discussing Q3 revenue targets.",
  transcript: [
    seg(1, "system", "Let's talk numbers.", 40, "system:2"),
    seg(2, "system", "What was France's GDP last year?", 4, "system:2"),
  ],
  newFromId: 2,
  settings: { quiet: "normal" },
  signals: { endpoint: true },
  ...over,
});

// D1-shaped answers (see Liquid docs: noul / choice / score).
const N = (noul) => ({ type: "noul", noul });
const C = (choice, keys, p = 0.9, confidence = 0.9) => ({
  type: "choice",
  choice,
  confidence,
  probabilities: Object.fromEntries(
    keys.map((k) => [k, k === choice ? p : (1 - p) / Math.max(1, keys.length - 1)])
  ),
});
const S = (score) => ({ type: "score", score, confidence: 0.9, probabilities: {} });

// Scripted client: records what was sent. A reply can be an Error to simulate a failed call.
const one = (reply) => {
  const calls = [];
  return {
    calls,
    systemOne: async (req) => {
      calls.push(req);
      if (reply instanceof Error) throw reply;
      return { answers: reply, inputTokens: 100, ms: 50 };
    },
  };
};

const KINDS = ["quick_answer", "explanation", "talking_points", "diagram", "document"];
const answers = ({ act = 0.9, kind = "quick_answer", kp = 0.9, ...over } = {}) => ({
  act: N(act),
  chatter: N(0),
  help: N(1),
  asked_of_assistant: N(0.05),
  complete: N(0.95),
  kind: C(kind, KINDS, kp),
  needs_web: N(0.9),
  ...over,
});
const ctx = (over = {}) => ({
  settings: { ...d.DEFAULT_SETTINGS },
  running: [],
  signals: { endpoint: true },
  userInNew: false,
  hasCards: false,
  ...over,
});
const plan = (c = ctx()) => d.buildQuestions(c).plan;
const run = (a, c = ctx()) => d.interpret(a, plan(c), c, CFG);

// ------------------------------------------------------------ questions
test("one call asks few questions; relation only when a card or analysis could cover it", () => {
  const base = Object.keys(d.buildQuestions(ctx()).questions);
  assert.deepEqual(base.sort(), [
    "act",
    "asked_of_assistant",
    "chatter",
    "complete",
    "help",
    "kind",
    "needs_web",
  ]);
  const withCard = d.buildQuestions(ctx({ hasCards: true })).questions;
  assert.ok("relation" in withCard);
  const job = d.buildQuestions(ctx({ running: [{ id: "j1", topic: "GDP of France" }] })).questions;
  assert.deepEqual(Object.keys(job.relation.criteria), ["new", "covered", "replace_j1"]);
});

test("questions drop disabled capabilities and kinds", () => {
  const q = d.buildQuestions(
    ctx({
      settings: {
        ...d.DEFAULT_SETTINGS,
        web: false,
        diagrams: false,
        documents: false,
        screenshot: true,
      },
    })
  ).questions;
  assert.equal(q.needs_web, undefined);
  assert.ok(q.needs_screenshot);
  assert.deepEqual(Object.keys(q.kind.criteria), ["explanation", "quick_answer", "talking_points"]);
});

// ------------------------------------------------------------ policy
test("a clear need runs; small talk waits", () => {
  const out = run(answers());
  assert.equal(out.kind, "run");
  assert.equal(out.deliverable, "quick_answer");
  assert.equal(out.tier, "fast");
  assert.equal(out.needs.web, true);
  assert.equal(run(answers({ act: 0.02 })).kind, "wait");
});

test("the quiet level moves the bar", () => {
  const a = answers({ act: 0.65 });
  assert.equal(run(a, ctx({ settings: { ...d.DEFAULT_SETTINGS, quiet: "normal" } })).kind, "run");
  assert.equal(run(a, ctx({ settings: { ...d.DEFAULT_SETTINGS, quiet: "quiet" } })).kind, "wait");
  // chatter discounts substance: 0.9 x (1 - 0.5) is under the normal bar
  assert.equal(run(answers({ act: 0.9, chatter: N(0.5) })).kind, "wait");
  // help multiplies too: substance that nobody asked about or doubted (fluent jargon, decisions) stays quiet
  assert.equal(run(answers({ act: 0.9, help: N(0.3) })).kind, "wait");
  assert.equal(run(answers({ act: 0.9, help: N(0.9) })).kind, "run");
  const low = answers({ act: 0.5 });
  assert.equal(run(low, ctx({ settings: { ...d.DEFAULT_SETTINGS, quiet: "chatty" } })).kind, "run");
});

test("an explicit request from the user bypasses the bar, cooldown and speaking hold", () => {
  const c = ctx({
    userInNew: true,
    signals: { endpoint: true, sinceLastCardMs: 500, userSpeaking: true },
  });
  const out = run(answers({ act: 0.01, asked_of_assistant: N(0.95) }), c);
  assert.equal(out.kind, "run");
  assert.equal(out.trigger, "explicit");
  // the model's word alone is not enough: the user must have spoken in new_text
  const heard = ctx({ userInNew: false, signals: { endpoint: true, sinceLastCardMs: 500 } });
  assert.equal(run(answers({ act: 0.01, asked_of_assistant: N(0.95) }), heard).kind, "wait");
});

test("cooldown and others' words while the user speaks stop proactive cards", () => {
  assert.equal(
    run(answers(), ctx({ signals: { endpoint: true, sinceLastCardMs: 1000 } })).kind,
    "wait"
  );
  assert.equal(
    run(answers(), ctx({ signals: { endpoint: true, userSpeaking: true } })).kind,
    "wait"
  );
  assert.equal(
    run(answers(), ctx({ userInNew: true, signals: { endpoint: true, userSpeaking: true } })).kind,
    "run"
  );
});

test("already covered skips; a change to a running analysis replaces it, whatever it scores", () => {
  const withCard = ctx({ hasCards: true });
  const covered = answers({ relation: C("covered", ["new", "covered"], 0.9) });
  assert.equal(run(covered, withCard).kind, "skip");
  const running = ctx({
    running: [{ id: "j1", topic: "GDP" }],
    signals: { endpoint: true, sinceLastCardMs: 1000 },
  });
  const keys = ["new", "covered", "replace_j1"];
  const replace = run(answers({ act: 0.01, relation: C("replace_j1", keys, 0.9) }), running);
  assert.equal(replace.kind, "run");
  assert.equal(replace.timing, "supersede");
  assert.equal(replace.cancelJobId, "j1");
  assert.equal(run(answers({ relation: C("new", keys, 0.9) }), running).kind, "wait"); // cooldown
});

test("inside the cooldown with a job running only a request or a change counts", () => {
  const c = ctx({
    updateCheck: true,
    userInNew: true,
    running: [{ id: "j1", topic: "GDP" }],
    signals: { endpoint: true, sinceLastCardMs: 1000 },
  });
  const keys = ["new", "covered", "replace_j1"];
  const none = { asked_of_assistant: N(0.05), relation: C("new", keys, 0.9) };
  const quiet = run(none, c);
  assert.equal(quiet.kind, "wait");
  assert.equal(quiet.updateCheck, true);
  assert.equal(run({ ...none, relation: C("replace_j1", keys, 0.9) }, c).cancelJobId, "j1");
  assert.equal(run({ ...none, asked_of_assistant: N(0.95) }, c).trigger, "explicit");
});

test("an unfinished sentence is rechecked for a bounded time", () => {
  const half = answers({ act: 0.7, complete: N(0.1) });
  const waiting = ctx({ signals: { endpoint: false, waitedMs: 0 } });
  assert.equal(run(half, waiting).kind, "recheck");
  assert.equal(run(half, ctx({ signals: { endpoint: false, waitedMs: 5000 } })).kind, "run");
  assert.equal(run(answers({ act: 0.01, complete: N(0.1) }), waiting).kind, "wait");
});

test("diagrams and documents are offered, not produced, unless very likely or asked for", () => {
  const maybe = answers({ kind: "diagram", kp: 0.6 });
  const out = run(maybe);
  assert.equal(out.kind, "run");
  assert.notEqual(out.deliverable, "diagram");
  assert.deepEqual(out.offers, ["diagram"]);
  const sure = run(answers({ kind: "diagram", kp: 0.95 }));
  assert.equal(sure.deliverable, "diagram");
  assert.equal(sure.tier, "reasoning");
});

test("needs follow their own thresholds", () => {
  const a = answers({ needs_web: N(0.65) });
  assert.equal(run(a).needs.web, true);
  assert.equal(run(answers({ needs_web: N(0.3) })).needs.web, false);
});

test("malformed or missing answers fail quiet", () => {
  for (const bad of [
    {},
    answers({ act: { type: "noul", noul: 7 } }),
    answers({ kind: C("zzz", ["zzz"]) }),
  ]) {
    const out = run(bad);
    assert.equal(out.kind, "wait");
    assert.match(out.reasons[0], /invalid_answer/);
  }
});

// ------------------------------------------------------------ decide
test("decide: exactly one call, with the whole state, run decision carries latency and tokens", async () => {
  const client = one(answers());
  const out = await d.decide({ input: input(), client });
  assert.equal(client.calls.length, 1);
  assert.equal(out.kind, "run");
  assert.equal(out.inputTokens, 100);
  assert.equal(out.latency.gateMs, 50);
  assert.ok(client.calls[0].state.new_text.length);
});

test("decide: failures stay quiet", async () => {
  const out = await d.decide({
    input: input(),
    client: one(Object.assign(new Error("x"), { code: "timeout" })),
  });
  assert.equal(out.kind, "wait");
  assert.match(out.reasons[0], /decision_unavailable:timeout/);
  assert.equal(d.fallbackDecision(true, "http").trigger, "explicit");
});

// ------------------------------------------------------------ state
test("state labels speakers, splits new text from context and drops empty keys", () => {
  const s = d.buildDecisionState(input(), CFG);
  assert.deepEqual(s.new_text, ["OTHER-2: What was France's GDP last year?"]);
  assert.deepEqual(s.context, ["OTHER-2: Let's talk numbers."]);
  assert.equal(s.running, undefined);
  assert.equal(s.user_speaking, undefined);
  assert.equal(s.sentence_unfinished, undefined);
  const mic = d.buildDecisionState(input({ transcript: [seg(2, "mic", "ok")], newFromId: 2 }), CFG);
  assert.match(mic.new_text[0], /USER: ok/);
  const open = d.buildDecisionState(
    input({ signals: { endpoint: false, userSpeaking: true } }),
    CFG
  );
  assert.equal(open.sentence_unfinished, true);
  assert.equal(open.user_speaking, true);
});

test("state keeps the newest lines inside the character budget", () => {
  const long = Array.from({ length: 12 }, (_, i) =>
    seg(i + 1, "system", `line ${i} ${"x".repeat(200)}`, 100 - i)
  );
  const s = d.buildDecisionState(input({ transcript: long, newFromId: 12 }), CFG);
  assert.ok(s.context.join("").length <= CFG.budget.context + 20);
  assert.match(s.context.at(-1), /line 10/);
  assert.match(s.context.join(" "), /line 5 /, "the past lines ride along, merged into utterances");
});

test("running jobs and cards are described compactly", () => {
  const s = d.buildDecisionState(
    input({
      running: [{ id: "j1", topic: "GDP of France", status: "searching", startedAt: NOW - 3000 }],
      recentCards: [
        {
          kind: "quick_answer",
          gist: "Q2 revenue was 4M",
          shownAt: NOW - 20000,
          reaction: "dismissed",
        },
      ],
    }),
    CFG
  );
  assert.deepEqual(s.running, ["j1: GDP of France (searching)"]);
  assert.deepEqual(s.cards, ["quick_answer: Q2 revenue was 4M [dismissed]"]);
});

test("state is bounded: a long meeting is the last ~20 lines plus the summary", () => {
  const long = Array.from({ length: 60 }, (_, i) =>
    seg(i + 1, "system", `sentence number ${i} ${"word ".repeat(30)}`, 200 - i)
  );
  const s = d.buildDecisionState(
    input({ transcript: long, newFromId: 60, summary: "x".repeat(2000) }),
    CFG
  );
  assert.ok(JSON.stringify(s).length < 6500, `state was ${JSON.stringify(s).length} chars`);
});

// ------------------------------------------------------------ screenshot
test("screenshot check fails closed on sensitivity, irrelevance and bad answers", () => {
  const ok = d.interpretScreenshotCheck({ image_relevant: N(0.9), image_sensitive: N(0.05) });
  assert.equal(ok.attach, true);
  assert.equal(
    d.interpretScreenshotCheck({ image_relevant: N(0.9), image_sensitive: N(0.6) }).attach,
    false
  );
  assert.equal(
    d.interpretScreenshotCheck({ image_relevant: N(0.3), image_sensitive: N(0.0) }).attach,
    false
  );
  assert.equal(d.interpretScreenshotCheck({}).attach, false);
  const req = d.buildScreenshotCheck(input(), "data:image/jpeg;base64,AAA", CFG);
  assert.deepEqual(req.images, ["data:image/jpeg;base64,AAA"]);
});

// ------------------------------------------------------------ client
test("client sends the documented request and maps errors", async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return {
      ok: true,
      json: async () => ({ answers: { a: N(0.5) }, usage: { input_tokens: 7, output_tokens: 0 } }),
    };
  };
  const client = d.createLiquidClient({
    apiKey: "liquid_k",
    url: "https://openrouter.ai/api/v1/systemone",
    model: "liquid/d1",
    timeoutMs: 500,
    fetchImpl,
  });
  const res = await client.systemOne({
    state: { x: 1 },
    questions: { a: { type: "noul", instructions: "?" } },
  });
  assert.equal(seen.url, "https://openrouter.ai/api/v1/systemone");
  assert.equal(seen.init.headers.Authorization, "Bearer liquid_k");
  assert.equal(seen.body.model, "liquid/d1");
  assert.equal(res.inputTokens, 7);

  const noKey = d.createLiquidClient({
    apiKey: "",
    url: "x",
    model: "d1",
    timeoutMs: 100,
    fetchImpl,
  });
  await assert.rejects(noKey.systemOne({}), (e) => e.code === "no_key");
  const bad = d.createLiquidClient({
    apiKey: "k",
    url: "x",
    model: "d1",
    timeoutMs: 100,
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => "no" }),
  });
  await assert.rejects(bad.systemOne({}), (e) => e.code === "http" && e.status === 401);
  const slow = d.createLiquidClient({
    apiKey: "k",
    url: "x",
    model: "d1",
    timeoutMs: 20,
    fetchImpl: (u, init) =>
      new Promise((_, rej) =>
        init.signal.addEventListener("abort", () => rej(new Error("aborted")))
      ),
  });
  await assert.rejects(slow.systemOne({}), (e) => e.code === "timeout");
});
