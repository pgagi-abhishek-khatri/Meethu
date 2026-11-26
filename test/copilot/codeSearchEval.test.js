// Phase 4.1: a regression floor for code search quality on a labelled set (see scripts/copilot/code-search-eval.js).
// The corpus is this repo's own src/, so the floor has slack: it catches a real drop, not a renamed file.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { evaluate } = require("../../scripts/copilot/code-search-eval");

test("recall and MRR on the labelled repo questions stay above the floor", async () => {
  const r = await evaluate();
  assert.ok(r.n >= 30);
  assert.ok(
    r.recall5 >= 0.88,
    `recall@5 ${r.recall5.toFixed(2)} (misses: ${JSON.stringify(r.misses.map((m) => m.q))})`
  );
  assert.ok(r.mrr >= 0.72, `MRR ${r.mrr.toFixed(2)}`);
});
