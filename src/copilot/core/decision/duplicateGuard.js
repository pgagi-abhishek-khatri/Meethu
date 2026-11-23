// Deterministic "did we already answer this?" check: no model call, so it can
// run before D1 and stay cheap. Digits are kept as content words so "$20 a
// month" and "$40 a month" never count as the same need.
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "to", "of", "in", "on", "for", "and", "or", "it", "its",
  "this", "that", "we", "you", "i", "me", "my", "our", "your", "do", "does", "did", "can", "could", "would",
  "what", "whats", "how", "which", "who", "when", "where", "why", "so", "just", "about", "with", "at", "by",
  "much", // interrogative filler ("how much does X cost")
]);

// "cost" and "price" ask for the same thing, so they count as one word.
const PRICE_WORDS = new Set(["price", "prices", "pricing", "priced", "cost", "costs", "costing"]);

function contentWords(text) {
  const words = normalize(text)
    .split(" ")
    .filter((w) => w && !STOP_WORDS.has(w))
    .map((w) => (PRICE_WORDS.has(w) ? "price" : w));
  return new Set(words);
}

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join(" ");
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function isDuplicate({ text, cards = [], asked = new Set(), now, windowMs, minOverlap }) {
  const norm = normalize(text);
  if (!norm) return { duplicate: false, score: 0 };
  const words = contentWords(text);
  // Text made only of stop words has no word set to compare: fall back to an exact repeat.
  const similarity = (other) =>
    words.size ? jaccard(words, contentWords(other)) : normalize(other) === norm ? 1 : 0;

  let best = { score: 0 };
  for (const c of cards) {
    if (now - c.shownAt > windowMs) continue;
    // The answer body is left out: its words would swell the union and hide a reworded repeat.
    const gist = c.gist || "";
    const title = c.title || "";
    const score = Math.max(
      gist ? similarity(gist) : 0,
      title ? similarity(title) : 0,
      gist && title ? similarity(`${gist} ${title}`) : 0
    );
    if (score > best.score) best = { score, matchedJobId: c.jobId };
  }
  for (const q of asked) {
    const score = similarity(q);
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
