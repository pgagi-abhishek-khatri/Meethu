// Writes the file profiles (src/copilot/rag/profile.js) of a copilot.db's indexed files from the chunks it
// already holds: no file is read or embedded again. Costs one or a few reading-model calls per file.
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/copilot/profile-backfill.js <copilot.db> [--force] [--out dir]
// --force rewrites profiles that are already current. --out writes each profile and what every reader would
// see (D1, answer model, query writer) to <dir> for reading.
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../../.env"), quiet: true });
const { openStore } = require("../../src/copilot/main/store");
const { createAnalyzer } = require("../../src/copilot/rag/analyzeClient");
const { buildProfile } = require("../../src/copilot/rag/profileBuilder");
const { PROFILE_VERSION } = require("../../src/copilot/rag/profile");
const { createRetriever } = require("../../src/copilot/rag/retrieve");

(async () => {
  const args = process.argv.slice(2);
  const dbPath = args[0];
  const force = args.includes("--force");
  const outIdx = args.indexOf("--out");
  const out = outIdx > 0 ? args[outIdx + 1] : null;
  if (!dbPath || !fs.existsSync(dbPath)) throw new Error(`no copilot.db at ${dbPath}`);
  const store = openStore({ dbPath });
  const analyze = createAnalyzer({ apiKey: process.env.OPENROUTER_API_KEY });
  const rows = force
    ? store.projects
        .list()
        .flatMap((p) =>
          p.files.filter((f) => f.status === "ready").map((f) => ({ ...f, project_id: p.id }))
        )
    : store.rag.staleProfiles(PROFILE_VERSION);
  if (out) fs.mkdirSync(out, { recursive: true });
  const logs = [];
  let total = 0;
  for (const f of rows) {
    const file = store.rag.file(f.id);
    const chunks = store.rag.fileChunks(f.id);
    const t0 = Date.now();
    const r = await buildProfile({
      ask: analyze.ask,
      name: file.name,
      kind: file.kind,
      chunks,
      log: (e) => logs.push({ file: file.name, ...e }),
    });
    store.rag.setFile(f.id, { profile: JSON.stringify(r.profile), profile_v: PROFILE_VERSION });
    total += r.cost;
    const p = r.profile;
    console.log(
      `${file.name}: ${chunks.length} chunks, ${r.parts} part(s), ${r.calls} call(s), ${((Date.now() - t0) / 1000).toFixed(1)} s, $${r.cost.toFixed(4)}, ${r.tokens} tokens\n` +
        `  topics ${p.topics.length}, facts ${p.facts.length} (dropped ${r.dropped.length} ungrounded), terms ${p.terms.length}, abstract ${p.abstract.split(/\s+/).length} words`
    );
    for (const d of r.dropped)
      console.log(`  dropped: ${d.text}  [missing ${d.missing.join(", ")}]`);
    if (out)
      fs.writeFileSync(
        path.join(out, `${file.name.replace(/[^\w.-]+/g, "_")}.profile.json`),
        JSON.stringify({ ...r, profile: p }, null, 2)
      );
  }
  console.log(`\n${rows.length} file(s), $${total.toFixed(4)}`);
  if (out) {
    const projectIds = store.projects.list().map((p) => p.id);
    const view = {};
    for (const mode of ["summary", "profile"]) {
      const r = createRetriever({ rag: store.rag, clients: () => null, catalogMode: mode });
      view[mode] = {
        decider: r.catalogLines(projectIds),
        answer: r.catalog(projectIds),
        writer: r.writerCatalog(projectIds),
      };
      view[mode].chars = {
        decider: view[mode].decider.join("\n").length,
        answer: view[mode].answer.length,
        writer: view[mode].writer.join("\n").length,
      };
    }
    fs.writeFileSync(path.join(out, "catalog-views.json"), JSON.stringify(view, null, 2));
    fs.writeFileSync(path.join(out, "profile-log.json"), JSON.stringify(logs, null, 2));
    console.log(
      `catalog chars summary=${JSON.stringify(view.summary.chars)} profile=${JSON.stringify(view.profile.chars)}`
    );
  }
  store.close();
  process.exit(0);
})().catch((e) => (console.error(e), process.exit(1)));
