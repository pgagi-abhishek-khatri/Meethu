// Compares arm runs (arm-run.mjs) against the labels (label-moments.mjs): did the files get searched when the
// moment needed them (and not when it did not), did the right file reach the card, was the card right, what it
// all cost and how long it took. Several runs of one arm are reported per run and as a median.
//   node scripts/copilot/arm-report.mjs --labels labels.json [--judge] [--out report.md] run1.json run2.json ...
// --judge asks a model (JUDGE_MODEL, default anthropic/claude-sonnet-5.5) whether each card on a file moment
// states the labelled answer: correct / partial / wrong / missing. Costs a little.
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
const labels = JSON.parse(fs.readFileSync(arg("--labels"), "utf8"));
const judge = args.includes("--judge");
const outFile = arg("--out");
const runFiles = args.filter((a) => a.endsWith(".json") && a !== arg("--labels"));
const apiKey = process.env.OPENROUTER_API_KEY;

const med = (xs) => {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  return v.length ? v[Math.floor((v.length - 1) / 2)] : null;
};
const pct = (xs, p) => {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * p))] : null;
};
const ratio = (a, b) => (b ? a / b : null);
const f2 = (x) => (x == null ? "–" : x.toFixed(2));
const f0 = (x) => (x == null ? "–" : Math.round(x).toString());
const usd = (x) => (x == null ? "–" : `$${x.toFixed(4)}`);

// Prices for calls whose response carried no cost (USD per token, from OpenRouter's model list).
let prices = null;
async function priceOf(model) {
  if (!prices) {
    try {
      const r = await fetch("https://openrouter.ai/api/v1/models");
      const j = await r.json();
      prices = new Map(j.data.map((m) => [m.id, m.pricing]));
    } catch {
      prices = new Map();
    }
  }
  return prices.get(model) ?? null;
}
async function costOf(c) {
  if (c.cost != null || c.error) return c.cost ?? 0;
  const p = await priceOf(c.model);
  if (!p) return null;
  return (
    (c.inputTokens ?? c.totalTokens ?? 0) * Number(p.prompt) +
    (c.outputTokens ?? 0) * Number(p.completion)
  );
}

// Truth for a decision: the labelled moments its segment ids overlap.
const momentsFor = (ids) =>
  labels.moments.filter((m) => m.segIds.some((id) => id >= ids[0] && id <= ids[1]));

const judgeCache = new Map();
async function judgeCard(card, moment) {
  const key = `${card.body}|${moment.answer}`;
  if (judgeCache.has(key)) return judgeCache.get(key);
  const res = await postJson(
    "/chat/completions",
    {
      model: process.env.JUDGE_MODEL || "anthropic/claude-sonnet-5.5",
      max_tokens: 20,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "Grade a meeting-assistant card against the fact from the project files. Answer one word: correct (states the fact, numbers right), partial (on topic, fact incomplete or vague), wrong (states a different or contradicting number/fact), missing (does not address the fact).",
        },
        {
          role: "user",
          content: `Fact from the files: ${moment.answer}\n\nCard:\n${card.title ?? ""}\n${card.body ?? ""}`,
        },
      ],
    },
    { apiKey, timeoutMs: 60000 }
  );
  const word =
    String(res.choices?.[0]?.message?.content ?? "")
      .toLowerCase()
      .match(/correct|partial|wrong|missing/)?.[0] ?? "missing";
  judgeCache.set(key, word);
  return word;
}

async function analyse(run) {
  const cardsById = new Map(run.cards.map((c) => [c.id, c]));
  const fileMoments = labels.moments.filter((m) => m.needsFiles);
  const rows = []; // one per decision that ran a card
  for (const d of run.decisions.filter((x) => x.kind === "run")) {
    const ms = momentsFor(d.ids);
    const need = ms.find((m) => m.needsFiles) ?? null;
    const card = cardsById.get(d.jobId) ?? null;
    const gate = run.calls.find((c) => c.kind === "gate" && Math.abs(c.t - d.t) < 3);
    // "asked for the files": D1 said so (needs.project in one call, the gate in two calls)
    const asked =
      run.config.ragTrigger === "twoCall"
        ? (gate?.answers?.needs_project ?? 0) >= 0.5
        : !!d.needs?.project;
    rows.push({
      d,
      need,
      card,
      asked,
      attached: !!card?.files?.length,
      rightFile: !!(need && card?.files?.includes(need.file)),
    });
  }
  const decided = rows.filter((r) => r.need);
  const notNeeded = rows.filter((r) => !r.need);
  // file moments no card was ever made for
  const covered = new Set(rows.flatMap((r) => (r.need ? [r.need] : [])));
  const missedMoments = fileMoments.filter((m) => !covered.has(m));

  const grades = {};
  if (judge)
    for (const r of decided)
      if (r.card?.body) {
        const g = await judgeCard(r.card, r.need);
        grades[g] = (grades[g] ?? 0) + 1;
        r.grade = g;
      }

  // Per labelled file moment, the best grade any of its cards got: a moment usually draws several cards (one per
  // follow-up line), and only one of them has to carry the fact for the user to have it.
  const RANK = ["correct", "partial", "wrong", "missing"];
  const momentBest = fileMoments.map((m) => {
    const got = decided.filter((r) => r.need === m && r.grade).map((r) => r.grade);
    return got.length ? RANK.find((g) => got.includes(g)) : "no card";
  });
  const momentGrades = {};
  for (const g of momentBest) momentGrades[g] = (momentGrades[g] ?? 0) + 1;

  // cost and latency by kind
  const kinds = {};
  for (const c of run.calls) {
    const k = (kinds[c.kind] ??= { n: 0, ms: [], tokens: 0, cost: 0, unpriced: 0, errors: 0 });
    k.n++;
    if (c.error) k.errors++;
    if (c.ms != null && !c.error) k.ms.push(c.ms);
    k.tokens += (c.inputTokens ?? c.totalTokens ?? 0) + (c.outputTokens ?? 0);
    const cost = await costOf(c);
    if (cost == null) k.unpriced++;
    else k.cost += cost;
  }
  const total = Object.values(kinds).reduce((a, k) => a + k.cost, 0);
  const minutes = (run.decisions.at(-1)?.t ?? 60) / 60;
  const cardMs = rows.map((r) => r.card?.e2eMs);
  const fileCardMs = decided.map((r) => r.card?.e2eMs);
  return {
    arm: run.arm,
    cards: rows.length,
    fileMomentsLabelled: fileMoments.length,
    fileMomentsWithCard: decided.length,
    missedMoments: missedMoments.length,
    // searching
    askRecall: ratio(decided.filter((r) => r.asked).length, decided.length),
    askFalse: ratio(notNeeded.filter((r) => r.asked).length, notNeeded.length),
    attachRecall: ratio(decided.filter((r) => r.attached).length, decided.length),
    attachFalse: ratio(notNeeded.filter((r) => r.attached).length, notNeeded.length),
    rightFile: ratio(decided.filter((r) => r.rightFile).length, decided.length),
    wastedSearches: run.searches.filter((s) => s.skipped || !s.used?.length).length,
    searches: run.searches.length,
    grades,
    momentGrades,
    momentBest,
    correct: judge ? ratio(grades.correct ?? 0, decided.filter((r) => r.card?.body).length) : null,
    // cost / latency
    kinds,
    total,
    perHour: (total / Math.max(minutes, 1e-6)) * 60,
    d1Ms: { med: med([...(kinds.decide?.ms ?? [])]), p95: pct(kinds.decide?.ms ?? [], 0.95) },
    gateMs: { med: med(kinds.gate?.ms ?? []), p95: pct(kinds.gate?.ms ?? [], 0.95) },
    cardMs: { med: med(cardMs), p95: pct(cardMs, 0.95) },
    fileCardMs: { med: med(fileCardMs), p95: pct(fileCardMs, 0.95) },
    d1StateChars: med(run.calls.filter((c) => c.kind === "decide").map((c) => c.stateChars)),
    answerPromptChars: med(run.calls.filter((c) => c.kind === "answer").map((c) => c.promptChars)),
    rows: rows.map((r) => ({
      t: r.d.t,
      text: r.d.text?.slice(0, 120),
      need: r.need ? `${r.need.file} p.${r.need.pages.join(",")}` : null,
      asked: r.asked,
      attached: r.card?.files ?? [],
      grade: r.grade ?? null,
    })),
  };
}

const results = [];
for (const f of runFiles)
  results.push({
    file: path.basename(f),
    ...(await analyse(JSON.parse(fs.readFileSync(f, "utf8")))),
  });

const arms = [...new Set(results.map((r) => r.arm))];
const lines = [];
const p = (s = "") => lines.push(s);
p(`# Arm comparison — ${labels.meeting}`);
p(
  `Labels: ${labels.moments.length} card-worthy moments, ${labels.moments.filter((m) => m.needsFiles).length} need the files (${labels.model}).`
);
p();
p(
  "| arm | runs | cards | file moments carded | missed | D1 asked: recall / false | attached: recall / false | right file | correct | searches (wasted) | D1 ms med/p95 | gate ms | card ms med/p95 | file-card ms med/p95 | cost/run | cost/hour |"
);
p("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const a of arms) {
  const rs = results.filter((r) => r.arm === a);
  const m = (k) => med(rs.map((r) => (typeof k === "function" ? k(r) : r[k])));
  p(
    `| ${a} | ${rs.length} | ${f0(m("cards"))} | ${f0(m("fileMomentsWithCard"))}/${rs[0].fileMomentsLabelled} | ${f0(m("missedMoments"))} | ${f2(m("askRecall"))} / ${f2(m("askFalse"))} | ${f2(m("attachRecall"))} / ${f2(m("attachFalse"))} | ${f2(m("rightFile"))} | ${f2(m("correct"))} | ${f0(m("searches"))} (${f0(m("wastedSearches"))}) | ${f0(m((r) => r.d1Ms.med))}/${f0(m((r) => r.d1Ms.p95))} | ${f0(m((r) => r.gateMs.med))} | ${f0(m((r) => r.cardMs.med))}/${f0(m((r) => r.cardMs.p95))} | ${f0(m((r) => r.fileCardMs.med))}/${f0(m((r) => r.fileCardMs.p95))} | ${usd(m("total"))} | ${usd(m("perHour"))} |`
  );
}
p();
p("## Cost and calls by model (median over runs)");
p("| arm | kind | calls | errors | tokens | cost | median ms |");
p("|---|---|---|---|---|---|---|");
for (const a of arms) {
  const rs = results.filter((r) => r.arm === a);
  const kinds = [...new Set(rs.flatMap((r) => Object.keys(r.kinds)))];
  for (const k of kinds) {
    const m = (fn) => med(rs.map((r) => (r.kinds[k] ? fn(r.kinds[k]) : null)));
    p(
      `| ${a} | ${k} | ${f0(m((x) => x.n))} | ${f0(m((x) => x.errors))} | ${f0(m((x) => x.tokens))} | ${usd(m((x) => x.cost))} | ${f0(m((x) => med(x.ms)))} |`
    );
  }
}
p();
p(
  `D1 state size (chars, median): ${arms.map((a) => `${a} ${f0(med(results.filter((r) => r.arm === a).map((r) => r.d1StateChars)))}`).join(", ")}; answer prompt: ${arms.map((a) => `${a} ${f0(med(results.filter((r) => r.arm === a).map((r) => r.answerPromptChars)))}`).join(", ")}`
);
p();
if (judge) {
  const fileMoments = labels.moments.filter((m) => m.needsFiles);
  const runs = arms.map((a) => results.find((x) => x.arm === a));
  p("## Per file moment: best card grade (first run of each arm)");
  p(
    `Totals: ${runs.map((r) => `${r.arm} ${["correct", "partial", "wrong", "missing", "no card"].map((g) => `${g} ${r.momentGrades[g] ?? 0}`).join(", ")}`).join(" · ")}`
  );
  p();
  p(`| moment | strength | ${arms.join(" | ")} |`);
  p(`|---|---|${arms.map(() => "---").join("|")}|`);
  fileMoments.forEach((m, i) =>
    p(
      `| [${m.segIds.join(",")}] ${m.text.slice(0, 70).replace(/\|/g, "/")} | ${m.strength ?? ""} | ${runs.map((r) => r.momentBest[i]).join(" | ")} |`
    )
  );
  p();
}
p("## Card by card (first run of each arm)");
for (const a of arms) {
  const r = results.find((x) => x.arm === a);
  p(`### ${a} (${r.file})`);
  p("| t | moment | needs (label) | D1 asked | files attached | grade |");
  p("|---|---|---|---|---|---|");
  for (const row of r.rows)
    p(
      `| ${row.t} | ${String(row.text ?? "").replace(/\|/g, "/")} | ${row.need ?? ""} | ${row.asked ? "yes" : ""} | ${row.attached.join(", ")} | ${row.grade ?? ""} |`
    );
  p();
}
const md = lines.join("\n");
if (outFile) fs.writeFileSync(outFile, md);
console.log(md);
