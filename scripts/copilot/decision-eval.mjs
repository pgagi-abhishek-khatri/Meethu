// Pass-rate eval for the D1 decision layer: node scripts/copilot/decision-eval.mjs [--repeat 2] [--only 3,4] [-v]
// Calls the live model (OpenRouter liquid/d1). Prints failures with D1's own numbers, tokens and latency.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS, base } from "./decision-scenarios.mjs";

const require = createRequire(import.meta.url);
require("dotenv").config({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "../../.env"),
  quiet: true,
});
const d = require("../../src/copilot/core/decision");

const args = process.argv.slice(2);
const repeat = args.includes("--repeat") ? Number(args[args.indexOf("--repeat") + 1]) : 1;
const only = args.includes("--only")
  ? args[args.indexOf("--only") + 1].split(",").map(Number)
  : null;
const verbose = args.includes("-v");
const client = d.createLiquidClient({ ...d.getDecisionEnv(), timeoutMs: 10000 });

let pass = 0,
  total = 0,
  tokens = 0,
  calls = 0;
const lat = [];
for (const [i, [name, extra, expected, check]] of SCENARIOS.entries()) {
  if (only && !only.includes(i + 1)) continue;
  const results = await Promise.all(
    Array.from({ length: repeat }, () => d.decide({ input: { ...base, ...extra }, client }))
  );
  const oks = results.map((r) => check(r));
  total += results.length;
  pass += oks.filter(Boolean).length;
  for (const r of results) {
    tokens += r.inputTokens;
    calls++;
    lat.push(Math.max(r.latency.gateMs ?? 0, r.latency.fullMs ?? 0));
  }
  const mark = oks.every(Boolean) ? "ok  " : oks.some(Boolean) ? "FLAKY" : "FAIL";
  if (mark !== "ok  " || verbose) {
    console.log(`${mark} ${String(i + 1).padStart(2)}. ${name}  (expect: ${expected})`);
    for (const r of results)
      console.log(
        `       -> ${r.kind}${r.kind === "run" ? ` ${r.deliverable}/${r.tier}` : ""} | ${r.reasons.join("; ")}`
      );
  } else console.log(`${mark} ${String(i + 1).padStart(2)}. ${name}`);
}
lat.sort((a, b) => a - b);
console.log(
  `\n${pass}/${total} passed | ${Math.round(tokens / calls)} input tokens per decision | slowest-stage latency median ${Math.round(lat[Math.floor(lat.length / 2)])}ms p90 ${Math.round(lat[Math.floor(lat.length * 0.9)])}ms`
);
