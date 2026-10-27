// Replays saved session traces through the CURRENT decision logic and the real decider on a virtual clock,
// so a 5-minute meeting takes seconds and many sessions/models run at once:
//   node scripts/copilot/replay-fast.mjs --model <id> [--labels <dir>] [--out <file>] trace1.jsonl trace2.jsonl ...
// Decider calls are instant in virtual time (their real latency is not modelled). With --labels (files named
// like the traces, [{id, worthy}]) it scores: recall = worthy segments inside a decision that ran a card (or
// were skipped as covered right after one); precision = run decisions whose batch holds a worthy segment.
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
require("dotenv").config({ path: path.join(root, ".env"), quiet: true });
const { createEngine } = require(path.join(root, "src/copilot/main/engine"));
const { fakeClock } = require(path.join(root, "test/copilot/helpers"));

const arg = (name) =>
  process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null;
const model = arg("--model");
const labelsDir = arg("--labels");
const outFile = arg("--out");
// --cfg '{"actThreshold":{"normal":0.5},"cooldownMs":6000}' overrides decision config values (one level deep).
const cfgOverride = arg("--cfg") ? JSON.parse(arg("--cfg")) : {};
const { DEFAULT_DECISION_CONFIG } = require(path.join(root, "src/copilot/core/decision/config"));
const decisionCfg = Object.fromEntries(
  Object.entries({ ...DEFAULT_DECISION_CONFIG, ...cfgOverride }).map(([k, v]) => [
    k,
    v && typeof v === "object" && !Array.isArray(v) && cfgOverride[k]
      ? { ...DEFAULT_DECISION_CONFIG[k], ...cfgOverride[k] }
      : v,
  ])
);
const files = process.argv.slice(2).filter((a) => a.endsWith(".jsonl"));

async function replay(file) {
  const rows = fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const clock = fakeClock(Date.parse(rows[0].at));
  const client = (await import("node:module")).createRequire(import.meta.url);
  const { createLiquidClient } = require(path.join(root, "src/copilot/core/decision/liquidClient"));
  const { getDecisionEnv } = require(path.join(root, "src/copilot/core/decision/config"));
  const env = {
    ...process.env,
    COPILOT_LOG: "1",
    COPILOT_MAIN: "0",
    ...(model ? { COPILOT_DECISION_MODEL: model } : {}),
  };
  const e = getDecisionEnv(env);
  const base = createLiquidClient({
    apiKey: e.apiKey,
    url: e.url,
    model: e.model,
    timeoutMs: 30000,
  });
  let inflight = 0;
  const tracked = {
    async systemOne(req) {
      inflight++;
      try {
        return await base.systemOne(req);
      } finally {
        inflight--;
      }
    },
  };
  const decisions = [];
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-fast-"));
  const service = createEngine({
    env,
    logDir,
    panel: {
      send: (ev) => {
        if (ev.type === "decision")
          decisions.push({
            t: Math.round((clock.now() - Date.parse(rows[0].at)) / 1000),
            ids: ev.ids,
            kind: ev.decision.kind,
            deliverable: ev.decision.deliverable ?? null,
            why: (ev.decision.reasons ?? []).slice(-2).join(" | "),
            text: ev.newText,
          });
      },
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    client: tracked,
    decisionCfg,
  });
  // Virtual time only moves while no decider call is outstanding, so a slow call never reorders events.
  const settle = async () => {
    do await new Promise((r) => setTimeout(r, 15));
    while (inflight > 0);
    await clock.advance(0);
  };
  const advanceTo = async (target) => {
    while (clock.now() < target) {
      await clock.advance(Math.min(250, target - clock.now()));
      await settle();
    }
  };
  for (const r of rows) {
    if (r.type !== "segment" && r.type !== "user_speaking") continue;
    await advanceTo(Date.parse(r.at));
    if (r.type === "segment")
      service.onFinal({
        text: r.text,
        source: r.source,
        speaker: r.speaker,
        timestamp: clock.now(),
      });
    else service.onPartial({ source: "mic", text: r.on ? "…" : "" });
  }
  await advanceTo(clock.now() + 20000);
  const stats = service.stats();
  service.endSession();
  return { decisions, stats };
}

function score(decisions, labels, totalSegments) {
  const worthy = new Set(labels.filter((l) => l.worthy).map((l) => l.id));
  const covered = new Set();
  let lastRunT = -1e9;
  let runs = 0;
  let goodRuns = 0;
  for (const d of decisions) {
    if (!d.ids) continue;
    const [a, b] = d.ids;
    const hit = [...worthy].filter((id) => id >= a && id <= b);
    if (d.kind === "run") {
      runs++;
      lastRunT = d.t;
      if (hit.length) goodRuns++;
      hit.forEach((id) => covered.add(id));
    } else if (d.kind === "skip" && d.t - lastRunT <= 120) hit.forEach((id) => covered.add(id));
  }
  return { worthy: worthy.size, covered: covered.size, runs, goodRuns, totalSegments };
}

const results = await Promise.all(
  files.map(async (f) => {
    const name = path.basename(f, ".jsonl");
    const out = await replay(f);
    let sc = null;
    if (labelsDir) {
      const lf = path.join(labelsDir, `${name}.json`);
      if (fs.existsSync(lf)) sc = score(out.decisions, JSON.parse(fs.readFileSync(lf, "utf8")));
    }
    return { name, ...out, score: sc };
  })
);
const tot = { worthy: 0, covered: 0, runs: 0, goodRuns: 0, tokens: 0, calls: 0, decisions: 0 };
for (const r of results) {
  const s = r.score;
  console.log(
    `${r.name}: decisions ${r.stats.decisions} calls ${r.stats.d1Calls} tokens ${r.stats.inputTokens} runs ${r.stats.byKind.run ?? 0}` +
      (s ? ` | recall ${s.covered}/${s.worthy} precision ${s.goodRuns}/${s.runs}` : "")
  );
  tot.tokens += r.stats.inputTokens;
  tot.calls += r.stats.d1Calls;
  tot.decisions += r.stats.decisions;
  if (s) for (const k of ["worthy", "covered", "runs", "goodRuns"]) tot[k] += s[k];
}
console.log(
  `TOTAL model=${model ?? "default"} decisions ${tot.decisions} calls ${tot.calls} tokens ${tot.tokens}` +
    (tot.worthy
      ? ` | recall ${tot.covered}/${tot.worthy} (${((100 * tot.covered) / tot.worthy).toFixed(0)}%) precision ${tot.goodRuns}/${tot.runs} (${((100 * tot.goodRuns) / Math.max(1, tot.runs)).toFixed(0)}%)`
      : "")
);
if (outFile) fs.writeFileSync(outFile, JSON.stringify(results, null, 1));
