// Card-quality bench: regenerates answer cards for "run" decisions of a replay result (replay-fast --out) using
// the real main model, so cards can be graded. node scripts/copilot/card-bench.mjs <replay.json> <segments-dir> <out.json> [perMeeting=4]
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
require(path.join(root, "node_modules/dotenv")).config({
  path: path.join(root, ".env"),
  quiet: true,
});
const { getCopilotAiConfig } = require(path.join(root, "src/copilot/config/aiDefaults"));
const { createMainModel } = require(path.join(root, "src/copilot/main/mainCall"));
const { createAnswerRunner } = require(path.join(root, "src/copilot/main/answerRunner"));
const { speakerLabel } = require(path.join(root, "src/copilot/core/decision/buildState"));
const [replayFile, segDir, outFile, per = "4"] = process.argv.slice(2);
const ai = getCopilotAiConfig();
const { createLiquidClient } = require(path.join(root, "src/copilot/core/decision/liquidClient"));
const { getDecisionEnv } = require(path.join(root, "src/copilot/core/decision/config"));
const { createCardVerifier } = require(path.join(root, "src/copilot/core/answer/verify"));
const de = getDecisionEnv();
const runner = createAnswerRunner({
  model: createMainModel({ apiKey: ai.apiKey, model: ai.model }),
  verify: process.env.NOVERIFY
    ? null
    : createCardVerifier({
        client: createLiquidClient({
          apiKey: de.apiKey,
          url: de.url,
          model: de.model,
          timeoutMs: 30000,
        }),
      }),
});
const replay = JSON.parse(fs.readFileSync(replayFile, "utf8"));
const jobs = [];
for (const m of replay) {
  const f = path.join(segDir, `${m.name}.jsonl`);
  if (!fs.existsSync(f)) continue;
  const segs = fs
    .readFileSync(f, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((x) => x.type === "segment")
    .map((s, k) => ({ ...s, id: s.id ?? k + 1, final: true, at: 1 }));
  if (process.env.MEETINGS && !new RegExp(process.env.MEETINGS).test(m.name)) continue;
  // ALL=1: every decision of the meeting (the decider's waits and skips become silent outcomes), to measure recall too.
  const runs = process.env.ALL
    ? m.decisions.filter((d) => d.ids)
    : m.decisions.filter((d) => d.kind === "run");
  const step = Math.max(1, Math.floor(runs.length / +per));
  for (const d of process.env.ALL
    ? runs
    : runs.filter((_, i) => i % step === (+process.env.OFFSET || 0)).slice(0, +per)) {
    const fresh = segs.filter((s) => s.id >= d.ids[0] && s.id <= d.ids[1]);
    jobs.push({
      decider: d.kind,
      meeting: m.name,
      ids: d.ids,
      trigger: /explicit/.test(d.why) ? "explicit" : "proactive",
      web: /web \d+%/.test(d.why),
      deliverable: d.deliverable ?? "quick_answer",
      focus: fresh.map((s) => `${speakerLabel(s)}: ${s.text}`).join(" "),
      transcript: segs.filter((s) => s.id <= d.ids[1]).slice(-25),
    });
  }
}
const out = [];
let k = 0;
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (k < jobs.length) {
      const j = jobs[k++];
      if (j.decider !== "run") {
        out.push({
          meeting: j.meeting,
          ids: j.ids,
          trigger: j.trigger,
          web: false,
          deliverable: null,
          context: j.transcript.slice(-8).map((s) => `${speakerLabel(s)}: ${s.text}`),
          focus: j.focus,
          card: { skipped: true, reason: `decider:${j.decider}` },
        });
        continue;
      }
      const card = await runner.run({
        id: `c${k}`,
        deliverable: j.deliverable,
        tier: j.deliverable === "diagram" || j.deliverable === "document" ? "reasoning" : "fast",
        web: j.web,
        proactive: j.trigger !== "explicit",
        focus: j.focus,
        context: {
          meeting: { title: "Live meeting" },
          summary: "",
          transcript: j.transcript,
          contextSeconds: 0,
          thread: [],
        },
      }).done;
      out.push({
        meeting: j.meeting,
        ids: j.ids,
        trigger: j.trigger,
        web: j.web,
        deliverable: j.deliverable,
        context: j.transcript.slice(-8).map((s) => `${speakerLabel(s)}: ${s.text}`),
        focus: j.focus,
        card,
      });
    }
  })
);
fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
console.log(
  "cards",
  out.length,
  "errors",
  out.filter((o) => o.card?.error).length,
  "ms median",
  out
    .map((o) => o.card?.timing?.totalMs)
    .filter(Boolean)
    .sort((a, b) => a - b)[Math.floor(out.length / 2)]
);
