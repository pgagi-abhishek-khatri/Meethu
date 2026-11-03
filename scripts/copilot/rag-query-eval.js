// End-to-end check of the project-file search on labelled meeting moments: decider -> query writing -> embedding ->
// hybrid search -> (optionally) the answer card. Each moment is a noisy stretch of talk plus the fact a correct
// search must bring back (a regex over the kept passages, and over the card with --answer).
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/copilot/rag-query-eval.js <userDataDir> [--repeat 2] [--answer] [--out <dir>]
// <userDataDir> holds a copilot.db with an indexed project (use a copy: the store may migrate it). Variants:
//   current     retrieve.js as committed at HEAD: the moment's last 400 chars only, keyword-only hits dropped
//   fix         this tree, no written queries: keyword-only hits scored, "near the best" judged per query
//   kw          fix + the query model's queries, used for keyword search only (no extra embedding call)
//   embed       fix + the query model's queries, embedded too (one more embedding round trip)
// The decider runs for real once per moment and repeat; each variant then waits as long as it took (with the
// moment's embedding prefetched meanwhile, as the engine does) before searching, so "ready" is moment -> passages.
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "../../.env"), quiet: true });
const { openStore } = require("../../src/copilot/main/store");
const { createEmbedClient } = require("../../src/copilot/rag/embedClient");
const { createRetriever } = require("../../src/copilot/rag/retrieve");
// The committed retriever, for an honest baseline: loaded from git with its requires pointed at this tree.
const os = require("os");
const { execSync } = require("child_process");
const headRetriever = (() => {
  const src = execSync("git show HEAD:src/copilot/rag/retrieve.js", {
    cwd: path.join(__dirname, "../.."),
  })
    .toString()
    .replace(
      /require\("\.\/(\w+)"\)/g,
      (_, m) => `require(${JSON.stringify(path.join(__dirname, "../../src/copilot/rag", m))})`
    );
  const f = path.join(os.tmpdir(), `retrieve-head-${process.pid}.js`);
  fs.writeFileSync(f, src);
  return require(f).createRetriever;
})();
const { createQueryWriter } = require("../../src/copilot/rag/queryWriter");
const { RAG } = require("../../src/copilot/rag/config");
const d = require("../../src/copilot/core/decision");
const { getCopilotAiConfig } = require("../../src/copilot/config/aiDefaults");
const { createMainModel } = require("../../src/copilot/main/mainCall");
const { createAnswerRunner } = require("../../src/copilot/main/answerRunner");

const args = process.argv.slice(2);
const arg = (n, dflt) => (args.includes(n) ? args[args.indexOf(n) + 1] : dflt);
const dir = args[0];
const repeat = Number(arg("--repeat", 2));
const withAnswer = args.includes("--answer");
const outDir = arg("--out", path.join(__dirname, "../../copilot-logs/rag-query-eval"));
const apiKey = process.env.OPENROUTER_API_KEY;
const queryModel = arg("--query-model", RAG.queryModel);
const embedModel = arg("--embed-model", RAG.embedModel);

const { MOMENTS } = require("./rag-eval-moments");

const pctl = (xs, p) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]) : null;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const store = openStore({ dbPath: path.join(dir, "copilot.db") });
  const pids = store.projects
    .list()
    .map((p) => p.id)
    .filter((id) => store.rag.hasIndex(id));
  if (!pids.length) throw new Error("no indexed project in this copilot.db");
  const d1Base = d.createLiquidClient({ ...d.getDecisionEnv(), timeoutMs: 10000 });
  let lastAnswers = null; // the decider's own probabilities (interpret() keeps only some)
  const d1 = {
    systemOne: async (req) => (
      (lastAnswers = null),
      await d1Base.systemOne(req).then((r) => ((lastAnswers = r.answers), r))
    ),
  };
  const writer = createQueryWriter({ apiKey, model: queryModel });
  const ai = getCopilotAiConfig();
  const mainModel = withAnswer ? createMainModel({ apiKey: ai.apiKey, model: ai.model }) : null;
  const VARIANTS = [
    { name: "current", head: true },
    { name: "fix", queries: false },
    { name: "kw", queries: true, embedWritten: false },
    { name: "embed", queries: true, embedWritten: true },
  ];
  // a fresh embed client per variant and moment: no variant gets another's cached vectors
  const retrieverFor = (v, embed) =>
    (v.head ? headRetriever : createRetriever)({
      rag: store.rag,
      clients: () => ({ embed }),
      cfg: { ...RAG, embedWritten: !!v.embedWritten },
    });
  const catalogLines = createRetriever({ rag: store.rag, clients: () => null }).catalogLines(pids);
  const catalogText = createRetriever({ rag: store.rag, clients: () => null }).catalog(pids);
  const rows = [];
  const base = d.DEFAULT_SETTINGS;
  for (let rep = 0; rep < repeat; rep++)
    for (const [i, m] of MOMENTS.entries()) {
      const now = Date.now();
      const transcript = m.lines.map((l, k) => {
        const [who, ...rest] = l.split(":");
        const n = /OTHER-(\d)/.exec(who)?.[1];
        return {
          id: k + 1,
          source: who === "USER" ? "mic" : "system",
          speaker: n ? `system:${n}` : undefined,
          text: rest.join(":").trim(),
          at: now - (m.lines.length - k) * 4000,
          final: true,
        };
      });
      const focus = m.lines.join(" ");
      const gist =
        [...m.lines]
          .reverse()
          .find((l) => l.includes("?"))
          ?.replace(/^[A-Z0-9-]+:\s*/, "") ?? focus;
      const dec = await d.decide({
        input: {
          now,
          meeting: { title: "CarZilla phase 2 review", type: "client call" },
          summary: "Reviewing the CarZilla auction platform build and phase 2 features.",
          transcript,
          newFromId: 1,
          settings: { ...base, projectFiles: true },
          signals: { endpoint: true, sinceLastCardMs: 60000 },
          projectFiles: catalogLines,
        },
        client: d1,
      });
      const d1Ms = dec.latency.gateMs ?? 0;
      const projectAsked = dec.kind === "run" && !!dec.needs?.project;
      const row = {
        rep,
        i: i + 1,
        question: gist,
        gold: m.gold ? String(m.gold) : null,
        d1: {
          ms: Math.round(d1Ms),
          kind: dec.kind,
          deliverable: dec.deliverable ?? null,
          needsProject: lastAnswers?.needs_project?.noul ?? null,
          projectAsked,
        },
        variants: {},
      };
      await Promise.all(
        VARIANTS.map(async (v) => {
          const embed = createEmbedClient({ apiKey, model: embedModel });
          const r = retrieverFor(v, embed);
          const t0 = Date.now();
          r.prefetch(focus, pids); // the engine warms this while the decider runs
          await sleep(d1Ms);
          // The decider asked for the files: always search. Otherwise the unasked look with its closeness bar.
          const out = await r.retrieve({
            query: focus,
            projectIds: pids,
            why: projectAsked ? "decider" : "auto",
            minScore: projectAsked ? 0 : RAG.autoScore,
            expand: v.queries
              ? (q) => writer({ moment: focus, gist, catalog: catalogLines.join("\n") })
              : null,
          });
          const passages = out.text;
          const hit = m.gold ? m.gold.test(passages) : null;
          row.variants[v.name] = {
            readyMs: Date.now() - t0, // moment -> passages ready (decider included)
            retrieveMs: out.ms,
            expandMs: out.expandMs ?? null,
            embedMs: out.embedMs ?? null,
            queries: out.queries ?? [],
            kept: out.used.length,
            chars: passages.length,
            skipped: out.skipped,
            hit,
            falsePositive: m.gold ? null : out.used.length > 0,
            cost: out.cost ?? 0,
            passages,
            files: [...new Set(out.used.map((u) => u.file))],
          };
        })
      );
      if (withAnswer && dec.kind === "run")
        for (const name of ["current", "fix", "kw"]) {
          const v = row.variants[name];
          const runner = createAnswerRunner({ model: mainModel });
          const t0 = Date.now();
          const card = await runner.run({
            id: `${i}-${name}`,
            deliverable: dec.deliverable,
            tier: dec.tier,
            web: false,
            proactive: true,
            focus,
            context: {
              meeting: { title: "CarZilla phase 2 review" },
              summary: "",
              transcript,
              contextSeconds: 120,
              thread: [],
              catalog: catalogText,
            },
            prepare: async () => ({ passages: v.passages, files: v.files }),
          }).done;
          v.answer = {
            ms: Date.now() - t0,
            skipped: !!card?.skipped,
            error: card?.error ?? null,
            correct: m.gold && card?.body ? m.gold.test(`${card.title}\n${card.body}`) : null,
            body: card?.body ?? null,
            tokensIn: card?.usage?.prompt_tokens ?? null,
            tokensOut: card?.usage?.completion_tokens ?? null,
            cost: Number(card?.usage?.cost) || 0,
          };
        }
      rows.push(row);
      process.stdout.write(".");
    }
  console.log("");
  store.close();

  // ---- summary
  const answerable = rows.filter((r) => r.gold);
  const unanswerable = rows.filter((r) => !r.gold);
  const summary = {
    at: new Date().toISOString(),
    queryModel,
    embedModel,
    repeat,
    moments: MOMENTS.length,
    d1: {
      p50: pctl(
        rows.map((r) => r.d1.ms),
        0.5
      ),
      p90: pctl(
        rows.map((r) => r.d1.ms),
        0.9
      ),
      projectAskedOnAnswerable: `${answerable.filter((r) => r.d1.projectAsked).length}/${answerable.length}`,
      projectAskedOnOthers: `${unanswerable.filter((r) => r.d1.projectAsked).length}/${unanswerable.length}`,
    },
    variants: {},
  };
  for (const name of Object.keys(rows[0].variants)) {
    const vs = rows.map((r) => r.variants[name]);
    const ans = answerable.map((r) => r.variants[name]);
    const un = unanswerable.map((r) => r.variants[name]);
    const cards = rows.map((r) => r.variants[name].answer).filter(Boolean);
    summary.variants[name] = {
      hit: `${ans.filter((v) => v.hit).length}/${ans.length}`,
      hitPct: Math.round((100 * ans.filter((v) => v.hit).length) / ans.length),
      falsePositive: `${un.filter((v) => v.falsePositive).length}/${un.length}`,
      readyMs: {
        p50: pctl(
          vs.map((v) => v.readyMs),
          0.5
        ),
        p90: pctl(
          vs.map((v) => v.readyMs),
          0.9
        ),
      },
      retrieveMs: {
        p50: pctl(
          vs.map((v) => v.retrieveMs),
          0.5
        ),
        p90: pctl(
          vs.map((v) => v.retrieveMs),
          0.9
        ),
      },
      expandMs: {
        p50: pctl(
          vs.map((v) => v.expandMs),
          0.5
        ),
        p90: pctl(
          vs.map((v) => v.expandMs),
          0.9
        ),
      },
      expandTimeouts: vs.filter((v) => v.expandMs != null && v.queries.length < 2).length,
      keptMean: +mean(vs.map((v) => v.kept)).toFixed(1),
      charsMean: Math.round(mean(vs.map((v) => v.chars))),
      searchCostPerCard: +mean(vs.map((v) => v.cost)).toFixed(7),
      ...(cards.length
        ? {
            answers: {
              correct: `${cards.filter((c) => c.correct).length}/${cards.filter((c) => c.correct != null).length}`,
              skipped: cards.filter((c) => c.skipped).length,
              msP50: pctl(
                cards.map((c) => c.ms),
                0.5
              ),
              costPerCard: +mean(cards.map((c) => c.cost)).toFixed(6),
              tokensInMean: Math.round(mean(cards.map((c) => c.tokensIn ?? 0))),
            },
          }
        : {}),
    };
  }
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = summary.at.replace(/[:.]/g, "-");
  const file = path.join(outDir, `rag-query-eval-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({ summary, rows }, null, 1));

  const md = [
    `# Project search eval ${summary.at}`,
    "",
    `Query model \`${queryModel}\` · embedding \`${embedModel}\` · ${MOMENTS.length} moments x ${repeat} repeats (${answerable.length / repeat} answerable, ${unanswerable.length / repeat} not)`,
    "",
    `Decider (pplx): p50 ${summary.d1.p50} ms, p90 ${summary.d1.p90} ms · asked for the files on ${summary.d1.projectAskedOnAnswerable} answerable, ${summary.d1.projectAskedOnOthers} others`,
    "",
    "| variant | fact found | false positives | moment -> passages p50 / p90 | search p50 / p90 | query writing p50 / p90 | passages | search cost / card |",
    "|---|---|---|---|---|---|---|---|",
    ...Object.entries(summary.variants).map(
      ([n, v]) =>
        `| ${n} | ${v.hit} (${v.hitPct}%) | ${v.falsePositive} | ${v.readyMs.p50} / ${v.readyMs.p90} ms | ${v.retrieveMs.p50} / ${v.retrieveMs.p90} ms | ${v.expandMs.p50 ?? "-"} / ${v.expandMs.p90 ?? "-"} ms | ${v.keptMean} (${v.charsMean} chars) | $${v.searchCostPerCard} |`
    ),
  ];
  if (withAnswer) {
    md.push(
      "",
      "| variant | card states the fact | skipped | card time p50 | card cost | input tokens |",
      "|---|---|---|---|---|---|"
    );
    for (const [n, v] of Object.entries(summary.variants))
      if (v.answers)
        md.push(
          `| ${n} | ${v.answers.correct} | ${v.answers.skipped} | ${v.answers.msP50} ms | $${v.answers.costPerCard} | ${v.answers.tokensInMean} |`
        );
  }
  md.push("", "Per moment (first repeat): fact found by current / fix / kw / embed", "");
  for (const r of rows.filter((x) => x.rep === 0))
    md.push(
      `- ${r.i}. ${r.question} — ${["current", "fix", "kw", "embed"].map((n) => (r.gold ? (r.variants[n].hit ? "✓" : "✗") : r.variants[n].falsePositive ? "FP" : "·")).join(" ")}` +
        (r.variants.kw.queries.length > 1
          ? `  \n  queries: ${r.variants.kw.queries
              .slice(1)
              .map((q) => `"${q}"`)
              .join(", ")}`
          : "")
    );
  fs.writeFileSync(file.replace(/\.json$/, ".md"), md.join("\n") + "\n");
  console.log(md.join("\n"));
  console.log(`\nSaved ${file}`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
