#!/usr/bin/env node
// Replays questions through the real retriever with simulated network latencies, to compare retrieval settings
// (legacy "wait for the query model" vs the deterministic rewrite) without a key or a network.
//   node scripts/copilot/retrieve-bench.js [--n 40] [--embed 250] [--writer 620] [--lookup 15] [--router 15]
// Numbers are only as real as the latencies you pass; they show the structure of the wait, not your network.
const { createRetriever } = require("../../src/copilot/rag/retrieve");
const { RAG } = require("../../src/copilot/rag/config");

const arg = (name, d) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
const N = arg("n", 40);
const LAT = {
  embed: arg("embed", 250),
  writer: arg("writer", 620),
  lookup: arg("lookup", 15),
  router: arg("router", 15),
};
const PROJECTS = arg("projects", 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const QUESTIONS = [
  "where is retrieveChunks used in rag/retrieve.js",
  "what does `load_config` do when the file is missing",
  "how does the scheduler decide when to call the model",
  "what is the refund rule for annual plans",
  "which function writes the copilot-rag.jsonl log",
  "explain the fingerprint check before a repo question",
];

function build(cfg) {
  const rag = {
    hasIndex: () => true,
    catalog: () => [],
    keyword: () => [1, 2, 3],
    vector: () => [
      { id: 1, score: 0.9 },
      { id: 2, score: 0.8 },
    ],
    similarity: () => new Map(),
    rrf: () => [{ id: 1 }, { id: 2 }, { id: 3 }],
    chunk: (id) => ({ file: `f${id}.js`, file_id: id, text: "passage ".repeat(40), meta: {} }),
  };
  let seq = 0;
  return createRetriever({
    rag,
    cfg,
    clients: () => ({
      embed: {
        // every question is new, as a rolling transcript is: no cache hits
        embedQueries: async () => (
          await sleep(LAT.embed),
          { vectors: [[1, 0]], cost: 0, id: ++seq }
        ),
      },
    }),
    als: { lookup: async () => (await sleep(LAT.lookup), { status: "NONE" }) },
    temporalRouter: {
      routeTemporalQuery: async () => (await sleep(LAT.router), { status: "NONE" }),
    },
  });
}

const pct = (xs, p) =>
  xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];

async function run(label, cfg) {
  const r = build(cfg);
  const ms = [];
  for (let i = 0; i < N; i++) {
    const t = Date.now();
    await r.retrieve({
      query: QUESTIONS[i % QUESTIONS.length],
      projectIds: Array.from({ length: PROJECTS }, (_, k) => k + 1),
      expand: async () => (await sleep(LAT.writer), { queries: ["written query"] }),
    });
    ms.push(Date.now() - t);
  }
  console.log(`${label.padEnd(34)} p50 ${pct(ms, 50)} ms   p95 ${pct(ms, 95)} ms   (n=${N})`);
}

(async () => {
  console.log(`latencies (ms): ${JSON.stringify(LAT)}, ${PROJECTS} projects\n`);
  await run("legacy: wait for the query model", { ...RAG, fastQueryModel: true });
  await run("rewrite: no model on the fast path", { ...RAG, fastQueryModel: false });
})();
