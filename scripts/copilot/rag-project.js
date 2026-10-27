// Creates (or reuses) a project in a copilot.db and indexes every file of a folder into it, with timings.
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/copilot/rag-project.js <userDataDir> <projectName> <folder>
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../../.env"), quiet: true });
const { openStore } = require("../../src/copilot/main/store");
const { createEmbedClient } = require("../../src/copilot/rag/embedClient");
const { createAnalyzer } = require("../../src/copilot/rag/analyzeClient");
const { createMedia } = require("../../src/copilot/rag/media");
const { createIngestor } = require("../../src/copilot/rag/ingest");
const { createRagLog } = require("../../src/copilot/rag/ragLog");
const { getFFmpegPath } = require("../../src/helpers/ffmpegUtils");

(async () => {
  const [dir, name, folder] = process.argv.slice(2);
  const apiKey = process.env.OPENROUTER_API_KEY;
  const store = openStore({ dbPath: path.join(dir, "copilot.db") });
  let p = store.projects.list().find((x) => x.name === name);
  const pid = p ? p.id : store.projects.create(name);
  const have = new Set((p?.files ?? []).map((f) => f.path));
  const rows = [];
  for (const f of fs.readdirSync(folder).sort()) {
    const full = path.resolve(folder, f);
    if (!fs.statSync(full).isFile()) continue;
    rows.push(
      have.has(full) && process.env.FORCE
        ? store.projects.files(pid).find((r) => r.path === full)
        : have.has(full)
          ? (store.rag.unfinished().find((r) => r.path === full) ?? null)
          : store.projects.addFileRow(pid, full, f)
    );
  }
  const clients = { embed: createEmbedClient({ apiKey }), analyze: createAnalyzer({ apiKey }) };
  const ing = createIngestor({
    rag: store.rag,
    clients: () => clients,
    media: createMedia({ ffmpegPath: getFFmpegPath() }),
    log: createRagLog({ dir }),
  });
  const t0 = Date.now();
  const done = {};
  await Promise.all(
    rows
      .filter(Boolean)
      .map((r) => ing.ingest(r).then(() => (done[r.name] = ((Date.now() - t0) / 1000).toFixed(1))))
  );
  console.log(
    `project ${name} (#${pid}): ${rows.filter(Boolean).length} files ready in ${((Date.now() - t0) / 1000).toFixed(1)} s total`
  );
  let cost = 0;
  for (const f of store.projects.list().find((x) => x.id === pid).files) {
    cost += f.cost;
    console.log(
      `- ${f.name} [${f.status}] ready at ${done[f.name] ?? "-"} s, ${f.chunks} chunks, $${f.cost.toFixed(4)}${f.error ? " ERROR " + f.error : ""}${f.note ? " NOTE " + f.note : ""}\n    ${f.summary ?? ""}`
    );
  }
  console.log(`total cost $${cost.toFixed(4)}`);
  store.close();
  process.exit(0);
})().catch((e) => (console.error(e), process.exit(1)));
