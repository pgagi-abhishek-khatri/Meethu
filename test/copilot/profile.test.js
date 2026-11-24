const test = require("node:test");
const assert = require("node:assert/strict");
const {
  profileTargets,
  profileParts,
  parseProfile,
  groundProfile,
  allocate,
  renderForDecider,
  renderForAnswer,
  renderForWriter,
  PROFILE_VERSION,
} = require("../../src/copilot/rag/profile");
const { buildProfile } = require("../../src/copilot/rag/profileBuilder");
const { backfillProfiles } = require("../../src/copilot/rag/profileBackfill");
const { createRetriever } = require("../../src/copilot/rag/retrieve");
const { checkProjectNeed, decide } = require("../../src/copilot/core/decision");

const profile = {
  v: 2,
  brief: "Technical proposal for the CarZilla auction platform (Aug 2026).",
  abstract: "Covers the AWS architecture, the bidding engine and payments.",
  topics: [
    { name: "Live bidding engine", pages: "14-16", covers: "increments, 40 bids/s" },
    { name: "Payments", pages: "37-40", covers: "buyer's premium, card holds" },
  ],
  facts: [
    { text: "Bid increment is AED 500", page: 22 },
    { text: "Card hold is 3% capped at AED 5,000", page: 25 },
  ],
  terms: ["Golden Closing", "me-central-1"],
  useWhen: "scope and pricing questions",
};

test("profile size grows with the file and levels off", () => {
  const small = profileTargets(43);
  const big = profileTargets(258);
  assert.equal(small.facts, 26);
  assert.equal(big.facts, 60);
  assert.ok(big.topics > small.topics && big.abstractWords > small.abstractWords);
  assert.deepEqual(profileTargets(1), { facts: 8, topics: 4, abstractWords: 120, terms: 10 });
  assert.equal(profileTargets(100000).facts, 60);
});

test("a PDF is split by 12-page ranges, other text by size", () => {
  const pdf = Array.from({ length: 30 }, (_, i) => ({ text: `p${i + 1}`, meta: { page: i + 1 } }));
  const parts = profileParts(pdf);
  assert.deepEqual(
    parts.map((p) => [p.from, p.to]),
    [
      [1, 12],
      [13, 24],
      [25, 30],
    ]
  );
  assert.match(parts[1].text, /^\[\[page 13\]\]\np13/);
  const text = Array.from({ length: 5 }, () => ({ text: "x".repeat(30000), meta: {} }));
  assert.equal(profileParts(text).length, 5);
  assert.equal(profileParts(text, { partChars: 70000 }).length, 3);
});

test("parseProfile reads a fenced reply and rejects junk", () => {
  const p = parseProfile(
    "```json\n" +
      JSON.stringify({ ...profile, facts: ["plain fact", { text: "x", page: "7" }] }) +
      "\n```"
  );
  assert.equal(p.brief, profile.brief);
  assert.deepEqual(p.facts, [
    { text: "plain fact", page: null },
    { text: "x", page: 7 },
  ]);
  assert.equal(parseProfile("no json here"), null);
  assert.equal(parseProfile("{}"), null);
});

test("grounding drops facts with numbers the file does not hold, and unknown pages", () => {
  const doc = "Bids rise by AED 500. The hold is 3% capped at AED 5000 per lot.";
  const { profile: p, dropped } = groundProfile(
    {
      ...profile,
      facts: [
        { text: "Bid increment is AED 500", page: 22 },
        { text: "Card hold is 3% capped at AED 5,000", page: 99 },
        { text: "Referral reward is AED 100", page: 6 },
      ],
    },
    doc,
    new Set([22, 25])
  );
  assert.deepEqual(
    p.facts.map((f) => [f.text, f.page]),
    [
      ["Bid increment is AED 500", 22],
      ["Card hold is 3% capped at AED 5,000", null],
    ]
  );
  assert.deepEqual(dropped, [{ text: "Referral reward is AED 100", missing: ["100"] }]);
});

test("budget is split by size with a floor, and every render stays inside its share", () => {
  const share = allocate([{ chunks: 258 }, { chunks: 58 }, { chunks: 43 }], 4000, 300);
  assert.ok(share[0] > share[1] && share[1] > share[2] && share[2] >= 300);
  assert.ok(share.reduce((a, b) => a + b, 0) <= 4000);
  for (const n of [60, 150, 400, 2000]) {
    assert.ok(renderForDecider("a.pdf", profile, n).length <= n, `decider ${n}`);
    assert.ok(renderForAnswer("a.pdf", profile, n).length <= n, `answer ${n}`);
    assert.ok(renderForWriter("a.pdf", profile, n).length <= n, `writer ${n}`);
  }
  const d = renderForDecider("a.pdf", profile, 2000);
  assert.match(d, /covers: Live bidding engine \(p\.14-16\); Payments/);
  assert.match(d, /facts: Bid increment is AED 500 \(p\.22\)/);
  assert.match(renderForAnswer("a.pdf", profile, 2000), /Key facts:\n {3}- Bid increment/);
  assert.match(
    renderForWriter("a.pdf", profile, 2000),
    /words: Live bidding engine, Payments, Golden Closing/
  );
});

test("buildProfile: one call for a short file, map then reduce for a long one", async () => {
  const prompts = [];
  const ask = async (parts, opts) => {
    prompts.push({ text: parts[0].text, opts });
    return { text: JSON.stringify(profile), tokens: 10, cost: 0.001, finish: "stop" };
  };
  const doc = "AED 500 and 3% and AED 5000";
  const short = await buildProfile({
    ask,
    name: "a.pdf",
    kind: "pdf",
    chunks: [{ text: doc, meta: { page: 22 } }],
  });
  assert.equal(short.calls, 1);
  assert.ok(prompts[0].opts.json);
  assert.match(prompts[0].text, /This is the whole file/);
  prompts.length = 0;
  const long = await buildProfile({
    ask,
    name: "a.pdf",
    kind: "pdf",
    chunks: Array.from({ length: 30 }, (_, i) => ({ text: doc, meta: { page: i + 1 } })),
  });
  assert.equal(long.calls, 4); // 3 parts + the merge
  assert.match(prompts.at(-1).text, /Merge them into ONE profile/);
  assert.equal(long.cost, 0.004);
});

test("retriever: profile mode gives each reader its slice; summary mode is unchanged", () => {
  const rows = [
    { name: "big.pdf", kind: "pdf", summary: "Big file. More text.", chunk_count: 258, profile },
    {
      name: "old.pdf",
      kind: "pdf",
      summary: "Old summary only. Second sentence.",
      chunk_count: 10,
      profile: null,
    },
  ];
  const rag = { hasIndex: () => true, catalog: () => rows };
  const summary = createRetriever({ rag, clients: () => null, catalogMode: "summary" });
  assert.deepEqual(summary.catalogLines([1]), ["big.pdf: Big file.", "old.pdf: Old summary only."]);
  const p = createRetriever({ rag, clients: () => null, catalogMode: "profile" });
  const lines = p.catalogLines([1]);
  assert.match(lines[0], /facts: Bid increment is AED 500/);
  assert.match(lines[1], /^old\.pdf: Old summary only\. Second sentence\./); // no profile: its summary
  assert.ok(lines.join("\n").length <= 4000);
  assert.match(p.catalog([1]), /Key facts:/);
  assert.match(p.writerCatalog([1])[0], /Golden Closing/);
});

test("two calls: the card call has no file question; the gate asks only for the files", async () => {
  const seen = [];
  const client = {
    systemOne: async ({ state, questions }) => {
      seen.push({ state, questions: Object.keys(questions) });
      if (questions.needs_project)
        return {
          answers: { needs_project: { type: "noul", noul: 0.8 } },
          inputTokens: 50,
          ms: 400,
        };
      return {
        answers: {
          act: { type: "noul", noul: 0.9 },
          chatter: { type: "noul", noul: 0.05 },
          asked_of_assistant: { type: "noul", noul: 0.01 },
          complete: { type: "noul", noul: 0.9 },
          kind: {
            type: "choice",
            choice: "quick_answer",
            probabilities: { quick_answer: 0.9 },
            confidence: 0.9,
          },
        },
        inputTokens: 100,
        ms: 500,
      };
    },
  };
  const input = {
    transcript: [
      { id: 1, source: "system", speaker: "system:1", text: "What is the bid increment?" },
    ],
    newFromId: 1,
    settings: { projectFiles: true, web: false },
    projectFiles: ["a.pdf: proposal"],
    signals: { endpoint: true },
  };
  const cfg = {
    ...require("../../src/copilot/core/decision").DEFAULT_DECISION_CONFIG,
    ragTrigger: "twoCall",
  };
  const d = await decide({ input, client, cfg });
  assert.equal(d.kind, "run");
  assert.equal(d.needs.project, false);
  assert.ok(!seen[0].questions.includes("needs_project"));
  assert.equal(seen[0].state.project_files, undefined);
  const g = await checkProjectNeed({ input, client, cfg });
  assert.deepEqual(seen[1].questions, ["needs_project"]);
  assert.deepEqual(seen[1].state.project_files, ["a.pdf: proposal"]);
  assert.deepEqual(g, { need: true, p: 0.8, ms: 400, inputTokens: 50, error: null });
  const failed = await checkProjectNeed({
    input,
    client: {
      systemOne: async () => Promise.reject(Object.assign(new Error("x"), { code: "timeout" })),
    },
    cfg,
  });
  assert.equal(failed.need, false);
  assert.equal(failed.error, "timeout");
});

test("backfillProfiles builds profile and profile_v for stale files from stored chunks", async () => {
  const stale = [
    { id: 1, project_id: 10, name: "spec.pdf", kind: "pdf" },
    { id: 2, project_id: 10, name: "notes.txt", kind: "text" },
  ];
  const setFileCalls = [];
  const fakeRag = {
    staleProfiles: (v) => (v === PROFILE_VERSION ? stale : []),
    fileChunks: (fileId) => [
      { text: `Content for file ${fileId} with numbers 100`, meta: { page: 1 } },
    ],
    setFile: (id, patch) => setFileCalls.push({ id, patch }),
  };

  const ask = async () => ({
    text: JSON.stringify({
      brief: "A test document.",
      abstract: "Summary of content.",
      topics: [{ name: "Topic", pages: "1", covers: "Details" }],
      facts: [{ text: "Price is 100", page: 1 }],
      terms: ["Test"],
      useWhen: "testing",
    }),
    tokens: 200,
    cost: 0.002,
    finish: "stop",
  });

  const res = await backfillProfiles({ rag: fakeRag, ask });
  assert.equal(res.done, 2);
  assert.equal(res.failed, 0);
  assert.equal(setFileCalls.length, 2);
  assert.equal(setFileCalls[0].id, 1);
  assert.equal(setFileCalls[0].patch.profile_v, PROFILE_VERSION);
  assert.ok(setFileCalls[0].patch.profile.includes("Price is 100"));
});

test("one failing file is logged and the rest continue in backfillProfiles", async () => {
  const stale = [
    { id: 1, project_id: 10, name: "bad.pdf", kind: "pdf" },
    { id: 2, project_id: 10, name: "good.txt", kind: "text" },
  ];
  const logged = [];
  const setFileCalls = [];
  const fakeRag = {
    staleProfiles: () => stale,
    fileChunks: () => [{ text: "Content with 50", meta: { page: 1 } }],
    setFile: (id, patch) => setFileCalls.push({ id, patch }),
  };

  let callCount = 0;
  const ask = async () => {
    callCount++;
    if (callCount === 1) throw new Error("LLM failure");
    return {
      text: JSON.stringify({
        brief: "Good doc.",
        abstract: "Good abstract.",
        topics: [],
        facts: [{ text: "Value is 50", page: 1 }],
        terms: [],
        useWhen: "testing",
      }),
      tokens: 100,
      cost: 0.001,
      finish: "stop",
    };
  };

  const res = await backfillProfiles({
    rag: fakeRag,
    ask,
    log: (e) => logged.push(e),
  });

  assert.equal(res.done, 1);
  assert.equal(res.failed, 1);
  assert.equal(setFileCalls.length, 1);
  assert.equal(setFileCalls[0].id, 2);
  const failedEvents = logged.filter((e) => e.event === "profile_backfill_failed");
  assert.equal(failedEvents.length, 1);
  assert.equal(failedEvents[0].file_id, 1);
  assert.equal(failedEvents[0].error, "LLM failure");
});
