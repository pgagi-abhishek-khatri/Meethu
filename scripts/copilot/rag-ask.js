// Runs questions through the copilot's retriever against an existing copilot.db's first project.
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/copilot/rag-ask.js <userDataDir> "question" ...
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../../.env"), quiet: true });
const { openStore } = require("../../src/copilot/main/store");
const { createEmbedClient } = require("../../src/copilot/rag/embedClient");
const { createRetriever } = require("../../src/copilot/rag/retrieve");
(async () => {
  const [dir, ...qs] = process.argv.slice(2);
  const store = openStore({ dbPath: path.join(dir, "copilot.db") });
  const pid = store.projects.list()[0].id;
  const embed = createEmbedClient({ apiKey: process.env.OPENROUTER_API_KEY });
  const r = createRetriever({ rag: store.rag, clients: () => ({ embed }) });
  for (const q of qs) {
    const a = await r.retrieve({ query: q, projectIds: [pid], why: "probe" });
    console.log(
      `\nQ: ${q}\n  ${a.ms} ms, ${a.skipped ?? "ok"}: ${a.used.map((u) => `${u.file.slice(0, 20)} ${u.where} ${u.score}`).join(" | ")}`
    );
    console.log(a.text.split("\n\n").slice(1, 3).join("\n---\n").slice(0, 500));
  }
  store.close();
  process.exit(0);
})();
