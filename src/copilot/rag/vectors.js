// Vector math for the project search. Vectors are unit length, so cosine = dot product. Pure.
function normalize(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

// A cut-down (Matryoshka) vector must be re-normalised after the cut.
const cut = (v, dims) => normalize(Float32Array.from(v.length > dims ? v.slice(0, dims) : v));

const toBuffer = (f32) => Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
const fromBuffer = (buf) =>
  new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

// matrix: { ids: number[], data: Float32Array (rows * dims) } -> [{id, score}] best first
function topK(matrix, q, k) {
  const { ids, data } = matrix;
  const dims = q.length;
  const best = [];
  for (let r = 0; r < ids.length; r++) {
    let s = 0;
    const o = r * dims;
    for (let i = 0; i < dims; i++) s += data[o + i] * q[i];
    if (best.length < k || s > best[best.length - 1].score) {
      best.push({ id: ids[r], score: s });
      best.sort((a, b) => b.score - a.score);
      if (best.length > k) best.pop();
    }
  }
  return best;
}

// Reciprocal rank fusion: each list is ids best-first; returns [{id, score}] best first.
function rrf(lists, { k = 60, weights = [] } = {}) {
  const score = new Map();
  lists.forEach((list, li) => {
    const w = weights[li] ?? 1;
    list.forEach((id, rank) => score.set(id, (score.get(id) ?? 0) + w / (k + rank + 1)));
  });
  return [...score].map(([id, s]) => ({ id, score: s })).sort((a, b) => b.score - a.score);
}

module.exports = { normalize, cut, toBuffer, fromBuffer, topK, rrf };
