const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createEngine } = require("../../src/copilot/main/engine");
const d = require("../../src/copilot/core/decision");
const { fakeClock } = require("./helpers");

const N = (noul) => ({ type: "noul", noul });
const probs = (keys, key, p) =>
  Object.fromEntries(keys.map((k) => [k, k === key ? p : (1 - p) / (keys.length - 1)]));
const KINDS = ["quick_answer", "explanation", "talking_points", "diagram", "document"];

// A fake D1: needs help on anything with "?", chatter otherwise; "Sorry" in new text changes a running job.
function fakeD1() {
  const calls = [];
  return {
    calls,
    async systemOne({ state, questions }) {
      calls.push({ state, questions });
      const text = state.new_text.join(" ");
      const answers = { asked_of_assistant: N(0.05) };
      if ("relation" in questions) {
        const keys = Object.keys(questions.relation.criteria);
        const replace = keys.find((k) => k.startsWith("replace_"));
        const pick = text.includes("Sorry") && replace ? replace : "new";
        answers.relation = {
          type: "choice",
          choice: pick,
          confidence: 0.9,
          probabilities: probs(keys, pick, 0.9),
        };
      }
      if ("act" in questions) {
        answers.act = N(text.includes("?") ? 0.9 : 0.02);
        answers.chatter = N(0);
        answers.help = N(1);
        answers.complete = N(0.95);
        answers.kind = {
          type: "choice",
          choice: "quick_answer",
          confidence: 0.9,
          probabilities: probs(KINDS, "quick_answer", 0.9),
        };
        answers.needs_web = N(0.9);
        if ("needs_project" in questions)
          answers.needs_project = N(text.includes("contract") ? 0.9 : 0.05);
      }
      return { answers, inputTokens: 300, ms: 40 };
    },
  };
}

function setup(extraEnv = {}, mainModel = null, extra = {}) {
  const clock = fakeClock();
  const client = fakeD1();
  const events = [];
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-dev-"));
  const summaryCalls = [];
  const service = createEngine({
    env: { COPILOT_QUIET: "normal", ...extraEnv },
    logDir,
    panel: { send: (e) => events.push(e), open: () => events.push({ type: "open" }) },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    client,
    mainModel,
    ...extra,
    llm: async (req) => (summaryCalls.push(req), { text: "Short summary of the meeting so far." }),
    summaryCfg: {
      keepRaw: 3,
      minSegments: 3,
      minChars: 10_000,
      minIntervalMs: 0,
      maxWords: 60,
      failureBackoffMs: 0,
    },
  });
  return { clock, client, events, logDir, service, summaryCalls };
}
const say = (service, source, text) =>
  service.onFinal({
    text,
    source,
    timestamp: Date.now(),
    speaker: source === "system" ? "system:1" : undefined,
  });

test("only worthwhile segments reach D1, partials and chatter never do, and the log records each decision", async () => {
  const { clock, client, events, logDir, service } = setup();
  service.onPartial({ source: "system", text: "what was" });
  service.onPartial({ source: "system", text: "what was the revenue" });
  say(service, "system", "Yeah.");
  say(service, "system", "Thanks everyone for joining today.");
  await clock.advance(5000);
  // "Yeah." never reaches D1; the 5-word pleasantry does (one gate call) and D1 says wait.
  assert.equal(client.calls.length, 1);
  assert.equal(service.stats().byKind.wait, 1);

  say(service, "system", "What was the revenue for the last quarter?");
  await clock.advance(5000);
  assert.equal(client.calls.length, 2, "one call per decision");
  const stats = service.stats();
  assert.equal(stats.decisions, 2);
  assert.equal(stats.byKind.run, 1);
  assert.equal(stats.scheduler.partialsIgnored, 2);
  assert.equal(stats.scheduler.skipped.filler, 1);
  assert.ok(events.some((e) => e.type === "open"));
  const decision = events.filter((e) => e.type === "decision").at(-1);
  assert.equal(decision.decision.kind, "run");
  assert.equal(decision.decision.deliverable, "quick_answer");

  const lines = fs
    .readFileSync(path.join(logDir, "copilot-decisions.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    lines.map((l) => l.type),
    ["session_start", "decision", "decision"]
  );
  assert.match(lines[2].newText, /revenue/);
});

test("D1 only sees text it has not judged yet; the previous run becomes a card the next call knows about", async () => {
  const { clock, client, service } = setup();
  say(service, "system", "What was the revenue for the last quarter?");
  await clock.advance(1500);
  const before = client.calls.length;
  say(service, "system", "And what about the quarter before that one?");
  await clock.advance(10_000);
  const second = client.calls.slice(before).find((c) => "act" in c.questions);
  assert.deepEqual(second.state.new_text, ["OTHER-1: And what about the quarter before that one?"]);
  assert.ok(second.state.context?.some((l) => l.includes("revenue")));
  assert.ok(second.state.cards?.[0].startsWith("quick_answer:"));
  assert.ok(
    "relation" in second.questions,
    "a recent card makes the relation question worth asking"
  );
});

test("the rolling summary replaces old transcript in what D1 reads", async () => {
  const { clock, client, events, service, summaryCalls } = setup();
  for (let i = 0; i < 8; i++)
    say(service, i % 2 ? "mic" : "system", `Filler discussion number ${i} about nothing much`);
  await clock.advance(100);
  assert.ok(summaryCalls.length >= 1);
  assert.ok(events.some((e) => e.type === "summary"));
  say(service, "system", "Which vendor did we pick, again?");
  await clock.advance(2000);
  const gateCall = client.calls.find((c) => "act" in c.questions);
  assert.equal(gateCall.state.summary, "Short summary of the meeting so far.");
  assert.ok((gateCall.state.context ?? []).length <= 2);
});

test("a decision is logged and ending the session logs stats", async () => {
  const { clock, events, logDir, service } = setup();
  say(service, "mic", "What is the capital of France?");
  await clock.advance(1000);
  assert.ok(events.some((e) => e.type === "decision"));
  service.endSession();
  const last = fs
    .readFileSync(path.join(logDir, "copilot-decisions.jsonl"), "utf8")
    .trim()
    .split("\n")
    .pop();
  assert.equal(JSON.parse(last).type, "session_end");
});

test("during the card cooldown nothing is judged and the text is kept for the next call", async () => {
  const { clock, client, service } = setup({ COPILOT_SIM_JOB_MS: "1" }); // no analysis running to replace
  say(service, "system", "What was the revenue for the last quarter?");
  await clock.advance(1500);
  const calls = client.calls.length;
  say(service, "system", "And what about the quarter before that one?");
  await clock.advance(3000); // inside the 8 s cooldown
  assert.equal(client.calls.length, calls, "no D1 call during the cooldown");
  assert.equal(service.stats().scheduler.deferrals >= 1, true);
  await clock.advance(10_000);
  const gate = client.calls.slice(calls).find((c) => "act" in c.questions);
  assert.deepEqual(gate.state.new_text, ["OTHER-1: And what about the quarter before that one?"]);
});

test("while the user is speaking judging others' words waits", async () => {
  const { clock, client, service } = setup();
  service.onPartial({ source: "mic", text: "so I think we should" });
  say(service, "system", "What was the revenue for the last quarter?");
  await clock.advance(2000);
  assert.equal(client.calls.length, 0);
  service.onPartial({ source: "mic", text: "" });
  await clock.advance(3000);
  assert.ok(client.calls.length >= 1);
});

test("the panel opens when note taking begins, but D1 is not called until speech arrives", async () => {
  const { clock, client, events, service } = setup();
  service.begin();
  service.begin(); // idempotent
  assert.equal(events.filter((e) => e.type === "open").length, 1);
  await clock.advance(10_000);
  assert.equal(client.calls.length, 0);
  say(service, "system", "What was the revenue for the last quarter?");
  await clock.advance(5000);
  assert.ok(client.calls.length >= 1);
  assert.equal(events.filter((e) => e.type === "open").length, 1, "no second session");
});

test("COPILOT_LOG=1 writes a full per-session trace; off by default", async () => {
  const off = setup();
  say(off.service, "system", "What was the revenue for the last quarter?");
  await off.clock.advance(5000);
  assert.equal(fs.existsSync(path.join(off.logDir, "sessions")), false);

  const { clock, logDir, service } = setup({ COPILOT_LOG: "1" });
  service.onPartial({ source: "mic", text: "so" });
  service.onPartial({ source: "mic", text: "" });
  say(service, "system", "What was the revenue for the last quarter?");
  await clock.advance(5000);
  const dir = path.join(logDir, "sessions");
  const [file] = fs.readdirSync(dir);
  const types = fs
    .readFileSync(path.join(dir, file), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l).type);
  for (const t of ["user_speaking", "segment", "d1", "decision"]) assert.ok(types.includes(t), t);
});

test("while an analysis runs, new text is judged against it even inside the cooldown", async () => {
  const { clock, client, logDir, service } = setup({ COPILOT_LOG: "1" });
  say(service, "system", "What was the revenue for the last quarter?");
  await clock.advance(1500);
  const before = client.calls.length;
  say(service, "system", "Sorry, I meant the revenue for the whole year?");
  await clock.advance(3000); // inside the 8 s cooldown, simulated job still running
  const check = client.calls
    .slice(before)
    .find((c) => "relation" in c.questions && !("act" in c.questions));
  assert.ok(check, "checked against the running analysis during the cooldown");
  assert.deepEqual(Object.keys(check.questions).sort(), ["asked_of_assistant", "relation"]);
  assert.ok(check.state.running?.[0].startsWith("j1:"));
  const [file] = fs.readdirSync(path.join(logDir, "sessions"));
  const types = fs
    .readFileSync(path.join(logDir, "sessions", file), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l).type);
  assert.ok(types.includes("job_start"));
});

test("filler in a batch does not push the real words out of what D1 reads", async () => {
  const { clock, client, service } = setup();
  say(service, "system", "What was the revenue for the last quarter?");
  for (const w of ["Yeah.", "Hmm.", "Okay.", "Right."]) say(service, "mic", w);
  await clock.advance(5000);
  const gate = client.calls.find((c) => "act" in c.questions);
  assert.deepEqual(gate.state.new_text, ["OTHER-1: What was the revenue for the last quarter?"]);
});

test("a cooldown update check that finds nothing costs one small call and keeps the text pending", async () => {
  const { clock, client, service } = setup();
  say(service, "system", "What was the revenue for the last quarter?");
  await clock.advance(1500);
  const before = client.calls.length;
  say(service, "system", "And what about the quarter before that one?");
  await clock.advance(2600); // cooldown, job running, nothing changes
  const calls = client.calls.slice(before);
  assert.equal(calls.length, 1, "one small call");
  assert.ok("relation" in calls[0].questions && !("act" in calls[0].questions));
  await clock.advance(10_000); // cooldown over: the same text is judged properly
  const gate = client.calls.slice(before).find((c) => "act" in c.questions);
  assert.deepEqual(gate.state.new_text, ["OTHER-1: And what about the quarter before that one?"]);
});

test("a weak proactive card stops counting as handled after the short memory, a sure one lasts", async () => {
  const run = async (conf) => {
    const { clock, client, service } = setup({ COPILOT_SIM_JOB_MS: "1" });
    const orig = client.systemOne;
    client.systemOne = async (req) => {
      const out = await orig(req);
      if (req.questions.act) out.answers.act = N(conf);
      if (req.questions.chatter) out.answers.chatter = N(0);
      if (req.questions.help) out.answers.help = N(1);
      return out;
    };
    say(service, "system", "What was the revenue for the last quarter?");
    await clock.advance(1500);
    await clock.advance(40_000); // past the weak memory (30 s), inside the full one (120 s)
    say(service, "system", "And what about the quarter before that one?");
    await clock.advance(3000);
    return client.calls.filter((c) => "act" in c.questions).at(-1).state.cards?.length ?? 0;
  };
  assert.equal(await run(0.5), 0);
  assert.equal(await run(0.95), 1);
});

test("each meeting gets its own trace file, and an answer that lands after the end is dropped", async () => {
  const { clock, logDir, service } = setup({ COPILOT_LOG: "1" });
  say(service, "system", "What was the revenue for the last quarter?");
  await clock.advance(5000);
  service.endSession();
  await clock.advance(1000);
  service.begin();
  say(service, "system", "Which vendor did we pick for the project?");
  await clock.advance(5000);
  const dir = path.join(logDir, "sessions");
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 2);
  for (const f of files) {
    const rows = fs
      .readFileSync(path.join(dir, f), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(rows.filter((r) => r.type === "session_start").length, 1);
    assert.equal(new Set(rows.map((r) => r.session)).size, 1);
  }
});

test("a job's topic is the whole question even when the recogniser cut it mid-word", async () => {
  const { clock, logDir, service } = setup({ COPILOT_LOG: "1" });
  say(service, "mic", "What about the benchmarks, OpenAI or Anth");
  say(service, "mic", "ropic?");
  await clock.advance(5000);
  const dir = path.join(logDir, "sessions");
  const rows = fs
    .readFileSync(path.join(dir, fs.readdirSync(dir)[0]), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.match(rows.find((r) => r.type === "job_start").topic, /OpenAI or Anth ropic\?/);
});

// ---- real main-model cards (an injected model; no network) ----
function fakeMain() {
  const calls = [];
  const fn = ({ messages, tier, web, model, signal, onDelta }) =>
    new Promise((resolve, reject) => {
      const call = { messages, tier, web, model, aborted: false, finish: null };
      calls.push(call);
      signal.addEventListener("abort", () => {
        call.aborted = true;
        reject(new Error("aborted"));
      });
      call.finish = (text = "TITLE: Answer\nIt is 4%.\nCONFIDENCE: high") => {
        onDelta(text);
        resolve({ text, sources: [], usage: null, firstTokenMs: 5, totalMs: 9 });
      };
    });
  fn.calls = calls;
  return fn;
}

test("a run decision starts a real card that stays 'running' for D1 until it finishes", async () => {
  const main = fakeMain();
  const { clock, client, events, service } = setup({}, main);
  say(service, "system", "What was the revenue for the last quarter?");
  await clock.advance(1500);
  assert.equal(main.calls.length, 1);
  assert.equal(main.calls[0].tier, "fast");
  assert.equal(main.calls[0].web, false, "quick answers do not search unless the setting is on");
  assert.match(main.calls[0].messages[1].content, /revenue for the last quarter/);
  assert.ok(
    !events.some((e) => e.type === "card_start"),
    "a proactive card without web shows once it is done"
  );

  // While it runs, D1 is told about the running job.
  say(service, "system", "And what about the quarter before that one?");
  await clock.advance(1500);
  assert.ok(client.calls.at(-1).state.running?.[0].startsWith("j1"));

  main.calls[0].finish();
  await clock.advance(10);
  const done = events.find((e) => e.type === "card_done");
  assert.equal(done.title, "Answer");
  assert.equal(done.confidence, "high");
  assert.ok(events.some((e) => e.type === "card_start"));
  // Finished: nothing is running any more.
  say(service, "system", "Can you explain the fiscal calendar to me?");
  await clock.advance(12_000);
  assert.equal(client.calls.at(-1).state.running, undefined);
});

test("a replaced analysis is aborted and its card cancelled; ending the meeting aborts the rest", async () => {
  const main = fakeMain();
  const { clock, events, service } = setup({}, main);
  say(service, "system", "What was the revenue for the last quarter?");
  await clock.advance(1500);
  say(service, "system", "Sorry, I meant the revenue for the whole year?");
  await clock.advance(1500);
  assert.equal(main.calls.length, 2);
  assert.equal(main.calls[0].aborted, true);
  assert.ok(events.some((e) => e.type === "card_cancel" && e.id === "j1"));
  service.endSession();
  assert.equal(main.calls[1].aborted, true);
});

test("a typed question skips D1 and goes straight to the main model", async () => {
  const main = fakeMain();
  const { client, events, service } = setup({}, main);
  assert.ok(service.ask({ text: "What does ARR mean?", web: false }));
  assert.equal(client.calls.length, 0);
  assert.equal(main.calls.length, 1);
  assert.equal(main.calls[0].web, false, "web search is off by default");
  assert.match(main.calls[0].messages[0].content, /asked you directly/);
  main.calls[0].finish();
  await new Promise((r) => setImmediate(r));
  assert.ok(events.some((e) => e.type === "card_done"));
  assert.equal(setup().service.ask({ text: "x" }), false); // no main model: nothing to ask
});

const tick = () => new Promise((r) => setImmediate(r));

test("custom threads run typed questions in parallel; a full cap queues the next one, Main first", async () => {
  const main = fakeMain();
  const { events, service } = setup({}, main, { getSettings: () => ({ maxParallel: 2 }) });
  const t1 = service.createThread({ title: "Pricing" });
  service.ask({ text: "one", threadId: t1 });
  service.ask({ text: "two", threadId: t1 });
  service.ask({ text: "three", threadId: t1 });
  service.ask({ text: "four from main" });
  assert.equal(main.calls.length, 2, "two run, two wait");
  assert.equal(events.filter((e) => e.type === "card_queued").length, 2);
  main.calls[0].finish();
  await tick();
  assert.equal(main.calls.length, 3);
  assert.match(
    main.calls[2].messages[1].content,
    /four from main/,
    "Main goes before the older thread question"
  );
  const done = events.find((e) => e.type === "card_done");
  assert.equal(done.threadId, t1);
});

test("a thread keeps its own history; closing it cancels its work", async () => {
  const main = fakeMain();
  const { events, service } = setup({}, main);
  const t = service.createThread({});
  service.ask({ text: "first", threadId: t });
  main.calls[0].finish();
  await tick();
  service.ask({ text: "second", threadId: t });
  assert.match(main.calls[1].messages[1].content, /Earlier cards in this thread/);
  service.ask({ text: "in main" });
  assert.doesNotMatch(main.calls[2].messages[1].content, /Earlier cards in this thread/);
  assert.equal(service.closeThread(t), true);
  assert.equal(main.calls[1].aborted, true);
  assert.ok(events.some((e) => e.type === "thread" && e.action === "close"));
  assert.equal(service.closeThread("main"), false);
});

test("quote, standing instructions, plan and reference files reach the main model's context", () => {
  const main = fakeMain();
  const { service } = setup({}, main, {
    getSettings: () => ({ instructions: "Answer in French.", plan: "Goal: close the deal" }),
    getReference: () => "FILE pricing.md\nStarter costs 10 USD",
  });
  service.ask({ text: "What do you think?", quote: "we could cut the price" });
  const user = main.calls.at(-1).messages[1].content; // the plan also started a "before the meeting" card
  assert.match(user, /we could cut the price/);
  assert.match(user, /Answer in French/);
  assert.match(user, /Goal: close the deal/);
  assert.match(user, /Starter costs 10 USD/);
});

test("a plan makes a 'before the meeting' card at the start; the end brings a recap card", async () => {
  const main = fakeMain();
  const { events, service } = setup({}, main, {
    getSettings: () => ({ plan: "Goal: close the deal" }),
  });
  service.begin();
  assert.equal(main.calls.length, 1);
  assert.equal(events.find((e) => e.type === "card_start").label, "Before the meeting");
  main.calls[0].finish();
  await tick();
  for (let i = 0; i < 6; i++)
    say(service, "system", `Statement number ${i} about the project plan and the budget.`);
  service.endSession();
  assert.equal(main.calls.length, 2);
  assert.match(main.calls[1].messages[1].content, /Wrap up this meeting/);
  main.calls[1].finish();
  await tick();
  const recap = events.filter((e) => e.type === "card_done").at(-1);
  assert.equal(recap.threadId, "main");
  assert.equal(events.filter((e) => e.type === "card_start").at(-1).label, "Meeting recap");
});

test("no recap for a meeting that barely happened, or when the user turned it off", () => {
  const main = fakeMain();
  const a = setup({}, main);
  a.service.begin();
  say(a.service, "system", "Hello there.");
  a.service.endSession();
  assert.equal(main.calls.length, 0);
  const b = setup({}, main, { getSettings: () => ({ endRecap: false }) });
  for (let i = 0; i < 8; i++)
    say(b.service, "system", `Line ${i} of a long enough meeting about things.`);
  b.service.endSession();
  assert.equal(main.calls.length, 0);
});

test("without any key the engine only keeps the transcript", async () => {
  const events = [];
  const clock = fakeClock();
  const service = createEngine({
    env: {},
    panel: { send: (e) => events.push(e) },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  service.onFinal({ text: "What was the revenue for the last quarter?", source: "system" });
  await clock.advance(5000);
  assert.ok(events.some((e) => e.type === "segment"));
  assert.ok(!events.some((e) => e.type === "decision"));
  assert.equal(events.find((e) => e.type === "session").active, false);
  assert.equal(service.ask({ text: "hi" }), false);
});

const IDEAS = (o) => ({ text: JSON.stringify(o) });
function ideaSetup(reply, settings = {}) {
  const main = fakeMain();
  const replies = [].concat(reply);
  const ctx = setup({}, main, { getSettings: () => ({ quiet: "chatty", ...settings }) });
  return { main, ...ctx, replies };
}

test("Rerun with high effort asks the same thing again on the deep model with web search, as a new card", async () => {
  const main = fakeMain();
  const { events, service } = setup({ COPILOT_DEEP_MODEL: "anthropic/claude-sonnet-5.5" }, main);
  const id = service.ask({ text: "What does ARR mean?" });
  main.calls[0].finish();
  await new Promise((r) => setImmediate(r));
  const again = service.rerun(id);
  assert.ok(again && again !== id);
  const call = main.calls[1];
  assert.equal(call.tier, "deep");
  assert.equal(call.web, true);
  assert.equal(call.model, "anthropic/claude-sonnet-5.5");
  assert.doesNotMatch(
    call.messages[1].content,
    /Earlier cards in this thread/,
    "the card being redone is not shown to it"
  );
  const start = events.find((e) => e.type === "card_start" && e.id === again);
  assert.equal(start.deep, true);
  assert.equal(start.of, id);
  assert.equal(service.rerun("nope"), false);
});

test("a refused key or empty account is reported once, and cleared when a call works again", async () => {
  let fail = true;
  const ok = fakeD1();
  const client = {
    calls: [],
    async systemOne(req) {
      if (fail)
        throw Object.assign(new Error("Liquid 402: Insufficient credits"), {
          code: "http",
          status: 402,
        });
      return ok.systemOne(req);
    },
  };
  const { clock, events, service } = setup({}, fakeMain(), { client });
  say(service, "system", "What was the revenue for the last quarter?");
  await clock.advance(3000);
  say(service, "system", "And what about the quarter before that one?");
  await clock.advance(6000);
  const problems = () => events.filter((e) => e.type === "problem");
  assert.deepEqual(
    problems().map((e) => e.kind),
    ["credits"],
    "reported once, not per call"
  );
  fail = false;
  say(service, "system", "Can you explain the fiscal calendar to me please?");
  await clock.advance(6000);
  assert.deepEqual(
    problems().map((e) => e.kind),
    ["credits", null]
  );
});

// D1 that finds every moment only mildly interesting: below the bar, so nothing runs by itself.
const lukewarmD1 = (act = 0.3) => ({
  async systemOne({ questions }) {
    const answers = { asked_of_assistant: N(0.05) };
    if ("act" in questions) {
      answers.act = N(act);
      answers.chatter = N(0);
      answers.help = N(1);
      answers.complete = N(0.95);
      answers.kind = {
        type: "choice",
        choice: "quick_answer",
        confidence: 0.9,
        probabilities: probs(KINDS, "quick_answer", 0.9),
      };
    }
    return { answers, inputTokens: 100, ms: 20 };
  },
});

test("a moment below the bar goes to the Skipped box and one tap asks it", async () => {
  const main = fakeMain();
  const { clock, events, service } = setup({}, main, { client: lukewarmD1() });
  say(service, "system", "Could we move the launch to the first week of March instead?");
  await clock.advance(3000);
  assert.equal(main.calls.length, 0, "below the bar: no card");
  const shown = events.filter((e) => e.type === "skipped").at(-1);
  assert.equal(shown.items.length, 1);
  assert.match(shown.items[0].line, /first week of March/);

  service.ask({ text: shown.items[0].line, skippedId: shown.items[0].id });
  assert.equal(main.calls.length, 1);
  assert.deepEqual(events.filter((e) => e.type === "skipped").at(-1).items, []);
});

test("small talk below the bar is not offered as skipped", async () => {
  const { clock, events, service } = setup({}, fakeMain(), { client: lukewarmD1(0.05) });
  say(service, "system", "Thanks everyone for joining us today, it is good to see you.");
  await clock.advance(3000);
  assert.equal(events.filter((e) => e.type === "skipped").length, 0);
});

test("a closing phrase late in the call makes one card of lines to say aloud", async () => {
  const main = fakeMain();
  const { clock, events, service } = setup({}, main, { client: lukewarmD1(0.05) });
  for (let i = 0; i < 14; i++)
    say(service, "system", `We keep talking about item number ${i} here.`);
  await clock.advance(200);
  assert.equal(main.calls.length, 0, "nothing closes a call that is going on");
  say(service, "system", "Okay, let's wrap this up, thanks everyone for your time.");
  assert.equal(main.calls.length, 1);
  assert.match(main.calls[0].messages[0].content, /out loud/i);
  assert.ok(events.some((e) => e.type === "card_start" && e.label === "Wrapping up"));
  say(service, "system", "Any other questions before we go, thanks everyone for joining.");
  assert.equal(main.calls.length, 1, "not again within a few minutes");
});

test("a greeting at the start of the call is not a closing", async () => {
  const main = fakeMain();
  const { service } = setup({}, main, { client: lukewarmD1(0.05) });
  say(service, "system", "Hi everyone, thanks everyone for joining, good day to you all.");
  assert.equal(main.calls.length, 0);
});

test("the calendar end time brings the closing card", async () => {
  const main = fakeMain();
  const { clock, service } = setup({}, main, { client: lukewarmD1(0.05) });
  for (let i = 0; i < 14; i++)
    say(service, "system", `We keep talking about item number ${i} here.`);
  service.setMeeting({ endsAt: clock.now() + 60_000 });
  say(service, "system", "One more point about the schedule please.");
  assert.equal(main.calls.length, 1);
});

test("per-meeting memory stays bounded however long the meeting runs", async () => {
  const main = fakeMain();
  const { clock, service } = setup({ COPILOT_QUIET: "quiet" }, main, { client: lukewarmD1(0.05) });
  for (let i = 0; i < 400; i++) {
    service.ask({ text: `Question number ${i} about something different` });
    main.calls.at(-1)?.finish?.();
    if (i % 20 === 0) await clock.advance(50);
  }
  await clock.advance(1000);
  const m = service.memory();
  assert.ok(m.asked <= 150, `asked ${m.asked}`);
  assert.ok(m.specs <= 60, `specs ${m.specs}`);
  assert.ok(m.threads[0] <= 24, `thread answers ${m.threads[0]}`);
  assert.ok(m.side === 0);
});

test("partials reach the window a few times a second, not on every word", async () => {
  const { clock, events, service } = setup({}, fakeMain(), { client: lukewarmD1(0.05) });
  for (let i = 0; i < 40; i++) service.onPartial({ source: "system", text: "word ".repeat(i + 1) });
  await clock.advance(1000);
  const seen = events.filter((e) => e.type === "partial");
  assert.ok(seen.length <= 2, `${seen.length} partial events`);
  assert.match(seen.at(-1).text, /word word/);
  service.onPartial({ source: "system", text: "" });
  assert.equal(events.filter((e) => e.type === "partial").at(-1).text, "");
});

test("a final still in flight when the meeting stops does not open a new meeting", async () => {
  const { clock, events, service } = setup({}, fakeMain(), { client: lukewarmD1(0.05) });
  say(service, "system", "We are talking about the quarterly plan for the team.");
  service.endSession();
  const starts = () => events.filter((e) => e.type === "session" && e.state === "start").length;
  assert.equal(starts(), 1);
  say(service, "system", "A late straggler from the pending finals queue.");
  service.onPartial({ source: "system", text: "late" });
  assert.equal(starts(), 1, "ignored");
  await clock.advance(6000);
  service.begin(); // an explicit start always works
  assert.equal(starts(), 2);
});

// ---- project search (src/copilot/rag)
function fakeRag({ index = true } = {}) {
  const calls = { prefetch: [], retrieve: [] };
  return {
    calls,
    hasIndex: () => index,
    catalog: () =>
      "The USER's project files (what each holds):\n- contract.pdf: Master services contract",
    prefetch: (q) => calls.prefetch.push(q),
    retrieve: async (o) => (
      calls.retrieve.push(o),
      {
        text: "Passages from the USER's project files:\n\n[contract.pdf · p.4]\nRefunds within 14 days.",
        used: [{ file: "contract.pdf", where: "p.4", score: 0.8 }],
        skipped: null,
        ms: 12,
      }
    ),
  };
}

test("a typed question searches the project first, then the model gets the passages and the file catalog", async () => {
  const main = fakeMain();
  const rag = fakeRag();
  const { events, service } = setup({}, main, { rag });
  service.ask({ text: "What is the refund period?" });
  assert.equal(main.calls.length, 0, "the model waits for the passages");
  await tick();
  assert.equal(rag.calls.retrieve.length, 1);
  assert.equal(rag.calls.retrieve[0].deep, false);
  assert.equal(main.calls.length, 1);
  const user = main.calls[0].messages[1].content;
  assert.match(user, /Refunds within 14 days/);
  assert.match(user, /contract\.pdf: Master services contract/);
  main.calls[0].finish();
  await tick();
  assert.deepEqual(events.find((e) => e.type === "card_done").files, ["contract.pdf"]);
});

test("without any indexed file nothing is searched and the model is called at once", () => {
  const main = fakeMain();
  const rag = fakeRag({ index: false });
  const { service } = setup({}, main, { rag });
  service.ask({ text: "What is the refund period?" });
  assert.equal(main.calls.length, 1);
  assert.equal(rag.calls.retrieve.length, 0);
  assert.doesNotMatch(main.calls[0].messages[1].content, /project files/);
});

test("the decider is asked about the project only when files exist; its yes starts a search, its no does not", async () => {
  const main = fakeMain();
  const rag = fakeRag();
  const { clock, client, service } = setup({}, main, { rag });
  say(service, "system", "What does the contract say about the refund period?");
  await clock.advance(5000);
  assert.ok("needs_project" in client.calls[0].questions);
  assert.equal(rag.calls.prefetch.length, 1, "the embedding is warmed while the decider runs");
  assert.match(rag.calls.prefetch[0], /refund period/);
  await tick();
  assert.equal(rag.calls.retrieve.length, 1);
  assert.match(main.calls[0].messages[1].content, /Refunds within 14 days/);
  main.calls[0].finish();
  await tick();
  await clock.advance(30000);
  say(service, "system", "What was the revenue for the last quarter?");
  await clock.advance(5000);
  await tick();
  assert.equal(
    rag.calls.retrieve.length,
    2,
    "an unasked look is made for every card (no model call)"
  );
  assert.equal(rag.calls.retrieve[1].why, "auto");
  assert.ok(rag.calls.retrieve[1].minScore > 0, "but it only counts when the match is close");
  assert.match(
    main.calls.at(-1).messages[1].content,
    /contract\.pdf: Master services contract/,
    "but the catalog is there"
  );

  const none = setup({}, fakeMain(), { rag: fakeRag({ index: false }) });
  say(none.service, "system", "What does the contract say about the refund period?");
  await none.clock.advance(5000);
  assert.equal("needs_project" in none.client.calls[0].questions, false);
});

test("Rerun with high effort searches deeper, with other wordings of the question", async () => {
  const main = fakeMain();
  const rag = fakeRag();
  const { service } = setup({}, main, { rag });
  const id = service.ask({ text: "What is the refund period?" });
  await tick();
  main.calls[0].finish();
  await tick();
  service.rerun(id);
  await tick();
  const deep = rag.calls.retrieve.at(-1);
  assert.equal(deep.deep, true);
  assert.equal(deep.why, "rerun");
  assert.equal(typeof deep.expand, "function");
  assert.equal(main.calls.at(-1).tier, "deep");
});

test("feedback goes to the behaviour guide as signals, and the learned guide rides in every prompt", async () => {
  const main = fakeMain();
  const signals = [];
  const { clock, events, service } = setup({}, main, {
    getSettings: () => ({ behavior: "- Leave out basic definitions." }),
    onSignal: (kind, line) => signals.push([kind, line]),
  });
  say(service, "system", "What was the revenue for the last quarter?");
  await clock.advance(5000);
  assert.match(main.calls[0].messages[1].content, /applies to every project and meeting/);
  assert.match(main.calls[0].messages[1].content, /Leave out basic definitions/);
  main.calls[0].finish();
  await tick();
  const id = events.find((e) => e.type === "card_done").id;
  service.noteFeedback(id, "down");
  service.noteFeedback(id, null);
  assert.deepEqual(
    signals.map((s) => s[0]),
    ["down", "undo"]
  );
  assert.match(signals[0][1], /revenue for the last quarter/);
});

test("a tapped skipped moment is a 'wanted' signal", async () => {
  const main = fakeMain();
  const signals = [];
  const { clock, events, service } = setup({}, main, { onSignal: (k, l) => signals.push([k, l]) });
  say(service, "system", "Honestly I wonder how many levels the reward ladder has in total?");
  await clock.advance(5000);
  const box = events.filter((e) => e.type === "skipped").at(-1);
  if (box?.items?.length) {
    service.ask({ text: box.items[0].line, skippedId: box.items[0].id });
    assert.equal(signals.at(-1)[0], "wanted");
  }
});
