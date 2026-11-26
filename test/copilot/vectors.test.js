// Phase 2.4: top-k stays exactly right while getting faster.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { topK, normalize } = require("../../src/copilot/rag/vectors");

// the original implementation, kept here as the oracle
function reference(matrix, q, k) {
  const { ids, data } = matrix;
  const dims = q.length;
  const all = [];
  for (let r = 0; r < ids.length; r++) {
    let s = 0;
    for (let i = 0; i < dims; i++) s += data[r * dims + i] * q[i];
    all.push({ id: ids[r], score: s });
  }
  return all.sort((a, b) => b.score - a.score).slice(0, k);
}
const rand = (n) => Float32Array.from({ length: n }, () => Math.random() - 0.5);

test("matches a full sort for assorted sizes, dims (including ones not divisible by 4) and k", () => {
  for (const [rows, dims, k] of [
    [0, 8, 5],
    [1, 8, 5],
    [7, 3, 12],
    [200, 10, 12],
    [500, 768, 12],
    [300, 5, 1],
  ]) {
    const ids = Array.from({ length: rows }, (_, i) => i * 3 + 1);
    const data = rand(rows * dims);
    const q = normalize(rand(dims));
    const got = topK({ ids, data }, q, k);
    const want = reference({ ids, data }, q, k);
    assert.equal(got.length, want.length);
    got.forEach((g, i) => {
      assert.equal(g.id, want[i].id);
      assert.ok(Math.abs(g.score - want[i].score) < 1e-5);
    });
  }
});

test("ties keep every row eligible and the output is best first", () => {
  const ids = [10, 11, 12, 13];
  const data = Float32Array.from([1, 0, 1, 0, 1, 0, 0, 1]);
  const got = topK({ ids, data }, Float32Array.from([1, 0]), 3);
  assert.equal(got.length, 3);
  for (let i = 1; i < got.length; i++) assert.ok(got[i - 1].score >= got[i].score);
});

test("20k rows x 768 dims answers within the latency budget", () => {
  const rows = 20000;
  const dims = 768;
  const ids = Array.from({ length: rows }, (_, i) => i);
  const data = rand(rows * dims);
  const q = normalize(rand(dims));
  topK({ ids, data }, q, 12); // warm
  // best of five: the suite runs other tests beside this one, and a scheduler hiccup is not a slow algorithm
  let best = Infinity;
  for (let r = 0; r < 5; r++) {
    const t = process.hrtime.bigint();
    topK({ ids, data }, q, 12);
    best = Math.min(best, Number(process.hrtime.bigint() - t) / 1e6);
  }
  assert.ok(best < 80, `${best.toFixed(1)}ms per query (target ~30ms on an idle machine)`);
});
