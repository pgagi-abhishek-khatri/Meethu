// Replays a saved session trace (copilot-logs/sessions/*.jsonl) through the CURRENT decision logic
// with the real D1, at the original timing:  node scripts/copilot/replay-trace.mjs <trace.jsonl> [--speed 2]
// Compare the printed totals with the original session_end stats to see what a change does.
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

const file = process.argv[2];
const speed = process.argv.includes("--speed")
  ? Number(process.argv[process.argv.indexOf("--speed") + 1])
  : 1;
const rows = fs
  .readFileSync(file, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-replay-"));
const service = createEngine({
  env: { ...process.env, COPILOT_LOG: "1", COPILOT_MAIN: "0" },
  logDir,
  panel: {
    send: (e) => {
      if (e.type === "decision")
        console.log(
          `${e.decision.kind.padEnd(7)} ${e.decision.deliverable ?? ""} | ${e.newText.slice(0, 80)} | ${e.decision.reasons.at(-1)}`
        );
    },
  },
});
const t0 = Date.parse(rows[0].at);
const start = Date.now();
for (const r of rows) {
  if (r.type !== "segment" && r.type !== "user_speaking") continue;
  const wait = (Date.parse(r.at) - t0) / speed - (Date.now() - start);
  if (wait > 0) await new Promise((res) => setTimeout(res, wait));
  if (r.type === "segment")
    service.onFinal({ text: r.text, source: r.source, speaker: r.speaker, timestamp: Date.now() });
  else service.onPartial({ source: "mic", text: r.on ? "…" : "" });
}
await new Promise((res) => setTimeout(res, 8000));
console.log(JSON.stringify(service.stats(), null, 1));
service.endSession();
console.log("trace:", logDir);
