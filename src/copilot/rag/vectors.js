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

const toBuffer = (v) => {
  if (Buffer.isBuffer(v)) return v;
  const f32 = v instanceof Float32Array ? v : new Float32Array(v);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
};
const fromBuffer = (buf) =>
  new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

// matrix: { ids: number[], data: Float32Array (rows * dims) } -> [{id, score}] best first
// The dot products dominate (rows x dims), so the inner loop is unrolled four at a time and the entry bar for the
// top k is cached; the ordered insert touches at most k items and only when a row beats the current k-th.
function topK(matrix, q, k) {
  const { ids, data } = matrix;
  const dims = q.length;
  const best = [];
  const limit = dims - (dims % 4);
  let bar = -Infinity; // the k-th best score once the list is full
  for (let r = 0; r < ids.length; r++) {
    const o = r * dims;
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    let s3 = 0;
    let i = 0;
    for (; i < limit; i += 4) {
      s0 += data[o + i] * q[i];
      s1 += data[o + i + 1] * q[i + 1];
      s2 += data[o + i + 2] * q[i + 2];
      s3 += data[o + i + 3] * q[i + 3];
    }
    for (; i < dims; i++) s0 += data[o + i] * q[i];
    const s = s0 + s1 + s2 + s3;
    if (best.length >= k && s <= bar) continue;
    let at = best.length;
    while (at > 0 && best[at - 1].score < s) at--;
    best.splice(at, 0, { id: ids[r], score: s });
    if (best.length > k) best.pop();
    if (best.length >= k) bar = best[best.length - 1].score;
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
