// Readable report of one replay (arm-run.mjs) against the labelled moments: for every moment, what the copilot
// did step by step (decided, searched, which documents it found, the card) and whether the card was right; how
// many API calls it made, how long they took and what they cost; and a separate table for the moments where an
// older document (the proposal) and a newer one (a completion document) disagree.
//   node scripts/copilot/precedence-report.mjs --labels labels.json --run run.json --out report.md \
//     [--judge] [--conflicts 2,3,5,11,15] [--older-only 18,20]
// --conflicts: label indexes where the proposal says one thing and a completion document another (the newer
// must win). --older-only: label indexes only the proposal answers (it must still be used).
// --judge grades each card with a model (JUDGE_MODEL, default anthropic/claude-sonnet-5.5); its calls are
// counted and capped too (CAP_USD minus what the run spent, default cap $3).
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
require("dotenv").config({ path: path.join(root, ".env"), quiet: true });
const { postJson } = require(path.join(root, "src/copilot/rag/openrouter"));

const args = process.argv.slice(2);
const arg = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const list = (n) =>
  (arg(n) ?? "")
    .split(",")
    .filter(Boolean)
    .map(Number);
const labels = JSON.parse(fs.readFileSync(arg("--labels"), "utf8"));
const run = JSON.parse(fs.readFileSync(arg("--run"), "utf8"));
const outFile = arg("--out");
const judgeOn = args.includes("--judge");
const conflicts = new Set(list("--conflicts"));
const olderOnly = new Set(list("--older-only"));
const apiKey = process.env.OPENROUTER_API_KEY;
const JUDGE_MODEL = process.env.JUDGE_MODEL || "anthropic/claude-sonnet-5.5";
const CAP_USD = Number(process.env.CAP_USD ?? 3);

const pct = (xs, p) => {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * p))] : null;
};
const ms = (x) => (x == null ? "–" : x >= 1000 ? `${(x / 1000).toFixed(2)} s` : `${Math.round(x)} ms`);
const usd = (x) => `$${(x ?? 0).toFixed(4)}`;
const cell = (s, n = 400) =>
  String(s ?? "")
    .replace(/\|/g, "/")
    .replace(/\s*\n\s*/g, "<br>")
    .slice(0, n);

// ---- the judge (counted and capped)
const judgeCalls = [];
const judgeSpent = () => judgeCalls.reduce((s, c) => s + (c.cost || 0), 0);
async function judge(card, moment) {
  if (!judgeOn) return null;
  if (run.totals.costUsd + judgeSpent() >= CAP_USD) return "not graded (cap)";
  const t = Date.now();
  const res = await postJson(
    "/chat/completions",
    {
      model: JUDGE_MODEL,
      max_tokens: 400, // the judge thinks first; 20 tokens left it no room for the word
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "Grade a meeting-assistant card against the fact from the project files. Answer one word: correct (states the fact, numbers right; also mentioning an older plan that differed is fine), partial (on topic, fact incomplete or vague), wrong (states a different or contradicting number/fact as the current one, e.g. an outdated plan), missing (does not address the fact).",
        },
        {
          role: "user",
          content: `Fact from the files: ${moment.answer}\n\nCard:\n${card.title ?? ""}\n${card.body ?? ""}`,
        },
      ],
    },
    { apiKey, timeoutMs: 60000 }
  );
  judgeCalls.push({ ms: Date.now() - t, cost: Number(res.usage?.cost) || 0 });
  return (
    String(res.choices?.[0]?.message?.content ?? "")
      .toLowerCase()
      .match(/correct|partial|wrong|missing/)?.[0] ?? "missing"
  );
}

// ---- each labelled moment: the decisions whose segments overlap it, the card it got, the search behind it
const cardsById = new Map(run.cards.map((c) => [c.id, c]));
const overlaps = (d, m) => m.segIds.some((id) => id >= d.ids[0] && id <= d.ids[1]);
const searchFor = (card) =>
  card
    ? (run.searches.find((s) => s.focus && s.focus === card.focus) ??
      run.searches.find((s) => s.t >= card.t - 0.05 && s.t <= card.t + 30) ??
      null)
    : null;
const answerFor = (card) =>
  card ? run.calls.find((c) => c.kind === "answer" && c.t >= card.t - 0.05 && c.t <= card.t + 30) : null;

const rows = [];
for (const [i, m] of labels.moments.entries()) {
  const ds = run.decisions.filter((d) => overlaps(d, m));
  const runs = ds.filter((d) => d.kind === "run");
  const cards = runs.map((d) => cardsById.get(d.jobId)).filter((c) => c?.body);
  // the card for this moment: one that used the files if any, else the first
  const card = cards.find((c) => c.files?.length) ?? cards[0] ?? null;
  const search = searchFor(card);
  const answer = answerFor(card);
  const grade = card ? await judge(card, m) : m.needsFiles ? "missing (no card)" : "no card";
  const docs = [...new Set((search?.used ?? []).map((u) => `${u.file}${u.doc ? ` (${u.doc})` : ""}`))];
  rows.push({ i, m, ds, runs, card, search, answer, grade, docs });
}

// ---- numbers
const by = (k) => run.calls.filter((c) => c.kind === k);
const httpBy = new Map();
for (const h of run.http) {
  const key = `${h.path} · ${h.model ?? "?"}`;
  const e = httpBy.get(key) ?? { n: 0, errors: 0, cost: 0, ms: [] };
  e.n++;
  if (h.error || (h.status && h.status >= 400)) e.errors++;
  e.cost += h.cost || 0;
  e.ms.push(h.totalMs ?? h.ms);
  httpBy.set(key, e);
}
const answerCost = by("answer").reduce((s, c) => s + (Number(c.cost) || 0), 0);
const fileRows = rows.filter((r) => r.m.needsFiles);
const count = (rs, g) => rs.filter((r) => r.grade === g).length;
const verdict = (r) => {
  if (r.grade == null) return "not graded";
  if (r.grade === "correct") return "PASS";
  if (r.grade === "partial") return "PARTIAL";
  return "FAIL";
};

// ---- report
const L = [];
const p = (s = "") => L.push(s);
p(`# CarZilla replay: proposal vs completion documents`);
p();
p(
  `Run: ${run.meeting}, ${run.segments} transcript lines, real OpenRouter calls. Models: decider \`${run.models.d1}\`, answer \`${run.models.answer}\`, query writer \`${run.models.writer}\`, embeddings \`${run.models.embed}\`${judgeOn ? `, judge \`${JUDGE_MODEL}\`` : ""}.`
);
if (run.totals.capped)
  p(`\n**STOPPED EARLY: spending cap reached** (${JSON.stringify(run.totals.capped)}). Results below are partial.`);
p();
p(`## Result in one look`);
p();
const conf = rows.filter((r) => conflicts.has(r.i));
const older = rows.filter((r) => olderOnly.has(r.i));
p(`| | Moments | Correct | Partial | Wrong | No card / missing |`);
p(`|---|---|---|---|---|---|`);
const line = (name, rs) =>
  p(
    `| ${name} | ${rs.length} | ${count(rs, "correct")} | ${count(rs, "partial")} | ${count(rs, "wrong")} | ${rs.filter((r) => /missing|no card|cap/.test(r.grade ?? "")).length} |`
  );
line("Proposal vs completion (newer must win)", conf);
line("Only the proposal has it (must still be used)", older);
line("All moments that need the files", fileRows);
p();
p(`## Cost, calls and latency`);
p();
const d1 = by("decide").map((c) => c.ms);
const ans = by("answer").map((c) => c.ms);
const first = by("answer").map((c) => c.firstTokenMs);
const e2e = run.cards.map((c) => c.e2eMs);
const srch = run.searches.map((s) => s.ms);
p(`| What | Value |`);
p(`|---|---|`);
p(`| API requests to OpenRouter (replay) | ${run.totals.httpRequests} |`);
p(`| API requests (judge) | ${judgeCalls.length} |`);
p(`| Total cost | ${usd(run.totals.costUsd + judgeSpent())} (replay ${usd(run.totals.costUsd)}, judge ${usd(judgeSpent())}) — cap ${usd(CAP_USD)} |`);
p(`| Decisions / cards / skipped | ${run.decisions.length} / ${run.cards.length} / ${run.skips.length} |`);
p(`| Decider call (median / p95) | ${ms(pct(d1, 0.5))} / ${ms(pct(d1, 0.95))} |`);
p(`| File search incl. query writer (median / p95) | ${ms(pct(srch, 0.5))} / ${ms(pct(srch, 0.95))} |`);
p(`| Answer model, first words (median / p95) | ${ms(pct(first, 0.5))} / ${ms(pct(first, 0.95))} |`);
p(`| Answer model, full card (median / p95) | ${ms(pct(ans, 0.5))} / ${ms(pct(ans, 0.95))} |`);
p(`| Moment → card on screen (median / p95) | ${ms(pct(e2e, 0.5))} / ${ms(pct(e2e, 0.95))} |`);
p();
p(`Requests by endpoint and model:`);
p();
p(`| Endpoint · model | Requests | Errors | Cost | Median time |`);
p(`|---|---|---|---|---|`);
for (const [k, e] of httpBy)
  p(
    `| ${k} | ${e.n} | ${e.errors} | ${k.includes("chat") && e.cost === 0 ? `${usd(answerCost)} (streamed)` : usd(e.cost)} | ${ms(pct(e.ms, 0.5))} |`
  );
p();

const detail = (r) => {
  const { m, ds, card, search, answer } = r;
  p(`### Moment ${r.i}: ${cell(m.note, 120)} — **${verdict(r)}**${r.grade ? ` (${r.grade})` : ""}`);
  p();
  p(`- **Said in the meeting** (lines ${m.segIds.join(", ")}): "${cell(m.text, 300)}"`);
  p(`- **Expected** (from ${m.file ?? "no file"}): ${m.answer}`);
  p(
    `- **1. Decider**: ${ds.length ? ds.map((d) => `${d.kind}${d.needs?.project ? " + search files" : ""} (${ms(d.d1Ms)})`).join("; ") : "never looked at these lines"}`
  );
  if (!card) {
    p(`- **Card**: none`);
    p();
    return;
  }
  if (search) {
    p(
      `- **2. Search** (${ms(search.ms)}, query writer ${ms(search.expandMs)}): queries ${search.queries?.map((q) => `"${cell(q, 80)}"`).join(", ") ?? "–"}${search.skipped ? ` → skipped: ${search.skipped}` : ""}`
    );
    p(
      `- **3. Found**: ${(search.used ?? []).map((u) => `${u.file}${u.where ? ` ${u.where}` : ""}${u.doc ? ` [${u.doc}${u.addedNewer ? ", added as newer" : ""}]` : ""} (${u.score})`).join("; ") || "nothing"}`
    );
  } else p(`- **2. Search**: none (answered from the catalog and transcript)`);
  if (answer)
    p(
      `- **4. Answer model** (${ms(answer.ms)}, first words ${ms(answer.firstTokenMs)}, ${answer.inputTokens ?? "?"}→${answer.outputTokens ?? "?"} tokens, ${usd(Number(answer.cost) || 0)}): precedence note given: ${answer.precedenceNote ? "yes" : "no"}`
    );
  p(`- **5. Card**: **${cell(card.title, 120)}** — ${cell(card.body, 700)}`);
  p(`- **Card files**: ${(card.files ?? []).join(", ") || "none"}; moment → card ${ms(card.e2eMs)}`);
  p();
};

p(`## Proposal vs completion moments, step by step`);
p();
conf.forEach(detail);
if (older.length) {
  p(`## Moments only the proposal answers, step by step`);
  p();
  older.forEach(detail);
}
p(`## Every other labelled moment`);
p();
p(`| # | Expected | Card | Documents found | Verdict |`);
p(`|---|---|---|---|---|`);
for (const r of rows.filter((x) => !conflicts.has(x.i) && !olderOnly.has(x.i)))
  p(
    `| ${r.i} | ${cell(r.m.answer, 160)} | ${r.card ? `**${cell(r.card.title, 80)}** ${cell(r.card.body, 220)}` : "no card"} | ${cell(r.docs.join(", "), 160) || "–"} | ${verdict(r)}${r.grade ? ` (${r.grade})` : ""} |`
  );
p();
p(
  `Every step (each transcript line, decision, search with its full passages, model call with its reply, HTTP request) is in the steps log next to the run file; the engine's own trace (every decider request and answer, the OKF route) is in its \`sessions/\` folder.`
);

const md = L.join("\n");
if (outFile) fs.writeFileSync(outFile, md);
console.log(md);
