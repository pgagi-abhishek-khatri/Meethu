// Runs realistic meeting moments through the D1 decision layer.
//   node scripts/copilot/decision-probe.mjs            live via OpenRouter liquid/d1 (OPENROUTER_API_KEY in .env)
//   node scripts/copilot/decision-probe.mjs --dry 7    print scenario 7's exact requests, call nothing
//   node scripts/copilot/decision-probe.mjs --only 3,4 run a subset
// Prints what the layer decided next to what a sensible human would expect.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
require("dotenv").config({ path: path.join(root, ".env"), quiet: true });
const d = require("../../src/copilot/core/decision");

const NOW = Date.now();
const seg = (id, source, text, agoS, speaker) => ({
  id,
  source,
  text,
  speaker,
  at: NOW - agoS * 1000,
  final: true,
});
const base = {
  now: NOW,
  meeting: { title: "Q3 planning with Acme", type: "client call" },
  summary: "Acme wants to expand to Europe next quarter. We are discussing budget and timeline.",
  settings: {
    quiet: "normal",
    web: true,
    projectFiles: true,
    screenshot: true,
    diagrams: true,
    documents: true,
  },
  signals: { endpoint: true, sinceLastCardMs: 60000 },
};
const talk = [
  seg(1, "system", "Thanks for joining everyone.", 90, "system:1"),
  seg(2, "mic", "Happy to be here, let's get started.", 80),
];

const SCENARIOS = [
  [
    "factual question to the user",
    {
      transcript: [
        ...talk,
        seg(3, "system", "Quick one: what was France's GDP last year?", 4, "system:1"),
      ],
      newFromId: 3,
    },
    "run, web, quick_answer, fast",
  ],
  [
    "small talk",
    {
      transcript: [
        ...talk,
        seg(3, "system", "Great, good to see you all again, how was the weekend?", 4, "system:1"),
      ],
      newFromId: 3,
    },
    "wait",
  ],
  [
    "sentence unfinished",
    {
      signals: { endpoint: false, waitedMs: 0 },
      transcript: [
        ...talk,
        seg(3, "system", "So what we really need to decide today is whether we", 2, "system:1"),
      ],
      newFromId: 3,
    },
    "recheck",
  ],
  [
    "user asks the assistant",
    {
      transcript: [
        ...talk,
        seg(3, "mic", "Copilot, check what the current US Federal Reserve rate is.", 3),
      ],
      newFromId: 3,
    },
    "run, explicit, web",
  ],
  [
    "unfamiliar term",
    {
      transcript: [
        ...talk,
        seg(
          3,
          "system",
          "We would structure it as a SAFE note with a valuation cap and a pro rata side letter.",
          4,
          "system:1"
        ),
      ],
      newFromId: 3,
    },
    "run, explanation",
  ],
  [
    "someone asks the user for input",
    {
      transcript: [
        ...talk,
        seg(
          3,
          "system",
          "Can you walk us through your proposed timeline for the rollout?",
          4,
          "system:1"
        ),
      ],
      newFromId: 3,
    },
    "run, talking_points",
  ],
  [
    "new text narrows a running analysis",
    {
      running: [
        { id: "j1", topic: "France economy overview", status: "generating", startedAt: NOW - 3000 },
      ],
      transcript: [
        ...talk,
        seg(3, "system", "What was France's GDP last year?", 9, "system:1"),
        seg(4, "system", "Sorry, I meant per capita, not total.", 3, "system:1"),
      ],
      newFromId: 4,
    },
    "run, supersede j1",
  ],
  [
    "already answered by a recent card",
    {
      recentCards: [
        {
          kind: "quick_answer",
          gist: "France GDP 2024 was about 3.1 trillion euros",
          shownAt: NOW - 25000,
          reaction: "pinned",
        },
      ],
      transcript: [
        ...talk,
        seg(3, "system", "So France is roughly three trillion euros then.", 4, "system:1"),
      ],
      newFromId: 3,
    },
    "skip or wait",
  ],
  [
    "refers to something on screen",
    {
      transcript: [
        ...talk,
        seg(
          3,
          "system",
          "As you can see on this slide, margin dropped from 32 to 24 percent.",
          4,
          "system:1"
        ),
      ],
      newFromId: 3,
    },
    "run, screenshot",
  ],
  [
    "user asks for a document",
    {
      transcript: [
        ...talk,
        seg(3, "mic", "Copilot, draft a follow-up email with the action items we agreed.", 3),
      ],
      newFromId: 3,
    },
    "run, document",
  ],
  [
    "process that suits a diagram",
    {
      transcript: [
        ...talk,
        seg(
          3,
          "system",
          "Approvals go from sales to legal, then finance, then back to the regional director, unless it is over fifty thousand, then the CFO signs.",
          5,
          "system:1"
        ),
      ],
      newFromId: 3,
    },
    "run, diagram offered",
  ],
  [
    "topic switch with a thread open",
    {
      threads: [{ id: "t1", title: "Europe budget", gist: "headcount and spend for EU launch" }],
      transcript: [
        ...talk,
        seg(
          3,
          "system",
          "Separately, who is handling the GDPR data processing agreement?",
          4,
          "system:1"
        ),
      ],
      newFromId: 3,
    },
    "run, new thread",
  ],
];

const only = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1].split(",").map(Number)
  : null;
const dryIdx = process.argv.includes("--dry")
  ? Number(process.argv[process.argv.indexOf("--dry") + 1])
  : null;

if (dryIdx) {
  const [name, extra] = SCENARIOS[dryIdx - 1];
  const input = { ...base, ...extra };
  const ctx = {
    settings: { ...d.DEFAULT_SETTINGS, ...input.settings },
    running: input.running ?? [],
    hasCards: !!input.recentCards?.length,
  };
  const { questions } = d.buildQuestions(ctx);
  console.log(
    `# ${name}\nSTATE:\n${JSON.stringify(d.buildDecisionState(input, d.DEFAULT_DECISION_CONFIG), null, 2)}\nQUESTIONS: ${Object.keys(questions).join(", ")}`
  );
  process.exit(0);
}

const env = d.getDecisionEnv();
if (!env.apiKey) {
  console.error("OPENROUTER_API_KEY missing in .env. Use --dry N to preview requests.");
  process.exit(1);
}
const client = d.createLiquidClient({ ...env, timeoutMs: 8000 });
const ms = (v) => (v == null ? "-" : `${Math.round(v)}ms`);
for (const [i, [name, extra, expected]] of SCENARIOS.entries()) {
  if (only && !only.includes(i + 1)) continue;
  const out = await d.decide({ input: { ...base, ...extra }, client });
  const summary =
    out.kind === "run"
      ? `run ${out.trigger} ${out.deliverable}/${out.tier} ${
          Object.entries(out.needs)
            .filter(([, v]) => v)
            .map(([k]) => k)
            .join("+") || "no-needs"
        } thread:${out.thread.kind}${out.cancelJobId ? ` replace:${out.cancelJobId}` : ""}${out.offers.length ? ` offers:${out.offers}` : ""}`
      : out.kind;
  console.log(
    `${String(i + 1).padStart(2)}. ${name}\n    got:      ${summary}\n    expected: ${expected}\n    why:      ${out.reasons.join("; ")}\n    cost:     gate ${ms(out.latency.gateMs)} full ${ms(out.latency.fullMs)}, ${out.inputTokens} input tokens`
  );
}
