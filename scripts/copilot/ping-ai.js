// Manual check: node scripts/copilot/ping-ai.js
// Sends one tiny request with the copilot's default model and prints the latency.
require("dotenv").config({ path: require("path").join(__dirname, "../../.env") });
const { getCopilotAiConfig } = require("../../src/copilot/config/aiDefaults");

(async () => {
  const { baseUrl, model, apiKey } = getCopilotAiConfig();
  if (!apiKey) {
    console.error("OPENROUTER_API_KEY is missing from .env");
    process.exit(1);
  }
  const started = Date.now();
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 20,
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
    }),
  });
  const body = await res.json().catch(() => ({}));
  const ms = Date.now() - started;
  if (!res.ok) {
    console.error(`HTTP ${res.status}`, JSON.stringify(body.error || body));
    process.exit(1);
  }
  console.log({
    model: body.model,
    provider: body.provider,
    ms,
    reply: body.choices?.[0]?.message?.content,
  });
})();
