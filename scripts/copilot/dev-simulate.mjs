// End-to-end simulation of the dev harness with the REAL models and real timing:
//   node scripts/copilot/dev-simulate.mjs [--speed 1.5]
// Feeds a scripted client call through createEngine (partials, finals, speaker labels), prints
// what was skipped, what D1 decided and when, then call-frequency / latency / token statistics.
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
require("dotenv").config({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "../../.env"),
  quiet: true,
});
const { createEngine } = require("../../src/copilot/main/engine");

const speed = process.argv.includes("--speed")
  ? Number(process.argv[process.argv.indexOf("--speed") + 1])
  : 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms / speed));

// [source, text, pause-after-ms]
const MEETING = [
  ["system", "Hi everyone, thanks for making time today.", 1200],
  ["mic", "Happy to be here, how was your weekend?", 1500],
  ["system", "Pretty good, I was hiking. Okay, shall we get started?", 1500],
  ["mic", "Yes, let's do it.", 1200],
  ["system", "So the main thing today is our expansion into Europe next quarter.", 2200],
  [
    "system",
    "We are thinking France and Germany first, and the budget is around two million euros.",
    2500,
  ],
  ["mic", "That sounds reasonable. What timeline are you picturing?", 2200],
  [
    "system",
    "We would like to launch in September, which means contracts need to be signed by July.",
    2500,
  ],
  ["system", "Our current churn is down to two percent, which is the best in our industry.", 2500],
  ["mic", "Great, that is a strong number.", 1500],
  ["system", "Right. Now, one thing that worries the board is GDPR compliance.", 2400],
  [
    "system",
    "Has anyone looked into what a data processing agreement actually requires for us?",
    3000,
  ],
  ["mic", "I can take that one, I will look into it this week.", 2200],
  ["system", "Perfect. Let me share my screen so you can see the rollout plan.", 2500],
  [
    "system",
    "As you can see on this slide, the first phase is Paris, then Munich, then Berlin.",
    2800,
  ],
  [
    "system",
    "Each phase has a go no go review that goes through regional sales, then legal, then finance, and over five hundred thousand it needs the CFO.",
    3200,
  ],
  ["mic", "Okay, makes sense.", 1500],
  ["system", "Sorry, you are on mute for a second there.", 1500],
  ["mic", "Can you hear me now?", 1500],
  ["system", "Yes, loud and clear.", 1500],
  [
    "system",
    "So should we go with a local partner in Germany or hire our own team directly?",
    3000,
  ],
  [
    "mic",
    "Copilot, what are the usual pros and cons of a local partner versus our own team for a market entry?",
    3500,
  ],
  ["system", "While you think about that, let me grab some water.", 2500],
  ["system", "Back. Another question, what was the Eurozone inflation rate last month?", 3000],
  ["mic", "I am not sure, let me check that.", 2000],
  ["system", "No worries. Let's wrap up, thanks everyone, talk next week.", 1500],
];

const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-sim-"));
const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s`;
const pct = (v) => (typeof v === "number" ? Math.round(v * 100) + "%" : "-");

const panel = {
  open() {},
  send(e) {
    if (e.type === "segment")
      console.log(
        `${ts()}  ${e.label.padEnd(8)} ${e.text.slice(0, 80)}   ${e.trigger ? "→ " + e.reason : "[skipped: " + e.reason + "]"}`
      );
    else if (e.type === "decision") {
      const d = e.decision;
      const what =
        d.kind === "run"
          ? ` ${d.trigger} ${d.deliverable}/${d.tier} ${Object.entries(d.needs)
              .filter(([, v]) => v)
              .map(([k]) => k)
              .join("+")} thread:${d.thread.kind}`
          : "";
      console.log(
        `${ts()}  ★ D1 ${d.kind.toUpperCase()}${what}  (${Math.round(e.callMs)}ms call, ${Math.round(e.reactionMs ?? 0)}ms after speech, ${e.inputTokens} tok)\n          ${d.reasons.join("; ")}`
      );
    } else if (e.type === "summary")
      console.log(`${ts()}  ✎ summary updated (${e.text.length} chars): ${e.text}`);
  },
};

const service = createEngine({ logDir, panel, env: { ...process.env, COPILOT_MAIN: "0" } });
for (const [source, text, pause] of MEETING) {
  const words = text.split(" ");
  for (const cut of [Math.ceil(words.length / 3), Math.ceil((2 * words.length) / 3)]) {
    service.onPartial({ source, text: words.slice(0, cut).join(" ") });
    await sleep(350);
  }
  service.onFinal({
    text,
    source,
    timestamp: Date.now(),
    speaker: source === "system" ? "system:1" : undefined,
  });
  await sleep(pause);
}
await new Promise((r) => setTimeout(r, 6000)); // let the last decision and summary finish
const s = service.stats();
service.endSession();
console.log(`\n=== ${s.minutes} min, ${s.segments} segments ===
D1 calls: ${s.d1Calls} for ${s.decisions} decisions (${MEETING.length} segments, ${s.scheduler.partialsIgnored} partials ignored)
decisions: run ${s.byKind.run}, wait ${s.byKind.wait}, skip ${s.byKind.skip}, recheck ${s.byKind.recheck}
segments skipped before D1: filler ${s.scheduler.skipped.filler}, too short ${s.scheduler.skipped.too_short}
D1 call latency: median ${Math.round(s.callMsMedian)}ms p90 ${Math.round(s.callMsP90)}ms | reaction after speech median ${Math.round(s.reactionMsMedian)}ms
input tokens: ${s.inputTokens} total, ${s.avgTokensPerDecision}/decision (${(s.inputTokens * 0.04e-6).toFixed(5)} USD)
summary: ${s.summary.updates} updates, ${s.summary.failures} failures, ${s.summary.chars} chars
log: ${logDir}/copilot-decisions.jsonl`);
