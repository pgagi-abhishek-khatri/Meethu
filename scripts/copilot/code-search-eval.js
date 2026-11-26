#!/usr/bin/env node
// Recall@k and MRR of the vectorless code index against a labelled question set.
//   node scripts/copilot/code-search-eval.js [fixture.json] [--misses]
const fs = require("fs");
const path = require("path");
const { createLocalCodeIndexAsync } = require("../../src/copilot/rag/vectorlessCodeSearch");

const repo = path.resolve(__dirname, "../..");

async function evaluate(fixturePath = path.join(repo, "test/copilot/fixtures/repo-eval.json")) {
  const fx = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const root = path.join(repo, fx.root);
  const idx = await createLocalCodeIndexAsync(root, { useCache: false, maxFiles: 1500 });
  let r1 = 0;
  let r3 = 0;
  let r5 = 0;
  let mrr = 0;
  const misses = [];
  for (const { q, gold } of fx.questions) {
    const hits = idx.search(q, { topK: 5 }).hits.map((h) => h.relPath);
    const rank = hits.findIndex((p) => gold.includes(p)) + 1; // 0 = not found
    if (rank === 1) r1++;
    if (rank >= 1 && rank <= 3) r3++;
    if (rank >= 1 && rank <= 5) r5++;
    if (rank) mrr += 1 / rank;
    else misses.push({ q, gold, got: hits.slice(0, 3) });
  }
  const n = fx.questions.length;
  return {
    n,
    recall1: r1 / n,
    recall3: r3 / n,
    recall5: r5 / n,
    mrr: mrr / n,
    misses,
    files: idx.modules.length,
  };
}

module.exports = { evaluate };

if (require.main === module) {
  evaluate(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : undefined).then(
    (r) => {
      const f = (x) => x.toFixed(2);
      console.log(
        `n=${r.n} files=${r.files}  recall@1 ${f(r.recall1)}  @3 ${f(r.recall3)}  @5 ${f(r.recall5)}  MRR ${f(r.mrr)}`
      );
      if (process.argv.includes("--misses"))
        for (const m of r.misses) console.log("MISS", JSON.stringify(m));
    }
  );
}
