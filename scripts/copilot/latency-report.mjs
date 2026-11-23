#!/usr/bin/env node
// Copilot latency report from per-meeting traces (written with COPILOT_LOG=1): where the time goes between a
// final transcript segment and the first words of a card. See docs/copilot/LATENCY_1S_PLAN.md.
//
//   npm run copilot:latency-report                       # every trace in copilot-logs/sessions/
//   npm run copilot:latency-report -- path/to/trace.jsonl [more.jsonl | a directory ...]
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const inputs = args.length ? args : ["copilot-logs/sessions"];
const files = inputs.flatMap((p) =>
  fs.existsSync(p) && fs.statSync(p).isDirectory()
    ? fs
        .readdirSync(p)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => path.join(p, f))
    : [p]
);
if (!files.length) {
  console.error("No trace files found. Record a meeting with COPILOT_LOG=1, or pass a trace path.");
  process.exit(1);
}

const rows = files.flatMap((f) =>
  fs
    .readFileSync(f, "utf8")
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .map((r) => ({ ...r, file: f }))
);

const num = (x) => typeof x === "number" && Number.isFinite(x);
const pct = (values, p) => {
  const a = values.filter(num).sort((x, y) => x - y);
  return a.length ? Math.round(a[Math.min(a.length - 1, Math.floor(a.length * p))]) : null;
};
const by = (type) => rows.filter((r) => r.type === type);

// "final -> first visible": the decision that started a job (decision.jobId) plus the card's own first-visible time.
const decisionsByJob = new Map();
for (const d of by("decision")) if (d.jobId) decisionsByJob.set(`${d.file}:${d.jobId}`, d);
const finalToVisible = by("card_done")
  .map((c) => {
    const d = decisionsByJob.get(`${c.file}:${c.id}`);
    const visible = c.timing?.firstVisibleMs;
    return d && num(d.reactionMs) && num(visible) ? d.reactionMs + visible : null;
  })
  .filter(num);

const lines = [
  ["final -> decision made (reactionMs)", by("decision").map((r) => r.reactionMs)],
  ["  decider call (callMs)", by("decision").map((r) => r.callMs)],
  ["card start -> first visible", by("card_done").map((r) => r.timing?.firstVisibleMs)],
  ["  project search (context.ms)", by("context").map((r) => r.ms)],
  ["  query writer (query_writer.ms)", by("query_writer").map((r) => r.ms)],
  ["  model first token", by("card_done").map((r) => r.timing?.firstTokenMs)],
  ["card start -> card done", by("card_done").map((r) => r.timing?.sinceTriggerMs)],
  ["FINAL -> FIRST VISIBLE (cards)", finalToVisible],
];

const kinds = {};
for (const d of by("decision")) kinds[d.decision?.kind] = (kinds[d.decision?.kind] ?? 0) + 1;
const defers = {};
for (const d of by("defer")) defers[d.reason] = (defers[d.reason] ?? 0) + 1;

console.log(`Copilot latency — ${files.length} trace file(s), ${by("card_done").length} cards\n`);
console.log("stage".padEnd(40), "n".padStart(5), "p50 ms".padStart(8), "p90 ms".padStart(8));
for (const [name, values] of lines) {
  const n = values.filter(num).length;
  console.log(
    name.padEnd(40),
    String(n).padStart(5),
    String(pct(values, 0.5) ?? "-").padStart(8),
    String(pct(values, 0.9) ?? "-").padStart(8)
  );
}
console.log(`\ndecisions: ${JSON.stringify(kinds)}   deferrals: ${JSON.stringify(defers)}`);
if (!finalToVisible.length)
  console.log(
    "(final -> first visible needs traces from this version: card_done.timing.firstVisibleMs and decision.jobId)"
  );
