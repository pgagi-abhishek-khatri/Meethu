// Deterministic "did we already answer this?" check: no model call, so it can
// run before D1 and stay cheap. Digits are kept as content words so "$20 a
// month" and "$40 a month" never count as the same need.
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "to", "of", "in", "on", "for", "and", "or", "it", "its",
  "this", "that", "we", "you", "i", "me", "my", "our", "your", "do", "does", "did", "can", "could", "would",
  "what", "whats", "how", "which", "who", "when", "where", "why", "so", "just", "about", "with", "at", "by",
  // "how much does X cost" restates "X price"; they carry no topic of their own
  "much", "cost",
]);

function contentWords(text) {
  const words = String(text || "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP_WORDS.has(w));
  return new Set(words);
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function isDuplicate({ text, cards = [], asked = new Set(), now, windowMs, minOverlap }) {
  const words = contentWords(text);
  if (!words.size) return { duplicate: false, score: 0 };

  let best = { score: 0 };
  for (const c of cards) {
    if (now - c.shownAt > windowMs) continue;
    const score = jaccard(words, contentWords([c.gist, c.title, c.body].filter(Boolean).join(" ")));
    if (score > best.score) best = { score, matchedJobId: c.jobId };
  }
  for (const q of asked) {
    const score = jaccard(words, contentWords(q));
    if (score > best.score) best = { score };
  }

  if (best.score >= minOverlap) {
    return best.matchedJobId === undefined
      ? { duplicate: true, score: best.score }
      : { duplicate: true, matchedJobId: best.matchedJobId, score: best.score };
  }
  return { duplicate: false, score: best.score };
}

module.exports = { isDuplicate, contentWords };
