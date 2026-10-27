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
const { classify, checkSize } = require("../../src/copilot/rag/config");
const { parseTimed } = require("../../src/copilot/rag/analyzeClient");
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
  assert.deepEqual(seen, [1, 3]);
});
