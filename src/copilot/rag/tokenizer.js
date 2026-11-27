// Real BPE token counter backed by pure-JS gpt-tokenizer (cl100k_base),
// with a calibrated subword fallback if package installation is unavailable.
let encodeFn = null;
let engineName = "subword-calibrated";
try {
  const gptTok = require("gpt-tokenizer");
  if (typeof gptTok?.encode === "function") {
    encodeFn = gptTok.encode;
    engineName = "gpt-tokenizer";
  }
} catch {
  encodeFn = null;
}

const SUBWORD_RE = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}{1,7}| ?\p{N}{1,3}| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

function countTokens(text) {
  const s = String(text ?? "");
  if (!s) return 0;
  if (encodeFn) return encodeFn(s).length;
  const matches = s.match(SUBWORD_RE);
  return matches ? matches.length : Math.ceil(s.length / 4);
}

function getTokenizerInfo() {
  return { engine: engineName, isRealBpe: engineName === "gpt-tokenizer" };
}

module.exports = {
  countTokens,
  getTokenizerInfo,
};
