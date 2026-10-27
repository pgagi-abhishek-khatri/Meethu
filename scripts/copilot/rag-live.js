// Live check of the project-file search with the real OpenRouter key (costs a few cents).
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/copilot/rag-live.js <outdir> <file>... -- "question" "question"
// Indexes the files into a scratch copilot.db, prints each file's result, then runs the questions through the
// same retriever the copilot uses and prints what came back (and the log in <outdir>/copilot-rag.jsonl).
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../../.env") });
const { openStore } = require("../../src/copilot/main/store");
const { createEmbedClient } = require("../../src/copilot/rag/embedClient");
const { createAnalyzer } = require("../../src/copilot/rag/analyzeClient");
const { createMedia } = require("../../src/copilot/rag/media");
const { createIngestor } = require("../../src/copilot/rag/ingest");
const { createRetriever } = require("../../src/copilot/rag/retrieve");
const { createRagLog } = require("../../src/copilot/rag/ragLog");
const { getFFmpegPath } = require("../../src/helpers/ffmpegUtils");

(async () => {
  const [out, ...rest] = process.argv.slice(2);
  const split = rest.indexOf("--");
  const files = split < 0 ? rest : rest.slice(0, split);
  const questions = split < 0 ? [] : rest.slice(split + 1);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const apiKey = process.env.OPENROUTER_API_KEY;
  const store = openStore({ dbPath: path.join(out, "copilot.db") });
  const pid = store.projects.create("live");
  const log = createRagLog({ dir: out });
  const clients = () => ({
    embed: createEmbedClient({ apiKey }),
    analyze: createAnalyzer({ apiKey }),
  });
  const cache = clients();
  const ing = createIngestor({
    rag: store.rag,
    clients: () => cache,
    media: createMedia({ ffmpegPath: getFFmpegPath() }),
    log,
    getCfg: () => ({}),
  });
  const t0 = Date.now();
  await Promise.all(
    files.map((f) => ing.ingest(store.projects.addFileRow(pid, path.resolve(f), path.basename(f))))
  );
  console.log(`indexed ${files.length} files in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  for (const f of store.projects.list()[0].files)
    console.log(
      `- ${f.name} [${f.status}] ${f.chunks} chunks, $${f.cost.toFixed(4)}${f.error ? " ERROR: " + f.error : ""}${f.note ? " NOTE: " + f.note : ""}\n    ${f.summary ?? ""}`
    );
  const r = createRetriever({ rag: store.rag, clients: () => cache, log });
  console.log("\n" + r.catalog([pid]));
  for (const q of questions) {
    const a = await r.retrieve({ query: q, projectIds: [pid], why: "live" });
    console.log(
      `\nQ: ${q}\n  -> ${a.ms} ms, skipped=${a.skipped}, used=${JSON.stringify(a.used)}\n${a.text.slice(0, 700)}`
    );
  }
  store.close();
  process.exit(0);
})().catch((e) => (console.error(e), process.exit(1)));
