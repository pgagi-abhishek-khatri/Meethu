const test = require("node:test");
const assert = require("node:assert/strict");
const { parseAnswer } = require("../../src/copilot/core/answer/parseAnswer");
const { buildAnswerMessages } = require("../../src/copilot/core/answer/contextPack");
const { createMainModel } = require("../../src/copilot/main/mainCall");
const { createAnswerRunner } = require("../../src/copilot/main/answerRunner");

test("parseAnswer: confidence right after the title, and still streaming", () => {
  assert.deepEqual(parseAnswer("TITLE: X\nCONFIDENCE: low\nGuess."), {
    title: "X",
    body: "Guess.",
    confidence: "low",
    followups: [],
  });
  assert.equal(parseAnswer("TITLE: X\nCONFIDENCE: hi").body, "");
  assert.equal(parseAnswer("TITLE: X\nCONFIDENCE: high\nBody\nmore").body, "Body\nmore");
});

test("parseAnswer: narration before TITLE (web search) is dropped", () => {
  const a = parseAnswer(
    "I'll search for the current rule.\nLet me check.\n\nTITLE: Rule\nBody here.\nCONFIDENCE: high"
  );
  assert.deepEqual(a, { title: "Rule", body: "Body here.", confidence: "high", followups: [] });
  assert.equal(parseAnswer("Still searching…").body, "Still searching…"); // nothing to cut yet
});

test("parseAnswer: full reply", () => {
  const a = parseAnswer("TITLE: Churn rate\nIt is 4%.\nSee the report.\nCONFIDENCE: Medium");
  assert.deepEqual(a, {
    title: "Churn rate",
    body: "It is 4%.\nSee the report.",
    confidence: "medium",
    followups: [],
  });
});

test("parseAnswer: half-streamed reply never shows the confidence line", () => {
  assert.equal(parseAnswer("TITLE: X\nBody text\nCONFI").body, "Body text");
  assert.equal(parseAnswer("TITLE: X\nBody text\nCONFIDENCE:").body, "Body text");
  assert.equal(parseAnswer("TITLE: X\nBody").confidence, null);
  assert.equal(parseAnswer("TIT").body, "TIT"); // title line not finished: shown as it is
});

test("parseAnswer: a reply that ignored the format is a plain body", () => {
  assert.deepEqual(parseAnswer("Just an answer."), {
    title: "",
    body: "Just an answer.",
    confidence: null,
    followups: [],
  });
  assert.equal(parseAnswer("TITLE: T\nBody\n**CONFIDENCE: high**").confidence, "high");
});

test("context pack: order, window and budgets", () => {
  const now = 1_000_000;
  const transcript = [
    { id: 1, source: "system", text: "old line", at: now - 400_000 },
    { id: 2, source: "system", speaker: "system:2", text: "recent line", at: now - 30_000 },
    { id: 3, source: "mic", text: "my line", at: now - 5_000 },
  ];
  const [sys, user] = buildAnswerMessages({
    deliverable: "explanation",
    web: true,
    meeting: { title: "Sync" },
    summary: "Earlier they talked pricing.",
    transcript,
    now,
    contextSeconds: 120,
    thread: [{ title: "T", body: "prev" }],
    focus: "OTHER-2: what is RAG?",
  });
  assert.equal(sys.role, "system");
  assert.match(sys.content, /Explain the term/);
  assert.match(sys.content, /Web search is on/);
  assert.match(sys.content, /CONFIDENCE: <high\|medium\|low>/);
  const u = user.content;
  assert.ok(
    u.indexOf("Meeting: Sync") < u.indexOf("Summary") &&
      u.indexOf("Summary") < u.indexOf("Recent transcript")
  );
  assert.ok(
    u.indexOf("Recent transcript") < u.indexOf("Earlier cards") &&
      u.indexOf("Earlier cards") < u.indexOf("Help with")
  );
  assert.ok(!u.includes("old line")); // outside the 120 s window
  assert.match(u, /OTHER-2: recent line/);
  assert.match(u, /USER: my line/);
});

test("context pack: transcript budget keeps the newest lines; typed asks are not proactive", () => {
  const transcript = Array.from({ length: 50 }, (_, i) => ({
    id: i,
    source: "system",
    text: `line ${i} ${"x".repeat(100)}`,
    at: 1,
  }));
  const [sys, user] = buildAnswerMessages({
    transcript,
    now: 1,
    contextSeconds: 0,
    focus: "why?",
    proactive: false,
    web: false,
    budget: { meeting: 100, summary: 100, transcript: 500, thread: 100, focus: 100 },
  });
  assert.match(user.content, /line 49/);
  assert.ok(!user.content.includes("line 0 "));
  assert.match(user.content, /The USER asks:\nwhy\?/);
  assert.match(sys.content, /cannot search the web/);
  assert.match(sys.content, /asked you directly/);
});

// ---- streaming call ----
const sse = (lines) => ({
  ok: true,
  body: (async function* () {
    for (const l of lines) yield new TextEncoder().encode(l);
  })(),
});
const delta = (content, extra = {}) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content, ...extra } }] })}\n\n`;

test("mainCall: streams, survives chunk splits and comments, collects sources and usage", async () => {
  let req;
  const model = createMainModel({
    apiKey: "k",
    model: "m",
    fetchImpl: async (url, init) => {
      req = { url, body: JSON.parse(init.body) };
      const full =
        delta("TITLE: A\nHel") +
        delta("lo", {
          annotations: [
            { type: "url_citation", url_citation: { url: "https://x.test", title: "X" } },
          ],
        });
      return sse([
        ": OPENROUTER PROCESSING\n\n",
        full.slice(0, 20),
        full.slice(20),
        `data: ${JSON.stringify({ usage: { total_tokens: 9 } })}\n\n`,
        "data: [DONE]\n\n",
      ]);
    },
  });
  const seen = [];
  const r = await model({
    messages: [{ role: "user", content: "hi" }],
    tier: "fast",
    web: true,
    onDelta: (t) => seen.push(t),
  });
  assert.equal(r.text, "TITLE: A\nHello");
  assert.deepEqual(seen, ["TITLE: A\nHel", "TITLE: A\nHello"]);
  assert.deepEqual(r.sources, [{ url: "https://x.test", title: "X", snippet: "" }]);
  assert.equal(r.usage.total_tokens, 9);
  assert.equal(req.body.stream, true);
  assert.deepEqual(req.body.reasoning, { effort: "low" }); // fast tier: low effort (mandatory-reasoning models)
  assert.equal(req.body.tools[0].type, "openrouter:web_search");
  assert.equal(req.body.tools[0].parameters.engine, "exa");
  assert.equal(req.body.max_tool_calls, 2);
});

test("mainCall: reasoning tier keeps default effort, no web tool unless asked; errors have codes", async () => {
  let body;
  const ok = createMainModel({
    apiKey: "k",
    model: "m",
    fetchImpl: async (_u, init) => ((body = JSON.parse(init.body)), sse([delta("x")])),
  });
  await ok({ messages: [], tier: "reasoning" });
  assert.equal("reasoning" in body, false);
  assert.equal("tools" in body, false);
  const bad = createMainModel({
    apiKey: "k",
    model: "m",
    fetchImpl: async () => ({ ok: false, status: 429 }),
  });
  await assert.rejects(bad({ messages: [] }), { code: "http_429" });
  await assert.rejects(createMainModel({ apiKey: "", model: "m" })({ messages: [] }), {
    code: "no_key",
  });
  const mid = createMainModel({
    apiKey: "k",
    model: "m",
    fetchImpl: async () => sse([`data: ${JSON.stringify({ error: { message: "boom" } })}\n\n`]),
  });
  await assert.rejects(mid({ messages: [] }), { code: "stream_error" });
});

// ---- runner ----
test("runner: card events, confidence defaults to low, cancel is silent afterwards", async () => {
  const events = [];
  const model = async ({ onDelta }) => {
    onDelta("TITLE: T\nbo");
    return { text: "TITLE: T\nbody", sources: [], usage: null, firstTokenMs: 10, totalMs: 20 };
  };
  const runner = createAnswerRunner({ model, emit: (e) => events.push(e) });
  const h = runner.run({
    id: "j1",
    deliverable: "quick_answer",
    tier: "fast",
    web: false,
    proactive: false,
    focus: "f",
    context: {},
  });
  const card = await h.done;
  assert.deepEqual(
    events.map((e) => e.type),
    ["card_start", "card_update", "card_done"]
  );
  assert.equal(card.confidence, "low");
  assert.equal(card.body, "body");
  h.cancel(); // already finished: no cancel event
  assert.equal(events.at(-1).type, "card_done");

  events.length = 0;
  let release;
  const slow = createAnswerRunner({
    model: ({ signal }) =>
      new Promise((res, rej) => {
        release = res;
        signal.addEventListener("abort", () => rej(new Error("aborted")));
      }),
    emit: (e) => events.push(e),
  });
  const h2 = slow.run({
    id: "j2",
    deliverable: "quick_answer",
    tier: "fast",
    proactive: true,
    focus: "f",
    context: {},
  });
  h2.cancel();
  assert.equal(await h2.done, null);
  assert.deepEqual(
    events.map((e) => e.type),
    ["card_cancel"]
  ); // never shown (proactive, no words yet); no error event after a cancel
  void release;
});

test("runner: failures and empty answers become card_error", async () => {
  const events = [];
  const fail = createAnswerRunner({
    model: async () => {
      throw Object.assign(new Error("x"), { code: "http_500" });
    },
    emit: (e) => events.push(e),
  });
  await fail.run({ id: "a", proactive: true, focus: "f", context: {} }).done;
  const empty = createAnswerRunner({
    model: async () => ({ text: "TITLE: only", sources: [] }),
    emit: (e) => events.push(e),
  });
  await empty.run({ id: "b", proactive: false, focus: "f", context: {} }).done;
  assert.deepEqual(
    events.filter((e) => e.type === "card_error").map((e) => [e.code, e.proactive]),
    [
      ["http_500", true],
      ["empty", false],
    ]
  );
});

test("parseAnswer: SKIP", () => {
  assert.deepEqual(parseAnswer("SKIP: too unclear"), {
    skip: true,
    reason: "too unclear",
    title: "",
    body: "",
    confidence: null,
  });
  assert.equal(parseAnswer("TITLE: Skipping stones\nbody").skip, undefined);
});

test("runner: a proactive SKIP shows no card; an asked one never skips; web cards show at once", async () => {
  const events = [];
  const skipper = createAnswerRunner({
    model: async ({ onDelta }) => (
      onDelta("SK"),
      onDelta("SKIP: too unclear"),
      { text: "SKIP: too unclear", sources: [] }
    ),
    emit: (e) => events.push(e),
  });
  const r = await skipper.run({ id: "a", proactive: true, web: false, focus: "f", context: {} })
    .done;
  assert.deepEqual(
    events.map((e) => e.type),
    ["card_skip"]
  );
  assert.equal(events[0].shown, false);
  assert.equal(r.skipped, true);

  events.length = 0;
  await skipper.run({ id: "b", proactive: false, focus: "f", context: {} }).done; // asked: the text is the answer
  assert.equal(events[0].type, "card_start"); // asked: shown at once
  assert.ok(!events.some((e) => e.type === "card_skip"));

  events.length = 0;
  await skipper.run({ id: "c", proactive: true, web: true, focus: "f", context: {} }).done;
  assert.deepEqual(
    events.map((e) => e.type),
    ["card_start", "card_skip"]
  );
  assert.equal(events[1].shown, true);
});

test("system prompt: SKIP rule only for proactive cards", () => {
  const { buildSystemPrompt } = require("../../src/copilot/prompts/main");
  assert.match(buildSystemPrompt({ proactive: true }), /SKIP:/);
  assert.doesNotMatch(buildSystemPrompt({ proactive: false }), /reply with exactly "SKIP/);
});

test("runner: a proactive card is shown only when done, and a low one is dropped; asked cards stream", async () => {
  const events = [];
  const mk = (text) =>
    createAnswerRunner({
      model: async ({ onDelta }) => (
        onDelta(text.slice(0, 12)),
        onDelta(text),
        { text, sources: [] }
      ),
      emit: (e) => events.push(e),
    });
  const r = await mk("TITLE: T\nA guess\nCONFIDENCE: low").run({
    id: "a",
    proactive: true,
    web: false,
    focus: "f",
    context: {},
  }).done;
  assert.deepEqual(
    events.map((e) => e.type),
    ["card_skip"]
  );
  assert.equal(r.reason, "low confidence");

  events.length = 0;
  const card = await mk("TITLE: T\nBody\nCONFIDENCE: high").run({
    id: "b",
    proactive: true,
    web: false,
    focus: "f",
    context: {},
  }).done;
  assert.deepEqual(
    events.map((e) => e.type),
    ["card_start", "card_done"]
  ); // no streaming for proactive
  assert.equal(card.body, "Body");

  events.length = 0;
  await mk("TITLE: T\nNo label").run({
    id: "c",
    proactive: true,
    web: false,
    focus: "f",
    context: {},
  }).done;
  assert.deepEqual(
    events.map((e) => e.type),
    ["card_skip"]
  ); // unlabeled = not trusted

  events.length = 0;
  const asked = await mk("TITLE: T\nNot sure.\nCONFIDENCE: low").run({
    id: "d",
    proactive: false,
    web: false,
    focus: "f",
    context: {},
  }).done;
  assert.equal(asked.confidence, "low");
  assert.ok(
    events.some((e) => e.type === "card_update") && events.some((e) => e.type === "card_done")
  );

  events.length = 0;
  await mk("TITLE: T\nBody\nCONFIDENCE: high").run({
    id: "e",
    proactive: true,
    web: true,
    focus: "f",
    context: {},
  }).done;
  assert.equal(events[0].type, "card_start"); // a web card shows "searching" at once
});

test("runner: a proactive talking-points card is not dropped for low confidence, a SKIP still is", async () => {
  const events = [];
  const mk = (text) =>
    createAnswerRunner({ model: async () => ({ text, sources: [] }), emit: (e) => events.push(e) });
  const job = { id: "t", proactive: true, deliverable: "talking_points", focus: "f", context: {} };
  const card = await mk("TITLE: T\n- one\nCONFIDENCE: low").run(job).done;
  assert.equal(card.body, "- one");
  events.length = 0;
  const r = await mk("SKIP: needs private facts").run(job).done;
  assert.equal(r.skipped, true);
});

test("mainCall: DeepSeek's fast tier does not think; a length finish is reported; runner drops a truncated proactive card", async () => {
  let body;
  const ds = createMainModel({
    apiKey: "k",
    model: "deepseek/deepseek-v4.1-flash",
    fetchImpl: async (_u, init) => (
      (body = JSON.parse(init.body)),
      sse([
        delta("TITLE: T\nThe 8"),
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\n`,
      ])
    ),
  });
  const r = await ds({ messages: [], tier: "fast" });
  assert.deepEqual(body.reasoning, { enabled: false });
  assert.equal(r.finishReason, "length");
  const events = [];
  const runner = createAnswerRunner({ model: async () => r, emit: (e) => events.push(e) });
  const res = await runner.run({
    id: "x",
    proactive: true,
    deliverable: "talking_points",
    focus: "f",
    context: {},
  }).done;
  assert.equal(res.reason, "truncated");
  const asked = await runner.run({ id: "y", proactive: false, focus: "f", context: {} }).done;
  assert.equal(asked.truncated, true);
});

test("verifier: a proactive card that adds nothing new is dropped; talking points, asked cards and a failing verifier are not", async () => {
  const { createCardVerifier, buildVerifyState } = require("../../src/copilot/core/answer/verify");
  const mk = (adds, verify) =>
    createAnswerRunner({
      model: async () => ({ text: "TITLE: T\nBody\nCONFIDENCE: high", sources: [] }),
      verify:
        verify ??
        createCardVerifier({
          client: { systemOne: async () => ({ answers: { adds: { type: "noul", noul: adds } } }) },
        }),
      emit: () => {},
    });
  const job = (extra) => ({
    id: "v",
    proactive: true,
    deliverable: "explanation",
    focus: "f",
    context: { transcript: [{ id: 1, source: "system", text: "hello" }] },
    ...extra,
  });
  assert.equal((await mk(0.2).run(job()).done).skipped, true);
  assert.equal((await mk(0.95).run(job()).done).body, "Body");
  assert.equal((await mk(0.2).run(job({ deliverable: "talking_points" })).done).body, "Body");
  assert.equal((await mk(0.2).run(job({ proactive: false })).done).body, "Body");
  const broken = createCardVerifier({
    client: {
      systemOne: async () => {
        throw new Error("down");
      },
    },
  });
  assert.equal((await mk(0, broken).run(job()).done).body, "Body");
  const st = buildVerifyState({
    transcript: [
      { id: 1, source: "system", text: "a" },
      { id: 2, source: "mic", text: "b" },
    ],
    focus: "b",
    card: { title: "T", body: "B" },
  });
  assert.deepEqual(st.context, ["OTHER: a"]);
  assert.equal(st.card, "T: B");
});

test("narration running straight into TITLE on the same line is cut", () => {
  const a = parseAnswer(
    "I'll search for context on this claim.TITLE: NVLink reach\nMeters, not kilometers.\nCONFIDENCE: medium"
  );
  assert.equal(a.title, "NVLink reach");
  assert.equal(a.body, "Meters, not kilometers.");
  assert.equal(a.confidence, "medium");
});

test("parseAnswer: FOLLOWUPS become chips, never body; partial line stays hidden; glued TITLE is cut", () => {
  const a = parseAnswer(
    "TITLE: Rank\n- r=8 is common\n- alpha 2x rank\nFOLLOWUPS: Which layers? | What about QLoRA?\nCONFIDENCE: high"
  );
  assert.equal(a.body, "- r=8 is common\n- alpha 2x rank");
  assert.deepEqual(a.followups, ["Which layers?", "What about QLoRA?"]);
  assert.equal(parseAnswer("TITLE: X\n- a\nFOLLOW").body, "- a");
  assert.equal(parseAnswer("TITLE: X\n- a\nFOLLOWUPS: Which la").body, "- a");
  assert.equal(
    parseAnswer("TITLE: Thread routingTITLE: Routing to threads\n- a").title,
    "Routing to threads"
  );
});

test("mainCall: a model override and the deep tier use the override model, Claude-style native search, no engine pin", async () => {
  let req;
  const fetchImpl = async (_url, init) => {
    req = JSON.parse(init.body);
    return { ok: true, body: new ReadableStream({ start: (c) => c.close() }) };
  };
  const stream = createMainModel({ apiKey: "k", model: "qwen/x", fetchImpl });
  await stream({ messages: [], tier: "deep", web: true, model: "anthropic/claude-sonnet-5.5" });
  assert.equal(req.model, "anthropic/claude-sonnet-5.5");
  assert.deepEqual(req.tools[0].parameters, { max_uses: 2 });
  assert.equal(req.max_tokens, 1200);
  await stream({ messages: [], tier: "fast", web: false });
  assert.equal(req.model, "qwen/x");
  assert.deepEqual(req.reasoning, { enabled: false }, "qwen does not think in the fast tier");
});
