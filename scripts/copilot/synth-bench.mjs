// End-to-end check on written snippets with an expected outcome: decider (D1) -> main-model card.
// node scripts/copilot/synth-bench.mjs <snippets.json> <out.json>
// snippet: {id, context:["OTHER-1: ..."], moment:[...], expected:"card"|"silent", kind, ideal}
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
require(path.join(root, "node_modules/dotenv")).config({
  path: path.join(root, ".env"),
  quiet: true,
});
const {
  decide,
  createLiquidClient,
  getDecisionEnv,
  DEFAULT_DECISION_CONFIG,
  DEFAULT_SETTINGS,
} = require(path.join(root, "src/copilot/core/decision"));
const { getCopilotAiConfig } = require(path.join(root, "src/copilot/config/aiDefaults"));
const { createMainModel } = require(path.join(root, "src/copilot/main/mainCall"));
const { createAnswerRunner } = require(path.join(root, "src/copilot/main/answerRunner"));
const { speakerLabel } = require(path.join(root, "src/copilot/core/decision/buildState"));
const [inFile, outFile] = process.argv.slice(2);
const e = getDecisionEnv();
const d1 = createLiquidClient({ apiKey: e.apiKey, url: e.url, model: e.model, timeoutMs: 30000 });
const ai = getCopilotAiConfig();
const { createCardVerifier } = require(path.join(root, "src/copilot/core/answer/verify"));
const runner = createAnswerRunner({
  model: createMainModel({ apiKey: ai.apiKey, model: ai.model }),
  verify: process.env.NOVERIFY ? null : createCardVerifier({ client: d1 }),
});

const seg = (line, id) => {
  const m = /^(USER|OTHER-(\d+)|NEARBY-(\d+)):\s*(.*)$/s.exec(line.trim());
  const [, who, o, n, text] = m ?? [null, "OTHER-1", "1", null, line];
  return {
    id,
    text,
    final: true,
    at: 1,
    source: who === "USER" || n ? "mic" : "system",
    speaker: who === "USER" ? undefined : o ? `system:${o}` : `mic:${n}`,
  };
};
const snippets = JSON.parse(fs.readFileSync(inFile, "utf8"));
const out = [];
let k = 0;
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (k < snippets.length) {
      const s = snippets[k++];
      const lines = [...s.context, ...s.moment];
      const transcript = lines.map((l, i) => seg(l, i + 1));
      const newFromId = s.context.length + 1;
      const input = (waitedMs) => ({
        now: Date.now(),
        meeting: { title: "Live meeting" },
        summary: "",
        transcript,
        newFromId,
        partial: null,
        recentCards: [],
        running: [],
        settings: DEFAULT_SETTINGS,
        signals: { endpoint: true, userSpeaking: false, sinceLastCardMs: null, waitedMs },
      });
      let dec = await decide({ input: input(0), client: d1, cfg: DEFAULT_DECISION_CONFIG });
      if (dec.kind === "recheck")
        dec = await decide({
          input: input(DEFAULT_DECISION_CONFIG.maxWaitForCompleteMs),
          client: d1,
          cfg: DEFAULT_DECISION_CONFIG,
        });
      let card = null;
      if (dec.kind === "run") {
        card = await runner.run({
          id: `s${s.id}`,
          deliverable: dec.deliverable,
          tier: dec.tier === "reasoning" ? "reasoning" : "fast",
          web: dec.needs.web,
          proactive: dec.trigger !== "explicit",
          focus: transcript
            .slice(newFromId - 1)
            .map((x) => `${speakerLabel(x)}: ${x.text}`)
            .join(" "),
          context: {
            meeting: { title: "Live meeting" },
            summary: "",
            transcript,
            contextSeconds: 0,
            thread: [],
          },
        }).done;
      }
      out.push({
        ...s,
        decision: {
          kind: dec.kind,
          trigger: dec.trigger,
          deliverable: dec.deliverable,
          web: dec.needs?.web,
          why: dec.reasons?.slice(0, 3).join("; "),
        },
        card,
      });
    }
  })
);
out.sort((a, b) => a.id - b.id);
fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
const shown = (o) => o.card && !o.card.skipped && !o.card.error;
const pos = out.filter((o) => o.expected === "card"),
  neg = out.filter((o) => o.expected === "silent");
console.log(
  `positives ${pos.length}: decider ran ${pos.filter((o) => o.decision.kind === "run").length}, card shown ${pos.filter(shown).length} | negatives ${neg.length}: decider ran ${neg.filter((o) => o.decision.kind === "run").length}, card shown ${neg.filter(shown).length}`
);
