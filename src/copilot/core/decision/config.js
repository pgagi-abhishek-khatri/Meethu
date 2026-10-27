// Decision-model settings. Every number here is an UNVALIDATED default: D1's
// probabilities are calibrated for Liquid's training data, not for our meetings,
// so thresholds must be tuned on replayed meetings (Phase 15 eval) before trust.
const DEFAULT_DECISION_CONFIG = {
  // Policy on D1's answers (all unvalidated defaults: tune on replayed meetings, scripts/copilot/replay-fast.mjs)
  actThreshold: { quiet: 0.7, normal: 0.5, chatty: 0.4 }, // act x (1 - chatter) must reach this; 0.5 balances recall and precision on 15 labelled meetings
  explicitThreshold: 0.8, // "the USER asked the copilot" (judged by D1 on the USER's own words) bypasses quiet level, cooldown, already-handled
  alreadyHandledThreshold: 0.75, // "covered by a card or running analysis" at this probability skips
  replaceMin: 0.6, // "changes a running analysis" at this probability redoes it
  textCompleteThreshold: 0.5,
  maxWaitForCompleteMs: 2500, // never defer longer than this for an unfinished sentence
  recheckAfterMs: 800,
  recheckBarFactor: 0.6, // an unfinished sentence is rechecked if it already scores this share of the bar
  cooldownMs: 8000, // min gap between proactive cards
  holdWhileUserSpeaking: true,
  holdMaxMs: 4000, // never hold others' words longer than this while the user speaks (they would starve)
  weakCardBelow: 0.7, // proactive card with less confidence than this ...
  weakCardMemoryMs: 30000, // ... stops counting as "already handled" after this
  cardMemoryMs: 120000, // a card older than this no longer counts as "already handled"
  choiceMinConfidence: 0.5, // below this a pick-one answer falls back to its most likely option
  needThreshold: { web: 0.4, project: 0.5, pastMeetings: 0.5, screenshot: 0.95 },
  proactiveRichMin: 0.9, // diagram/document may be produced unasked only above this
  offerMin: 0.5, // between offerMin and proactiveRichMin: show an "offer" button instead
  // Transcript the main model should read per tier / deliverable (0 = whole meeting; summary covers it).
  contextSeconds: { fast: 120, reasoning: 300, summary: 0 },

  // State budgets (characters; about 4 per token): the last ~20 lines verbatim plus the whole rolling summary.
  budget: { newText: 700, context: 1800, summary: 1200 },
  maxContextTurns: 15, // the last 15 messages verbatim; the summary covers what is older
  maxNewTurns: 5,

  // Transport
  // OpenRouter serves Liquid's D1 at /systemone (same typed request and answers as
  // Liquid's own API, which is https://api.liquid.ai/decisions/v1/systemone).
  url: "https://openrouter.ai/api/v1/systemone",
  model: "perplexity/pplx-decider-v1.1-27b", // was liquid/d1: same answers on our eval and podcast replay, half the price, lower latency
  timeoutMs: 2500,
};

// Key: COPILOT_DECISION_KEY, else OPENROUTER_API_KEY (the same key as the AI layer).
// COPILOT_DECISION_MODEL / COPILOT_DECISION_URL point it at another D1 (for example
// Liquid's own API: https://api.liquid.ai/decisions/v1/systemone with model "d1").
function getDecisionEnv(env = process.env) {
  return {
    apiKey: (env.COPILOT_DECISION_KEY || env.OPENROUTER_API_KEY || "").trim(),
    model: (env.COPILOT_DECISION_MODEL || "").trim() || DEFAULT_DECISION_CONFIG.model,
    url: (env.COPILOT_DECISION_URL || "").trim() || DEFAULT_DECISION_CONFIG.url,
  };
}

module.exports = { DEFAULT_DECISION_CONFIG, getDecisionEnv };
