// Temporary default for the copilot's AI layer, like SONIOX_API_KEY for speech:
// no settings UI yet, everything comes from .env (loaded by main.js).
//   OPENROUTER_API_KEY   required (same key the app's OpenRouter provider uses)
//   COPILOT_AI_MODEL     optional, overrides the model
// Add ":nitro" to a model id to ask OpenRouter for the fastest provider.
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
// Fast tier: no thinking, no web. The "Go deeper" button re-runs a card on the deep model with web search.
const DEFAULT_COPILOT_MODEL = "qwen/qwen3.8-27b-20260814:nitro";
const DEFAULT_DEEP_MODEL = "anthropic/claude-sonnet-5.5";

function getCopilotAiConfig(env = process.env) {
  const apiKey = (env.OPENROUTER_API_KEY || "").trim();
  const model = (env.COPILOT_AI_MODEL || "").trim() || DEFAULT_COPILOT_MODEL;
  const deepModel = (env.COPILOT_DEEP_MODEL || "").trim() || DEFAULT_DEEP_MODEL;
  return { provider: "openrouter", baseUrl: OPENROUTER_BASE_URL, model, deepModel, apiKey };
}

module.exports = {
  getCopilotAiConfig,
  DEFAULT_COPILOT_MODEL,
  DEFAULT_DEEP_MODEL,
  OPENROUTER_BASE_URL,
};
