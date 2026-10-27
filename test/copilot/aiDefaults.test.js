const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getCopilotAiConfig,
  DEFAULT_COPILOT_MODEL,
} = require("../../src/copilot/config/aiDefaults");

test("defaults to Qwen 3.8 27B (fast) and Claude Sonnet 5.5 (deeper) on OpenRouter and reads the key from env", () => {
  const c = getCopilotAiConfig({ OPENROUTER_API_KEY: " sk-or-x " });
  assert.equal(c.model, "qwen/qwen3.8-27b-20260814:nitro");
  assert.equal(c.deepModel, "anthropic/claude-sonnet-5.5");
  assert.equal(c.provider, "openrouter");
  assert.equal(c.apiKey, "sk-or-x");
});

test("COPILOT_AI_MODEL overrides the model; missing key is an empty string", () => {
  assert.equal(
    getCopilotAiConfig({ COPILOT_AI_MODEL: "google/gemini-3.5-flash" }).model,
    "google/gemini-3.5-flash"
  );
  assert.equal(getCopilotAiConfig({}).apiKey, "");
  assert.equal(getCopilotAiConfig({ COPILOT_AI_MODEL: "  " }).model, DEFAULT_COPILOT_MODEL);
});
