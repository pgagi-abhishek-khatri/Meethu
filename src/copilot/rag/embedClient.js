// Embeddings through OpenRouter (google/gemini-embedding-2). Batches of up to 100 texts, a few requests at
// once, vectors cut to `dims` and re-normalised. Documents and questions are worded differently, as the
// model expects. Every call reports tokens and cost so the log can show what indexing and searching cost.
const { postJson, pool } = require("./openrouter");
const { cut } = require("./vectors");
const { RAG } = require("./config");

function createEmbedClient({
  apiKey,
  model = RAG.embedModel,
  dims = RAG.dims,
  batch = RAG.embedBatch,
  concurrency = RAG.embedConcurrency,
  baseUrl,
  fetchImpl,
  sleep,
  cacheSize = RAG.queryCache,
  queryTimeoutMs = RAG.queryEmbedTimeoutMs,
  queryRetries = 1,
  queryBackoffMs = 200,
} = {}) {
  const slots = pool(concurrency);
  const qslots = pool(2); // live questions never queue behind a file's batches
  const http = { apiKey, baseUrl, fetchImpl, sleep };
  const queries = new Map(); // normalised text -> Promise<Float32Array>, least recently used first
  // Case, spacing and end punctuation never change what is being asked, so they share one cached embedding.
  const norm = (t) =>
    String(t)
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[\s.?!,;:]+$/g, "")
      .trim();
  const touch = (key) => {
    const hit = queries.get(key);
    queries.delete(key);
    queries.set(key, hit);
    return hit;
  };

  const call = (input, lane = slots, limits = {}) =>
    lane.run(async () => {
      const res = await postJson(
        "/embeddings",
        { model, input, dimensions: dims },
        { ...http, ...limits }
      );
      const data = (res.data ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (data.length !== input.length)
        throw Object.assign(new Error("embedding count mismatch"), { code: "bad_response" });
      return {
        vectors: data.map((d) => cut(d.embedding, dims)),
        tokens: res.usage?.total_tokens ?? 0,
        cost: Number(res.usage?.cost) || 0,
      };
    });

  const sum = (parts) => ({
    vectors: parts.flatMap((p) => p.vectors),
    tokens: parts.reduce((a, p) => a + p.tokens, 0),
    cost: parts.reduce((a, p) => a + p.cost, 0),
  });

  return {
    dims,
    model,
    // docs: [{ text, title? }] -> { vectors, tokens, cost }. Split into batches that run side by side.
    async embedDocs(docs) {
      if (!docs.length) return { vectors: [], tokens: 0, cost: 0 };
      const inputs = docs.map((d) => `title: ${d.title || "none"} | text: ${d.text}`);
      const calls = [];
      for (let i = 0; i < inputs.length; i += batch) calls.push(call(inputs.slice(i, i + batch)));
      return sum(await Promise.all(calls));
    },
    // questions: [text] -> same shape. The cache makes the speculative prefetch and the real search one call.
    async embedQueries(texts) {
      const keys = texts.map(norm);
      // Hits are taken before this call adds (and so may evict) anything.
      const hits = new Map();
      for (const k of keys) if (queries.has(k)) hits.set(k, touch(k));
      const missIdx = [];
      const seen = new Set();
      keys.forEach((k, i) => {
        if (!queries.has(k) && !seen.has(k)) {
          seen.add(k);
          missIdx.push(i);
        }
      });
      let tokens = 0;
      let cost = 0;
      const fresh = new Map(); // read straight from this call's result, so eviction can never lose a vector
      if (missIdx.length) {
        const p = call(
          missIdx.map((i) => `task: search result | query: ${texts[i]}`),
          qslots,
          { timeoutMs: queryTimeoutMs, retries: queryRetries, backoffMs: queryBackoffMs }
        );
        missIdx.forEach((i, n) =>
          queries.set(
            keys[i],
            p.then((r) => r.vectors[n])
          )
        );
        p.catch(() => missIdx.forEach((i) => queries.delete(keys[i])));
        while (queries.size > cacheSize) queries.delete(queries.keys().next().value);
        const r = await p;
        tokens = r.tokens;
        cost = r.cost;
        missIdx.forEach((i, n) => fresh.set(keys[i], r.vectors[n]));
      }
      const vectors = await Promise.all(
        keys.map((k) => (fresh.has(k) ? fresh.get(k) : hits.get(k)))
      );
      return { vectors, tokens, cost, cached: texts.length - missIdx.length };
    },
    // One media input per request (the payload is big): parts is an OpenRouter content array.
    // e.g. [{type:"input_audio", input_audio:{data:"data:audio/mpeg;base64,...", format:"mp3"}}]
    async embedMedia(parts) {
      const r = await call([{ content: parts }]);
      return { vector: r.vectors[0], tokens: r.tokens, cost: r.cost };
    },
  };
}

// The content part OpenRouter accepts for each kind of media (verified live, see RAG_PLAN.md).
function mediaPart(kind, buffer, mime) {
  const uri = `data:${mime};base64,${buffer.toString("base64")}`;
  if (kind === "image") return { type: "image_url", image_url: { url: uri } };
  if (kind === "audio")
    return {
      type: "input_audio",
      input_audio: { data: uri, format: mime.includes("wav") ? "wav" : "mp3" },
    };
  if (kind === "video") return { type: "input_video", input_video: { data: uri, format: "mp4" } };
  throw new Error(`no media part for ${kind}`);
}

module.exports = { createEmbedClient, mediaPart };
