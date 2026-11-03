// Side-by-side check of two D1 decision models on identical requests (latency + agreement + accuracy):
//   node scripts/copilot/decider-compare.mjs [--a <model>] [--b <model>] [--repeat 3] [--sessions] [--out <dir>] [trace.jsonl ...]
// Defaults: a = perplexity/pplx-decider-v1.2 (current), b = baseten/elephant-1. Three sets:
//   scenarios  the labelled moments in decision-scenarios.mjs (pass = the scenario's own check)
//   project    labelled "do the project files answer this?" moments over the real project catalog in copilot.db
//              (pass = needs.project matches the label; falls back to a built-in CarZilla catalog)
//   replay     saved meetings: --sessions replays every copilot.db session, *.jsonl are replay-fast traces.
//              Model a drives the engine; every decider call is also sent to b with the same state and questions.
// Every pair is sent at the same time, so network conditions are shared. Results: <out>/decider-compare-<stamp>.json + .md
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
require("dotenv").config({ path: path.join(root, ".env"), quiet: true });
const d = require(path.join(root, "src/copilot/core/decision"));
const { SCENARIOS, base } = await import(
  pathToFileURL(path.join(root, "scripts/copilot/decision-scenarios.mjs")).href
);

const args = process.argv.slice(2);
const arg = (n, dflt) => (args.includes(n) ? args[args.indexOf(n) + 1] : dflt);
const A = arg("--a", "perplexity/pplx-decider-v1.2");
const B = arg("--b", "baseten/elephant-1");
const repeat = Number(arg("--repeat", 3));
const outDir = arg("--out", path.join(root, "copilot-logs/decider-compare"));
const traces = args.filter((a) => a.endsWith(".jsonl"));
const cfg = d.DEFAULT_DECISION_CONFIG;
const env = d.getDecisionEnv();
if (!env.apiKey) throw new Error("No OPENROUTER_API_KEY (or COPILOT_DECISION_KEY) in .env");
const clientFor = (model) =>
  d.createLiquidClient({ apiKey: env.apiKey, url: env.url, model, timeoutMs: 20000 });
const clients = { [A]: clientFor(A), [B]: clientFor(B) };

// ---- copilot.db (read-only): project catalog and saved meetings
const dbPath = path.join(
  process.env.APPDATA ?? path.join(os.homedir(), ".config"),
  "OpenWhispr-development",
  "copilot.db"
);
let db = null;
try {
  const { DatabaseSync } = await import("node:sqlite");
  if (fs.existsSync(dbPath)) db = new DatabaseSync(dbPath, { readOnly: true });
} catch {}
// Same lines the engine hands the decider (retrieve.js catalogLines): "file: first sentence of its summary".
const firstSentence = (s) => String(s ?? "").split(/(?<=\.)\s/)[0];
const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const FALLBACK_CATALOG = [
  "CarZilla Proposal.pdf: This file is PG-AGI's August 2026 technical implementation proposal for CarZilla's v5 online vehicle auction platform.",
  "CarZilla_Project_Completion_Document.pdf: This project completion document outlines CarZilla's live vehicle auction web platform built by PG-AGI (v1.0, September 2026).",
  "CarZilla_Feature_Completion_Document_Phase_2_.pdf: This project completion document by PG-AGI details Phase 2 features for the CarZilla auction platform, dated 14 October 2026.",
];
const dbCatalog = db
  ?.prepare("SELECT name, summary, kind FROM copilot_project_files WHERE status = 'ready'")
  .all()
  .map((r) => `${r.name}: ${clip(firstSentence(r.summary ?? r.kind), 100)}`);
const catalog = dbCatalog?.length ? dbCatalog : FALLBACK_CATALOG;

// ---- project-file moments, labelled by hand: does the catalog plausibly hold the answer?
const NOW = base.now;
const talk = [
  {
    id: 1,
    source: "system",
    speaker: "system:1",
    text: "Thanks for joining, let's go through the CarZilla rollout.",
    at: NOW - 90000,
    final: true,
  },
  {
    id: 2,
    source: "mic",
    text: "Sure, happy to walk through where we are.",
    at: NOW - 80000,
    final: true,
  },
];
const say = (source, text) => ({
  transcript: [
    ...talk,
    {
      id: 3,
      source,
      speaker: source === "system" ? "system:1" : undefined,
      text,
      at: NOW - 3000,
      final: true,
    },
  ],
  newFromId: 3,
});
const PROJECT = [
  ["system", "What bid increment did we agree on for the live auctions?", true],
  ["system", "How long is the Golden Closing window when someone bids in the last second?", true],
  ["system", "What's the pre-authorisation cap on the bidder's card again?", true],
  ["system", "Which AWS region is the platform hosted in?", true],
  ["system", "How many bids per second did the proposal say the engine has to handle?", true],
  ["system", "Is the WhatsApp notification part of phase two or is it still pending?", true],
  ["system", "What referral reward are we giving users who bring a buyer?", true],
  ["mic", "Copilot, which staff roles can be invited in phase two?", true],
  ["system", "And the buyer's premium, is that two or three percent?", true],
  ["system", "Can bidders cancel a bid after placing it, and who approves that?", true],
  ["system", "What was France's GDP last year?", false],
  ["system", "Has anyone checked whether Northwind Capital is still investing in Europe?", false],
  ["system", "What's the dirham to rupee exchange rate today?", false],
  ["system", "Who won the cricket match yesterday?", false],
  ["system", "Great, good to see you all again, how was the weekend?", false],
  ["system", "Can everyone hear me okay?", false],
  ["system", "Thanks everyone, talk to you next week.", false],
].map(([source, text, label]) => [
  text,
  {
    ...say(source, text),
    meeting: { title: "CarZilla phase 2 review", type: "client call" },
    summary: "Reviewing the CarZilla auction platform build and the phase 2 features.",
    projectFiles: catalog,
  },
  label ? "run + project" : "no project",
  (o) => (o.kind === "run" && o.needs.project) === label,
]);

// ---- helpers
const pctl = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]);
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}
// Per-question comparison of two raw answer sets: noul agrees on the same side of 0.5, choice on the same pick.
function compareAnswers(a, b) {
  const rows = {};
  for (const k of Object.keys(a ?? {})) {
    const x = a[k];
    const y = b?.[k];
    if (!y) continue;
    if (x.type === "noul" && y.type === "noul")
      rows[k] = {
        agree: x.noul >= 0.5 === y.noul >= 0.5,
        diff: Math.abs(x.noul - y.noul),
        a: x.noul,
        b: y.noul,
      };
    else if (x.type === "choice" && y.type === "choice")
      rows[k] = { agree: x.choice === y.choice, a: x.choice, b: y.choice };
  }
  return rows;
}
const gate = (ans) =>
  ans?.act?.noul != null && ans?.chatter?.noul != null
    ? ans.act.noul * (1 - ans.chatter.noul) >= cfg.actThreshold.normal
    : null;

// One decide() per model at the same moment; the wrapper keeps the raw answers.
async function decideBoth(input, order) {
  const one = async (model) => {
    let raw = null;
    let ms = null;
    const wrapped = {
      async systemOne(req) {
        const r = await clients[model].systemOne(req);
        raw = r.answers;
        ms = r.ms;
        return r;
      },
    };
    const dec = await d.decide({ input, client: wrapped, cfg });
    return { dec, raw, ms, error: dec.error?.code ?? null };
  };
  const models = order ? [B, A] : [A, B];
  const [first, second] = await Promise.all(models.map(one));
  return order ? { [A]: second, [B]: first } : { [A]: first, [B]: second };
}

async function runLabelled(setName, items) {
  const jobs = [];
  items.forEach((s, i) => {
    for (let r = 0; r < repeat; r++) jobs.push({ i, r });
  });
  const results = await pool(jobs, 4, async ({ i, r }) => {
    const [name, extra, expected, check] = items[i];
    const res = await decideBoth({ ...base, ...extra }, (i + r) % 2 === 1);
    const row = { set: setName, i: i + 1, name, expected, rep: r, models: {} };
    for (const m of [A, B]) {
      const x = res[m];
      row.models[m] = {
        ms: x.ms,
        error: x.error,
        pass: x.error ? false : !!check(x.dec),
        kind: x.dec.kind,
        deliverable: x.dec.deliverable ?? null,
        needs: x.dec.needs ?? null,
        needsProjectP: x.raw?.needs_project?.noul ?? null,
        tokens: x.dec.inputTokens,
        raw: x.raw,
      };
    }
    const a = res[A].dec;
    const b = res[B].dec;
    row.agree = {
      decision: a.kind === b.kind && (a.kind !== "run" || a.deliverable === b.deliverable),
      kind: a.kind === b.kind,
      needs: JSON.stringify(a.needs ?? {}) === JSON.stringify(b.needs ?? {}),
      questions: compareAnswers(res[A].raw, res[B].raw),
    };
    process.stdout.write(".");
    return row;
  });
  return results;
}

// ---- replay: model A drives the engine on a virtual clock; each call is mirrored to B
function sessionTraces() {
  if (!db) return [];
  return db
    .prepare("SELECT id, title FROM copilot_sessions ORDER BY started_at")
    .all()
    .map((s) => ({
      name: `session-${s.id}`,
      title: s.title,
      rows: db
        .prepare(
          "SELECT source, speaker, text, at FROM copilot_segments WHERE session_id = ? ORDER BY seq"
        )
        .all(s.id)
        .filter((g) => g.text && g.at)
        .map((g) => ({
          type: "segment",
          at: new Date(g.at).toISOString(),
          text: g.text,
          source: g.source,
          speaker: g.speaker,
        })),
    }))
    .filter((t) => t.rows.length > 5);
}
async function replay({ name, rows }) {
  const { createEngine } = require(path.join(root, "src/copilot/main/engine"));
  const { fakeClock } = require(path.join(root, "test/copilot/helpers"));
  const clock = fakeClock(Date.parse(rows[0].at));
  const calls = [];
  let inflight = 0;
  let n = 0;
  const mirror = {
    async systemOne(req) {
      inflight++;
      try {
        const flip = n++ % 2 === 1;
        const send = (m) =>
          clients[m].systemOne(req).then(
            (r) => r,
            (e) => ({ error: e.code ?? "error" })
          );
        const pair = flip
          ? (await Promise.all([send(B), send(A)])).reverse()
          : await Promise.all([send(A), send(B)]);
        const [ra, rb] = pair;
        calls.push({
          t: Math.round((clock.now() - Date.parse(rows[0].at)) / 1000),
          newText: req.state.new_text,
          models: {
            [A]: { ms: ra.ms ?? null, error: ra.error ?? null, gate: gate(ra.answers) },
            [B]: { ms: rb.ms ?? null, error: rb.error ?? null, gate: gate(rb.answers) },
          },
          questions: compareAnswers(ra.answers, rb.answers),
        });
        process.stdout.write(".");
        if (ra.error) throw Object.assign(new Error(ra.error), { code: ra.error });
        return ra;
      } finally {
        inflight--;
      }
    },
  };
  const engine = createEngine({
    env: { ...process.env, COPILOT_MAIN: "0", COPILOT_DECISION_MODEL: A },
    logDir: fs.mkdtempSync(path.join(os.tmpdir(), "copilot-cmp-")),
    panel: { send: () => {} },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    client: mirror,
  });
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
      engine.onFinal({
        text: r.text,
        source: r.source,
        speaker: r.speaker,
        timestamp: clock.now(),
      });
    else engine.onPartial({ source: "mic", text: r.on ? "…" : "" });
  }
  await advanceTo(clock.now() + 20000);
  engine.endSession();
  return { name, calls };
}

// ---- summaries
function latencyOf(msList) {
  return {
    n: msList.length,
    p50: pctl(msList, 0.5),
    p90: pctl(msList, 0.9),
    max: pctl(msList, 1),
    mean: Math.round(mean(msList) ?? 0),
  };
}
function questionAgreement(rowsOfQuestions) {
  const per = {};
  for (const qs of rowsOfQuestions)
    for (const [k, v] of Object.entries(qs)) {
      per[k] ??= { n: 0, agree: 0, diffs: [] };
      per[k].n++;
      if (v.agree) per[k].agree++;
      if (v.diff != null) per[k].diffs.push(v.diff);
    }
  return Object.fromEntries(
    Object.entries(per).map(([k, v]) => [
      k,
      {
        n: v.n,
        agreePct: Math.round((100 * v.agree) / v.n),
        meanAbsDiff: v.diffs.length ? +mean(v.diffs).toFixed(3) : null,
      },
    ])
  );
}
function summarizeLabelled(rows) {
  const s = { requests: rows.length, models: {}, agreement: {} };
  for (const m of [A, B]) {
    const xs = rows.map((r) => r.models[m]);
    const byItem = new Map();
    rows.forEach((r) => byItem.set(r.i, [...(byItem.get(r.i) ?? []), r.models[m].pass]));
    s.models[m] = {
      pass: `${xs.filter((x) => x.pass).length}/${xs.length}`,
      passPct: Math.round((100 * xs.filter((x) => x.pass).length) / xs.length),
      flakyItems: [...byItem.values()].filter((v) => v.some(Boolean) && !v.every(Boolean)).length,
      errors: xs.filter((x) => x.error).length,
      latencyMs: latencyOf(xs.filter((x) => x.ms != null).map((x) => x.ms)),
      inputTokensMean: Math.round(mean(xs.map((x) => x.tokens ?? 0))),
    };
  }
  const pct = (f) => Math.round((100 * rows.filter(f).length) / rows.length);
  s.agreement = {
    decisionPct: pct((r) => r.agree.decision),
    kindPct: pct((r) => r.agree.kind),
    needsPct: pct((r) => r.agree.needs),
    perQuestion: questionAgreement(rows.map((r) => r.agree.questions)),
  };
  return s;
}
function summarizeReplay(reps) {
  const calls = reps.flatMap((r) => r.calls);
  const s = { meetings: reps.length, calls: calls.length, models: {} };
  if (!calls.length) return s;
  for (const m of [A, B]) {
    const xs = calls.map((c) => c.models[m]);
    s.models[m] = {
      errors: xs.filter((x) => x.error).length,
      latencyMs: latencyOf(xs.filter((x) => x.ms != null).map((x) => x.ms)),
      gateOpenPct: Math.round((100 * xs.filter((x) => x.gate).length) / xs.length),
    };
  }
  const both = calls.filter((c) => c.models[A].gate != null && c.models[B].gate != null);
  s.gateAgreePct = both.length
    ? Math.round(
        (100 * both.filter((c) => c.models[A].gate === c.models[B].gate).length) / both.length
      )
    : null;
  s.perQuestion = questionAgreement(calls.map((c) => c.questions));
  return s;
}

// ---- run
console.log(
  `A=${A}  B=${B}  repeat=${repeat}  catalog=${dbCatalog?.length ? "copilot.db" : "built-in"}`
);
// One warm-up call each, so a cold connection doesn't count against either model.
await decideBoth({ ...base, ...SCENARIOS[0][1] }, false);
process.stdout.write("scenarios ");
const scenarioRows = await runLabelled("scenarios", SCENARIOS);
process.stdout.write("\nproject ");
const projectRows = await runLabelled("project", PROJECT);
const replays = [];
const sources = [
  ...(args.includes("--sessions") ? sessionTraces() : []),
  ...traces.map((f) => ({
    name: path.basename(f, ".jsonl"),
    rows: fs
      .readFileSync(f, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l)),
  })),
];
for (const t of sources) {
  process.stdout.write(`\nreplay ${t.name} `);
  replays.push(await replay(t));
}
console.log("");

const summary = {
  at: new Date().toISOString(),
  a: A,
  b: B,
  repeat,
  catalog,
  scenarios: summarizeLabelled(scenarioRows),
  project: summarizeLabelled(projectRows),
  replay: summarizeReplay(replays),
};
// Items where either model failed at least once, with the per-model outcomes.
const misses = (rows) => {
  const by = new Map();
  for (const r of rows) {
    const e = by.get(r.i) ?? { i: r.i, name: r.name, expected: r.expected, [A]: [], [B]: [] };
    for (const m of [A, B])
      e[m].push(
        `${r.models[m].pass ? "ok" : "FAIL"} ${r.models[m].kind}${r.models[m].deliverable ? `/${r.models[m].deliverable}` : ""}` +
          (r.models[m].needsProjectP != null
            ? ` proj ${Math.round(r.models[m].needsProjectP * 100)}%`
            : "")
      );
    by.set(r.i, e);
  }
  return [...by.values()].filter((e) => [A, B].some((m) => e[m].some((x) => x.startsWith("FAIL"))));
};
summary.scenarios.misses = misses(scenarioRows);
summary.project.misses = misses(projectRows);

fs.mkdirSync(outDir, { recursive: true });
const stamp = summary.at.replace(/[:.]/g, "-");
const jsonFile = path.join(outDir, `decider-compare-${stamp}.json`);
fs.writeFileSync(
  jsonFile,
  JSON.stringify({ summary, scenarioRows, projectRows, replays }, null, 1)
);

const md = [];
const lat = (l) => (l?.n ? `${l.p50} / ${l.p90} / ${l.max} ms (n=${l.n})` : "-");
md.push(
  `# Decider comparison ${summary.at}`,
  "",
  `A = \`${A}\` · B = \`${B}\` · ${repeat} repeats per labelled item`,
  ""
);
for (const [title, s] of [
  ["Scenarios (decision-scenarios.mjs)", summary.scenarios],
  ["Project-file moments (needs_project)", summary.project],
]) {
  md.push(
    `## ${title}`,
    "",
    "| | pass | flaky items | errors | latency p50 / p90 / max | input tokens |",
    "|---|---|---|---|---|---|"
  );
  for (const m of [A, B]) {
    const x = s.models[m];
    md.push(
      `| ${m} | ${x.pass} (${x.passPct}%) | ${x.flakyItems} | ${x.errors} | ${lat(x.latencyMs)} | ${x.inputTokensMean} |`
    );
  }
  md.push(
    "",
    `Agreement: decision ${s.agreement.decisionPct}% · kind ${s.agreement.kindPct}% · needs ${s.agreement.needsPct}%`,
    ""
  );
  md.push("| question | agree | mean abs diff |", "|---|---|---|");
  for (const [k, v] of Object.entries(s.agreement.perQuestion))
    md.push(`| ${k} | ${v.agreePct}% (n=${v.n}) | ${v.meanAbsDiff ?? "-"} |`);
  if (s.misses.length) {
    md.push("", "Misses:", "");
    for (const e of s.misses)
      md.push(
        `- **${e.i}. ${e.name}** (expect ${e.expected})  \n  A: ${e[A].join(", ")}  \n  B: ${e[B].join(", ")}`
      );
  }
  md.push("");
}
md.push("## Replayed meetings", "");
if (!summary.replay.calls)
  md.push("No meetings replayed (none saved in copilot.db and no traces given).");
else {
  md.push(
    `${summary.replay.meetings} meetings, ${summary.replay.calls} decider calls (A drives the engine). Act-gate agreement ${summary.replay.gateAgreePct}%.`,
    ""
  );
  md.push("| | latency p50 / p90 / max | gate open | errors |", "|---|---|---|---|");
  for (const m of [A, B]) {
    const x = summary.replay.models[m];
    md.push(`| ${m} | ${lat(x.latencyMs)} | ${x.gateOpenPct}% | ${x.errors} |`);
  }
  md.push("", "| question | agree | mean abs diff |", "|---|---|---|");
  for (const [k, v] of Object.entries(summary.replay.perQuestion))
    md.push(`| ${k} | ${v.agreePct}% (n=${v.n}) | ${v.meanAbsDiff ?? "-"} |`);
}
const mdFile = jsonFile.replace(/\.json$/, ".md");
fs.writeFileSync(mdFile, md.join("\n") + "\n");
console.log(md.join("\n"));
console.log(`\nSaved ${jsonFile}\n      ${mdFile}`);
