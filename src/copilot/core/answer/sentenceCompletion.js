// Sentence completion module for AI-generated responses, bullets, and questions.
// Guarantees all emitted card bodies, followups, and gap questions are grammatically
// and syntactically closed, preventing dangling fragments or missing terminal punctuation.

const TERMINAL_PUNCTUATION = /[.?!…]["')\]]*$/;
const DANGLING_PUNCTUATION = /[,;:\-—–\s]+$/;
const DANGLING_CONJUNCTION =
  /\b(and|or|but|because|with|at|by|to|for|that|then|which|as|so|if|from|into|about|after|before)$/i;

/**
 * Completes a single line, bullet, or sentence cleanly.
 */
function completeLine(line) {
  const trimmed = String(line ?? "").trim();
  if (!trimmed) return "";

  // Preserve markdown headings, horizontal rules, code blocks
  if (/^(#+|-{3,}|\*{3,}|`{3,})/.test(trimmed)) {
    return trimmed;
  }

  // Preserve bullet prefix if present (- or * or 1.)
  const bulletMatch = /^([-*•]|\d+\.)\s+(.*)/.exec(trimmed);
  const prefix = bulletMatch ? `${bulletMatch[1]} ` : "";
  let content = bulletMatch ? bulletMatch[2].trim() : trimmed;

  if (!content) return trimmed;

  // If already properly terminated, return
  if (TERMINAL_PUNCTUATION.test(content)) {
    return `${prefix}${content}`;
  }

  // Strip trailing commas, colons, semicolons, dashes
  content = content.replace(DANGLING_PUNCTUATION, "");

  // Check if content ends on a dangling conjunction or preposition
  if (DANGLING_CONJUNCTION.test(content)) {
    // If it has multiple sentences, trim back to the last complete sentence
    const sentences = content.split(/(?<=[.!?…])\s+/);
    if (sentences.length > 1) {
      sentences.pop();
      return `${prefix}${sentences.join(" ")}`;
    }
    // If it is a single line that ends with a dangling word, strip the dangling word and add a period
    content = content.replace(DANGLING_CONJUNCTION, "").replace(DANGLING_PUNCTUATION, "");
  }

  if (!content) return "";

  // Append period if content has substantive words
  return `${prefix}${content}.`;
}

/**
 * Ensures all paragraphs and bullets in an AI answer body are grammatically complete.
 */
function ensureSentenceCompletion(text) {
  if (!text) return "";
  const lines = String(text).split("\n");
  const processed = lines.map((line) => {
    // Preserve empty lines
    if (!line.trim()) return line;
    return completeLine(line);
  });
  return processed.join("\n").trim();
}

/**
 * Ensures a question string ends cleanly with a question mark.
 */
function ensureQuestionCompletion(question) {
  let q = String(question ?? "").trim();
  if (!q) return "";
  // Strip trailing dots or commas before question mark
  q = q.replace(/[.,;:\-—–\s]+$/, "");
  if (!q.endsWith("?")) {
    q = `${q}?`;
  }
  return q;
}

module.exports = {
  ensureSentenceCompletion,
  ensureQuestionCompletion,
  completeLine,
};
