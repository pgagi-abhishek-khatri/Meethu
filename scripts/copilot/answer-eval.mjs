// Live check of the main-model stage: node scripts/copilot/answer-eval.mjs
// Runs a few realistic moments through context pack -> streaming call -> parser; prints format, confidence, timing.
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
require(path.join(root, "node_modules/dotenv")).config({
  path: path.join(root, ".env"),
  quiet: true,
});
const { getCopilotAiConfig } = require("../../src/copilot/config/aiDefaults");
const { createMainModel } = require("../../src/copilot/main/mainCall");
const { createAnswerRunner } = require("../../src/copilot/main/answerRunner");

const ai = getCopilotAiConfig();
if (!ai.apiKey) throw new Error("OPENROUTER_API_KEY missing");
const t = (source, text, speaker) => ({ source, text, speaker, at: Date.now(), final: true });
const meeting = [
  t(
    "system",
    "So the plan is to move the vector store from Pinecone to Qdrant before the launch.",
    "system:1"
  ),
  t("system", "What is the current GDPR fine ceiling for a data breach, do you know?", "system:2"),
];
const cases = [
  {
    name: "quick+web",
    deliverable: "quick_answer",
    tier: "fast",
    web: true,
    proactive: true,
    focus: "OTHER-2: What is the current GDPR fine ceiling for a data breach, do you know?",
  },
  {
    name: "explain",
    deliverable: "explanation",
    tier: "fast",
    web: false,
    proactive: true,
    focus: "OTHER-1: move the vector store from Pinecone to Qdrant",
  },
  {
    name: "points",
    deliverable: "talking_points",
    tier: "fast",
    web: false,
    proactive: false,
    focus: "Others asked what risks I see with the migration.",
  },
  {
    name: "typed",
    deliverable: "quick_answer",
    tier: "fast",
    web: false,
    proactive: false,
    focus: "What does ARR mean?",
  },
  {
    name: "diagram",
    deliverable: "diagram",
    tier: "reasoning",
    web: false,
    proactive: false,
    focus: "Draw the migration from Pinecone to Qdrant.",
  },
];
const runner = createAnswerRunner({
  model: createMainModel({ apiKey: ai.apiKey, model: ai.model }),
});
for (const c of cases) {
  const card = await runner.run({
    id: c.name,
    ...c,
    context: {
      meeting: { title: "Infra sync" },
      summary: "",
      transcript: meeting,
      contextSeconds: 120,
      thread: [],
    },
  }).done;
  console.log(`\n== ${c.name} (${ai.model})`);
  if (card?.error) {
    console.log("ERROR", card.error);
    continue;
  }
  console.log(
    `title: ${card.title} | conf: ${card.confidence} | first ${card.timing.firstTokenMs}ms total ${card.timing.totalMs}ms | sources ${card.sources.length} | tokens ${card.usage?.total_tokens}`
  );
  console.log(card.body);
}
