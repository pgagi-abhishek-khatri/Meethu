const test = require("node:test");
const assert = require("node:assert/strict");
const { chunkText, planWindows, mmss } = require("../../src/copilot/rag/chunker");
const {
  normalize,
  cut,
  topK,
  rrf,
  toBuffer,
  fromBuffer,
} = require("../../src/copilot/rag/vectors");
const { classify, checkSize, RAG } = require("../../src/copilot/rag/config");
const { createAnalyzer, parseTimed } = require("../../src/copilot/rag/analyzeClient");
const { createEmbedClient, mediaPart } = require("../../src/copilot/rag/embedClient");
const { postJson, pool } = require("../../src/copilot/rag/openrouter");
const { ftsQuery } = require("../../src/copilot/rag/ragStore");
const { createRetriever, clean } = require("../../src/copilot/rag/retrieve");

test("text is cut at headings and paragraphs, keeps heading and page, never exceeds the target by much", () => {
  const body = "Our plans start at twenty dollars a month. ".repeat(60);
  const chunks = chunkText(
    `# Pricing\n\n${body}\n\n[[page 2]]\n\n## Onboarding\n\nWe set you up in two days.`
  );
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((c) => c.text.length <= 1100));
  assert.equal(chunks[0].heading, "Pricing");
  assert.ok(
    chunks[0].text.startsWith("# Pricing") && chunks[0].text.length > 100,
    "heading stays with its paragraph"
  );
  const last = chunks.at(-1);
  assert.equal(last.heading, "Onboarding");
  assert.equal(last.page, 2);
});

test("a csv with no blank lines still splits, and tiny files give one chunk", () => {
  const csv = Array.from({ length: 300 }, (_, i) => `row${i},value ${i},plan basic`).join("\n");
  assert.ok(chunkText(csv).length > 3);
  assert.equal(chunkText("one short note").length, 1);
  assert.deepEqual(chunkText("  \n\n "), []);
});

test("media windows overlap, and a short last window folds into the previous one", () => {
  assert.deepEqual(planWindows(125, 60, 10), [
    { start: 0, end: 60 },
    { start: 50, end: 110 },
    { start: 100, end: 125 },
  ]);
  assert.deepEqual(planWindows(66, 60, 0), [{ start: 0, end: 66 }]);
  assert.deepEqual(planWindows(0, 60), []);
  assert.equal(mmss(3725), "1:02:05");
});

test("vectors: cut re-normalises, topK ranks by cosine, rrf merges lists, buffers round trip", () => {
  const v = cut([3, 4, 12], 2);
  assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-6);
  const m = { ids: [10, 20, 30], data: Float32Array.from([1, 0, 0, 1, 0.8, 0.6]) };
  const q = normalize(Float32Array.from([1, 0]));
  assert.deepEqual(
    topK(m, q, 2).map((h) => h.id),
    [10, 30]
  );
  assert.deepEqual(
    rrf([
      [1, 2, 3],
      [3, 1],
    ]).map((x) => x.id),
    [1, 3, 2]
  );
  assert.deepEqual([...fromBuffer(toBuffer(Float32Array.from([1.5, -2])))], [1.5, -2]);
});

test("file types and limits", () => {
  assert.equal(classify("Plan.PDF"), "pdf");
  assert.equal(classify("a.mp4"), "video");
  assert.equal(classify("a.exe"), null);
  assert.equal(checkSize("image", 11 * 1048576).ok, false);
  assert.match(checkSize("image", 11 * 1048576).reason, /10 MB/);
  assert.equal(checkSize("text", 1000).ok, true);
  assert.equal(checkSize("pdf", 0).ok, false);
});

test("timed lines: seconds are counted from the whole file, wrapped lines join", () => {
  assert.deepEqual(parseTimed("[00:05] hello\n[01:10] second\nmore\n[1:02:03] late", 600), [
    { t: 605, text: "hello" },
    { t: 670, text: "second more" },
    { t: 4323, text: "late" },
  ]);
});

test("keyword query: words quoted, punctuation harmless, short words dropped", () => {
  assert.equal(ftsQuery('What is "Oyaara" pricing?'), '"oyaara" OR "pricing"');
  assert.equal(ftsQuery("a b"), "");
  assert.equal(
    clean("USER: hi there OTHER-1: what does Oyaara cost"),
    "hi there what does Oyaara cost"
  );
});

const okFetch =
  (log, dims = 4) =>
  async (url, init) => {
    const body = JSON.parse(init.body);
    log.push({ url, n: body.input.length, dimensions: body.dimensions, first: body.input[0] });
    return {
      ok: true,
      json: async () => ({
        data: body.input.map((_, i) => ({
          index: i,
          embedding: Array.from({ length: dims }, (_, j) => (i + j + 1) / 10),
        })),
        usage: { total_tokens: body.input.length * 5, cost: 0.001 * body.input.length },
      }),
    };
  };

test("embeddings: 250 texts go out in batches of at most 100, in order, worded as documents", async () => {
  const log = [];
  const c = createEmbedClient({ apiKey: "k", dims: 4, fetchImpl: okFetch(log) });
  const r = await c.embedDocs(
    Array.from({ length: 250 }, (_, i) => ({ title: "f.md", text: `t${i}` }))
  );
  assert.equal(r.vectors.length, 250);
  assert.deepEqual(
    log.map((l) => l.n).sort((a, b) => b - a),
    [100, 100, 50]
  );
  assert.equal(log[0].dimensions, 4);
  assert.match(log[0].first, /^title: f\.md \| text: t/);
  assert.equal(r.tokens, 1250);
  assert.ok(Math.abs(Math.hypot(...r.vectors[0]) - 1) < 1e-5);
});

test("embeddings: the same question is embedded once, even asked twice at once; questions are worded as queries", async () => {
  const log = [];
  const c = createEmbedClient({ apiKey: "k", dims: 4, fetchImpl: okFetch(log) });
  const [a, b] = await Promise.all([
    c.embedQueries(["what is the price"]),
    c.embedQueries(["what is the price"]),
  ]);
  assert.equal(log.length, 1);
  assert.match(log[0].first, /^task: search result \| query: what is the price/);
  assert.deepEqual([...a.vectors[0]], [...b.vectors[0]]);
  const again = await c.embedQueries(["what is the price", "second"]);
  assert.equal(log.length, 2);
  assert.equal(again.cached, 1);
});

test("media parts use the shapes OpenRouter accepted", () => {
  assert.equal(mediaPart("image", Buffer.from("x"), "image/png").type, "image_url");
  assert.equal(mediaPart("audio", Buffer.from("x"), "audio/mpeg").input_audio.format, "mp3");
  assert.match(
    mediaPart("video", Buffer.from("x"), "video/mp4").input_video.data,
    /^data:video\/mp4;base64,/
  );
});

test("http: a 429 waits and retries, a 402 fails at once with a code, no key fails first", async () => {
  let calls = 0;
  const slept = [];
  const fetchImpl = async () =>
    ++calls < 3
      ? { ok: false, status: 429, text: async () => "slow down", headers: { get: () => null } }
      : { ok: true, json: async () => ({ fine: true }) };
  const r = await postJson(
    "/x",
    {},
    { apiKey: "k", fetchImpl, sleep: async (ms) => slept.push(ms) }
  );
  assert.deepEqual(r, { fine: true });
  assert.equal(slept.length, 2);
  await assert.rejects(
    postJson(
      "/x",
      {},
      {
        apiKey: "k",
        fetchImpl: async () => ({
          ok: false,
          status: 402,
          text: async () => "",
          headers: { get: () => null },
        }),
        sleep: async () => {},
      }
    ),
    { code: "credits" }
  );
  await assert.rejects(postJson("/x", {}, {}), { code: "no_key" });
});

test("pool never runs more than its limit at once", async () => {
  const p = pool(2);
  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 6 }, () =>
      p.run(async () => {
        peak = Math.max(peak, ++active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      })
    )
  );
  assert.equal(peak, 2);
});

// ---- retrieval with a fake index
function fakeRag(chunks) {
  // chunks: id -> { file, text, meta, vec:[x,y] }
  return {
    hasIndex: () => true,
    catalog: () => [{ name: "pricing.md", kind: "text", summary: "Plans and prices for Oyaara." }],
    keyword: (_p, q) =>
      Object.keys(chunks)
        .map(Number)
        .filter((id) => new RegExp(q.split(" ")[0], "i").test(chunks[id].text)),
    vector: (_p, vec) =>
      Object.entries(chunks)
        .map(([id, c]) => ({ id: Number(id), score: c.vec[0] * vec[0] + c.vec[1] * vec[1] }))
        .sort((a, b) => b.score - a.score),
    chunk: (id) => ({
      id,
      file: chunks[id].file,
      text: chunks[id].text,
      meta: chunks[id].meta ?? {},
    }),
    rrf,
  };
}
const fakeClients =
  (vec = [1, 0], delay = 0) =>
  () => ({
    embed: {
      embedQueries: async (qs) => (
        await new Promise((r) => setTimeout(r, delay)),
        { vectors: qs.map(() => vec), tokens: 1, cost: 0 }
      ),
    },
  });

test("retrieve: strong vector matches come back worded with where they are from; weak ones are dropped", async () => {
  const logs = [];
  const rag = fakeRag({
    1: { file: "pricing.md", text: "Basic costs $20 a month.", meta: { page: 3 }, vec: [1, 0] },
    2: { file: "faq.md", text: "Unrelated holiday policy.", vec: [0.1, 0.9] },
  });
  const r = createRetriever({ rag, clients: fakeClients([1, 0]), log: (x) => logs.push(x) });
  const out = await r.retrieve({ query: "USER: what does the zzzz plan cost", projectIds: [7] });
  assert.match(out.text, /\[pricing\.md · p\.3\]/);
  assert.doesNotMatch(out.text, /holiday/);
  assert.equal(out.used.length, 1);
  assert.equal(logs[0].event, "retrieve");
  assert.equal(logs[0].mode, "hybrid");
  assert.match(r.catalog([7]), /pricing\.md: Plans and prices/);
});

test("retrieve: a slow embedding never holds the answer, an exact keyword still finds the passage", async () => {
  const rag = fakeRag({
    1: { file: "terms.md", text: "Oyaara refunds within 14 days.", vec: [0, 1] },
  });
  const logs = [];
  const r = createRetriever({
    rag,
    clients: fakeClients([1, 0], 200),
    embedWaitMs: 20,
    log: (x) => logs.push(x),
  });
  const out = await r.retrieve({ query: "Oyaara refund policy", projectIds: [1] });
  assert.equal(logs[0].mode, "keyword");
  assert.equal(logs[0].embedError, "slow");
  assert.match(out.text, /14 days/);
});

test("retrieve: a vector that arrives while the query model is still writing is used, not called slow", async () => {
  const chunks = { 1: { file: "a.md", text: "Valkey cache for live bids", vec: [1, 0] } };
  const logs = [];
  const r = createRetriever({
    rag: fakeRag(chunks),
    clients: fakeClients([1, 0], 60), // the vector comes back after embedWaitMs...
    embedWaitMs: 20,
    cfg: { ...RAG, embedGraceMs: 10 },
    log: (x) => logs.push(x),
  });
  const out = await r.retrieve({
    query: "what cache do we use",
    projectIds: [1],
    // ...but before the query model is done
    expand: () => new Promise((res) => setTimeout(() => res(["Valkey cache"]), 100)),
  });
  assert.equal(logs[0].mode, "hybrid");
  assert.equal(logs[0].embedError, null);
  assert.equal(out.used.length, 1);
});

test("retrieve: no index or no key skips without a search; nothing matching says so", async () => {
  const none = createRetriever({
    rag: { ...fakeRag({}), hasIndex: () => false },
    clients: fakeClients(),
  });
  assert.equal((await none.retrieve({ query: "x y z", projectIds: [1] })).skipped, "no_index");
  const rag = fakeRag({ 1: { file: "a.md", text: "banana", vec: [0, 1] } });
  const r = createRetriever({ rag, clients: fakeClients([1, 0]) });
  const out = await r.retrieve({ query: "quarterly revenue", projectIds: [1] });
  assert.equal(out.text, "");
  assert.equal(out.skipped, "below_floor");
});

test("retrieve: a high-effort rerun searches with the extra wordings too, and takes more passages", async () => {
  const chunks = {};
  for (let i = 1; i <= 8; i++)
    chunks[i] = {
      file: `f${i}.md`,
      text: `passage ${i} about pricing`,
      vec: [1 - i * 0.005, 0.01],
    };
  const seen = [];
  const clients = () => ({
    embed: {
      embedQueries: async (qs) => (
        seen.push(qs.length),
        { vectors: qs.map(() => [1, 0]), tokens: 1, cost: 0 }
      ),
    },
  });
  const r = createRetriever({ rag: fakeRag(chunks), clients });
  const fast = await r.retrieve({ query: "pricing", projectIds: [1] });
  const deep = await r.retrieve({
    query: "pricing",
    projectIds: [1],
    deep: true,
    expand: async () => ["plan cost", "monthly fee"],
  });
  assert.equal(fast.used.length, 5);
  assert.equal(deep.used.length, 8);
  assert.equal(deep.queries.length, 3);
  // by default the written queries search by keyword only: no second embedding round trip
  assert.deepEqual(seen, [1, 1]);
  // with embedWritten the moment is embedded on its own (cached by the prefetch in the app), the written ones after it
  const embedding = createRetriever({
    rag: fakeRag(chunks),
    clients,
    cfg: { ...RAG, embedWritten: true },
  });
  await embedding.retrieve({
    query: "pricing",
    projectIds: [1],
    deep: true,
    expand: async () => ["plan cost"],
  });
  assert.deepEqual(seen, [1, 1, 1, 1]);
});

test("retrieve: every card can search with written queries; a slow query model only costs its queries", async () => {
  const chunks = { 1: { file: "a.md", text: "Valkey cache for live bids", vec: [1, 0] } };
  const logs = [];
  const r = createRetriever({
    rag: fakeRag(chunks),
    clients: fakeClients([1, 0]),
    cfg: { ...RAG, queryWaitMs: { fast: 30, deep: 30 } },
    log: (x) => logs.push(x),
  });
  const quick = await r.retrieve({
    query: "OTHER-1: um so what do we use for the cache",
    projectIds: [1],
    expand: async () => ({ queries: ["Valkey cache"], cost: 0.0001 }),
  });
  assert.deepEqual(quick.queries, ["um so what do we use for the cache", "Valkey cache"]);
  assert.equal(quick.used.length, 1);
  const slow = await r.retrieve({
    query: "what do we use for the cache",
    projectIds: [1],
    expand: () => new Promise((res) => setTimeout(() => res(["never used"]), 200)),
  });
  assert.deepEqual(slow.queries, ["what do we use for the cache"]);
  assert.equal(logs[1].expandError, "slow");
  assert.equal(slow.used.length, 1);
  // with no cap (the default) the search waits for the written queries, however long they take
  const waiting = createRetriever({ rag: fakeRag(chunks), clients: fakeClients([1, 0]) });
  const late = await waiting.retrieve({
    query: "what do we use for the cache",
    projectIds: [1],
    expand: () => new Promise((res) => setTimeout(() => res(["Valkey cache"]), 60)),
  });
  assert.deepEqual(late.queries, ["what do we use for the cache", "Valkey cache"]);
});

test("retrieve: a chunk only the keyword search found is scored against the query vector, not dropped", async () => {
  const chunks = {
    1: { file: "a.md", text: "general overview of the platform", vec: [0.8, 0.6] },
    2: { file: "b.md", text: "region ap-south-1 Mumbai", vec: [0.9, 0.436] },
  };
  const rag = {
    ...fakeRag(chunks),
    keyword: (_p, q) => (/mumbai/i.test(q) ? [2] : []),
    vector: () => [{ id: 1, score: 0.6 }], // the vector top k misses chunk 2
    similarity: (_p, ids, vec) =>
      new Map(ids.map((id) => [id, chunks[id].vec[0] * vec[0] + chunks[id].vec[1] * vec[1]])),
  };
  const run = (scoreKeywordHits) =>
    createRetriever({
      rag,
      clients: fakeClients([0.8, 0.6]),
      cfg: { ...RAG, scoreKeywordHits },
    }).retrieve({ query: "which region Mumbai", projectIds: [1] });
  assert.deepEqual(
    (await run(false)).used.map((u) => u.file),
    ["a.md"]
  );
  assert.ok((await run(true)).used.some((u) => u.file === "b.md"));
});

test("query writer lines: list markers go, the digits a query starts with stay", () => {
  const { parseQueryLines } = require("../../src/copilot/rag/queryWriter");
  assert.deepEqual(
    parseQueryLines(
      '32,000 bid cap\n1. 2026 pricing tiers\n2) 3 seats plan\n- "Valkey cache"\n* region ap-south-1\n\u2022 SLA 99.9%\nNONE\n(no query)\n'
    ),
    [
      "32,000 bid cap",
      "2026 pricing tiers",
      "3 seats plan",
      "Valkey cache",
      "region ap-south-1",
      "SLA 99.9%",
    ]
  );
  // a bare number is a query, not a list marker
  assert.deepEqual(parseQueryLines("2026\n10.5 percent margin"), ["2026", "10.5 percent margin"]);
});

test("query writer: a numbered reply keeps every number in the queries it returns", async () => {
  const { createQueryWriter } = require("../../src/copilot/rag/queryWriter");
  const write = createQueryWriter({
    apiKey: "k",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "1. 32,000 bid limit\n2. 500 units per order" } }],
          usage: { total_tokens: 9, cost: 0.0001 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      ),
  });
  const r = await write({ moment: "OTHER-1: is the bid limit 32,000?" });
  assert.deepEqual(r.queries, ["32,000 bid limit", "500 units per order"]);
});

test("retrieve: an unasked look with nothing close never waits for the query model, and aborts it", async () => {
  const chunks = { 1: { file: "a.md", text: "office plants", vec: [0, 1] } };
  let signal = null;
  let calls = 0;
  const r = createRetriever({ rag: fakeRag(chunks), clients: fakeClients([1, 0]) });
  const t0 = Date.now();
  const out = await r.retrieve({
    query: "what is the bid limit",
    projectIds: [1],
    minScore: 0.69,
    expand: (_q, o) => {
      calls++;
      signal = o.signal;
      return new Promise(() => {}); // a query model that never answers
    },
  });
  assert.equal(out.skipped, "weak_match");
  assert.ok(Date.now() - t0 < 500, "returned without waiting for the query model");
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true, "the query model call is aborted");
});

test("retrieve: an unasked look with a close match still uses the written queries", async () => {
  const chunks = { 1: { file: "a.md", text: "Valkey cache for live bids", vec: [1, 0] } };
  const out = await createRetriever({
    rag: fakeRag(chunks),
    clients: fakeClients([1, 0]),
  }).retrieve({
    query: "what cache do we use",
    projectIds: [1],
    minScore: 0.69,
    expand: async () => ["Valkey cache"],
  });
  assert.deepEqual(out.queries, ["what cache do we use", "Valkey cache"]);
  assert.equal(out.used.length, 1);
});

test("retrieve: a capped wait aborts the late query model; no wait timer is left running", async () => {
  const chunks = { 1: { file: "a.md", text: "Valkey cache", vec: [1, 0] } };
  let signal = null;
  const pending = new Set();
  const realSet = global.setTimeout;
  const realClear = global.clearTimeout;
  global.setTimeout = (fn, ms, ...a) => {
    const t = realSet(() => (pending.delete(t), fn(...a)), ms);
    pending.add(t);
    return t;
  };
  global.clearTimeout = (t) => (pending.delete(t), realClear(t));
  try {
    const out = await createRetriever({
      rag: fakeRag(chunks),
      clients: fakeClients([1, 0]),
      cfg: { ...RAG, queryWaitMs: { fast: 20, deep: 20 } },
      embedWaitMs: 5000,
    }).retrieve({
      query: "what cache",
      projectIds: [1],
      expand: (_q, o) => ((signal = o.signal), new Promise(() => {})),
    });
    assert.equal(out.used.length, 1);
    assert.equal(signal.aborted, true);
    // the 5 s embedding wait was the one timer that could outlive the search
    assert.ok(
      ![...pending].some((t) => t._idleTimeout >= 5000),
      "the embedding wait timer was cleared"
    );
  } finally {
    global.setTimeout = realSet;
    global.clearTimeout = realClear;
  }
});

test("summarize sends the full text when under the part limit", async () => {
  const requests = [];
  const fakeFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Full text summary." } }],
        usage: { total_tokens: 100, cost: 0.001 },
      }),
    };
  };

  const analyzer = createAnalyzer({
    apiKey: "dummy",
    fetchImpl: fakeFetch,
    cfg: { ...RAG, summaryPartChars: 100_000 },
  });

  const fullText = "A".repeat(60000) + "END_MARKER";
  const res = await analyzer.summarize({ name: "doc.txt", kind: "text", text: fullText });

  assert.equal(requests.length, 1);
  const promptText = requests[0].messages[0].content[0].text;
  assert.ok(promptText.includes("END_MARKER"), "full text was not truncated at 50k");
  assert.equal(res.summary, "Full text summary.");
  assert.equal(res.tokens, 100);
  assert.equal(res.cost, 0.001);
});

test("summarize on a long file makes N part calls plus one reduce call and returns the reduce output", async () => {
  const requests = [];
  let callCount = 0;
  const fakeFetch = async (_url, init) => {
    callCount++;
    const body = JSON.parse(init.body);
    requests.push(body);
    const content = body.messages[0].content[0].text;
    const isReduce = content.includes("Below are summaries");
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: isReduce ? "Final reduced summary." : `Part ${callCount} summary.`,
            },
          },
        ],
        usage: { total_tokens: 50, cost: 0.0005 },
      }),
    };
  };

  const analyzer = createAnalyzer({
    apiKey: "dummy",
    fetchImpl: fakeFetch,
    cfg: { ...RAG, summaryPartChars: 200 },
  });

  const longText = [
    "# Section 1\n\n" + "Word ".repeat(30),
    "# Section 2\n\n" + "Item ".repeat(30),
    "# Section 3\n\n" + "Fact ".repeat(30),
  ].join("\n\n");

  const res = await analyzer.summarize({ name: "long.md", kind: "text", text: longText });

  // 3 parts + 1 reduce call = 4 calls total
  assert.ok(requests.length >= 3, `expected at least 3 part calls + 1 reduce, got ${requests.length}`);
  const lastRequest = requests[requests.length - 1];
  assert.ok(lastRequest.messages[0].content[0].text.includes("Below are summaries"));
  assert.equal(res.summary, "Final reduced summary.");
  assert.equal(res.tokens, requests.length * 50);
  assert.equal(res.cost, requests.length * 0.0005);
});

