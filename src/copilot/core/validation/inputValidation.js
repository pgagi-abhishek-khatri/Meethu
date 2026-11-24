// Pure input validation module for user-submitted questions and sentences.
// Ensures every input sent to the Copilot engine is a valid question or complete sentence,
// preventing truncated fragments, filler, or malformed queries from degrading AI responses.

export const BACKCHANNEL =
  /^(yeah|yes|yep|yup|okay|ok|right|sure|hello|hi|hey|mm+|mhm|mm-hmm|uh-huh|uh+|um+|hmm+|huh|you|thanks|thank you|got it|alright|cool|great|exactly|correct|i see|no|nope|fine|good|nice|perfect|wow|oh|ah)([\s,.!?—–-]+(yeah|yes|yep|right|okay|ok|sure|uh-huh|mm-hmm|mhm|cool|great|exactly|got it|thanks|thank you|hello|hi|hey))*[\s.,!?—–-]*$/i;

export const QUESTION_WORDS =
  /^(who|what|where|when|why|how|which|whose|is|are|was|were|can|could|would|should|will|shall|do|does|did|have|has|had)\b/i;

export const DANGLING_CONJUNCTION =
  /\b(and|or|but|because|so|if|with|at|by|to|for|that|then|as)$/i;

const TERMINAL_PUNCTUATION = /[.?!…]["')\]]*$/;

// Repetitive characters or keyboard smashing: e.g. "aaaaa", "asdfasdf"
const REPETITIVE_CHARS = /(.)\1{4,}/;

export function validateUserInput(rawText, options = {}) {
  const minWords = options.minWords ?? 3;
  const text = String(rawText ?? "").trim();

  if (!text) {
    return {
      valid: false,
      reason: "empty",
      message: "Please enter a question or sentence.",
    };
  }

  // Remove trailing and leading punctuation for word counting
  const words = text
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);

  if (words.length < minWords) {
    return {
      valid: false,
      reason: "too_short",
      message: `Input is too short (${words.length} word${words.length === 1 ? "" : "s"}). Please enter a complete question or sentence with at least ${minWords} words.`,
    };
  }

  // Check for pure filler / pleasantries
  if (BACKCHANNEL.test(text)) {
    return {
      valid: false,
      reason: "filler_only",
      message: "Please enter a specific question or complete sentence rather than conversational filler.",
    };
  }

  // Check for keyboard mash / repetitive characters
  if (REPETITIVE_CHARS.test(text)) {
    return {
      valid: false,
      reason: "irrelevant",
      message: "Input contains repetitive or unstructured characters. Please enter a meaningful question or sentence.",
    };
  }

  // Check for trailing dangling conjunctions or prepositions (e.g. "The system uses Redis and")
  const strippedEnd = text.replace(/[.,;:!?—–\s]+$/, "");
  if (DANGLING_CONJUNCTION.test(strippedEnd)) {
    return {
      valid: false,
      reason: "incomplete",
      message: "Your input appears to end mid-thought with a trailing conjunction or preposition. Please complete your sentence.",
    };
  }

  // Check if it is a valid question
  const isQuestionEnding = text.endsWith("?");
  const hasQuestionWord = QUESTION_WORDS.test(text);

  if (isQuestionEnding || hasQuestionWord) {
    // Valid question: auto-append ? if missing
    const formatted = isQuestionEnding ? text : `${text}?`;
    return {
      valid: true,
      kind: "question",
      formattedText: formatted,
    };
  }

  // Check if it is a complete sentence
  const hasTerminal = TERMINAL_PUNCTUATION.test(text);
  if (hasTerminal) {
    return {
      valid: true,
      kind: "sentence",
      formattedText: text,
    };
  }

  // If missing terminal punctuation, check if it has enough words to be a substantive clause
  if (words.length >= minWords) {
    return {
      valid: true,
      kind: "sentence",
      formattedText: `${text}.`,
    };
  }

  return {
    valid: false,
    reason: "incorrect_structure",
    message: "Please ensure your input is a complete question (ending in '?') or sentence (ending in '.').",
  };
}
