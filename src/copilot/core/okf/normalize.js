// Normalisation shared by every OKF matcher (document lookup, feature registry): the same title or keyword must
// reduce to the same string wherever it is compared. Pure, Electron-free.

// Normalizes title strings for exact matching
function normalizeTitle(s) {
  if (typeof s !== "string") return "";
  return s
    .trim()
    .toLowerCase()
    .replace(/[—–]/g, "-") // em-dash, en-dash to hyphen
    .replace(/["'“”‘’]/g, "") // strip quotes
    .replace(/[.:;,-]+$/g, "") // strip trailing punctuation
    .replace(/\s+/g, " "); // collapse whitespace
}

// Tokenizes a keyword for exact keyword indexing
function normalizeKeyword(k) {
  if (typeof k !== "string") return "";
  return k
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "");
}

module.exports = { normalizeTitle, normalizeKeyword };
