// Experiment runner: replays one saved meeting through the real engine under one "arm" and logs every model
// call it makes (D1 decide and gate calls, query writer, embeddings, project search, answer model) with its
// tokens, cost and latency, plus every decision and card. arm-report.mjs compares the runs.
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/copilot/arm-run.mjs --arm P --rag <dir with copilot.db> \
//     --out <run.json> <meeting.jsonl>
// Arms:
//   A0  today: summary catalog, one D1 call (needs_project in it)
//   P   file profiles: profile catalog for D1 / answer / query writer, one D1 call
//   T   two calls: summary catalog; D1 judges the card, a second D1 call asks whether the files are needed while
//       the query writer already writes (not needed -> its queries go to the answer model)
// Costs real tokens. Runs on a virtual clock, so a 30-minute meeting replays in a few minutes; latencies are the
// real network times of each call.
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
require("dotenv").config({ path: path.join(root, ".env"), quiet: true });
const { createEngine } = require(path.join(root, "src/copilot/main/engine"));
const { fakeClock } = require(path.join(root, "test/copilot/helpers"));
const { createLiquidClient } = require(path.join(root, "src/copilot/core/decision/liquidClient"));
const { getDecisionEnv, DEFAULT_DECISION_CONFIG } = require(
  path.join(root, "src/copilot/core/decision/config")
);
const { getCopilotAiConfig } = require(path.join(root, "src/copilot/config/aiDefaults"));
const { createMainModel } = require(path.join(root, "src/copilot/main/mainCall"));
const { createQueryWriter } = require(path.join(root, "src/copilot/rag/queryWriter"));
const { openStore } = require(path.join(root, "src/copilot/main/store"));
const { createEmbedClient } = require(path.join(root, "src/copilot/rag/embedClient"));
const { createRetriever } = require(path.join(root, "src/copilot/rag/retrieve"));
const { RAG } = require(path.join(root, "src/copilot/rag/config"));

const ARMS = {
  A0: { catalogMode: "summary", ragTrigger: "single" },
  P: { catalogMode: "profile", ragTrigger: "single" },
  T: { catalogMode: "summary", ragTrigger: "twoCall" },
};

const args = process.argv.slice(2);
const arg = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const armName = arg("--arm");
const ragDir = arg("--rag");
const outFile = arg("--out");
const meetingFile = args.find((a) => a.endsWith(".jsonl"));
const arm = ARMS[armName];
if (!arm || !ragDir || !outFile || !meetingFile)
  throw new Error("usage: arm-run.mjs --arm A0|P|T --rag <dir> --out <file> <meeting.jsonl>");

const apiKey = process.env.OPENROUTER_API_KEY;
const rows = fs
  .readFileSync(meetingFile, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l))
  .filter((r) => r.type === "segment" && String(r.text ?? "").trim());
const t0 = Date.parse(rows[0].at);
const clock = fakeClock(t0);
const vt = () => Math.round((clock.now() - t0) / 100) / 10; // virtual meeting seconds

// ---- everything that costs, call by call
const calls = []; // { model, kind, t, ms, inputTokens, outputTokens, cost, ...detail }
let inflight = 0;
const track =
  (fn) =>
  async (...a) => {
    inflight++;
    try {
      return await fn(...a);
    } finally {
      inflight--;
    }
  };

// D1
let lastDecideMs = null; // real time of the decide call behind the next decision event
const decidedAt = new Map(); // job id -> { wall, d1Ms }: real time from the decision to the card
const dec = getDecisionEnv(process.env);
const d1 = createLiquidClient({
  apiKey: dec.apiKey,
  url: dec.url,
  model: dec.model,
  timeoutMs: 30000,
});
const client = {
  systemOne: track(async (req) => {
    const names = Object.keys(req.questions);
    const kind = names.length === 1 && names[0] === "needs_project" ? "gate" : "decide";
    const rec = {
      model: dec.model,
      kind,
      t: vt(),
      questions: names,
      stateChars: JSON.stringify(req.state).length,
      projectFilesChars: JSON.stringify(req.state.project_files ?? []).length,
    };
    try {
      const r = await d1.systemOne(req);
      Object.assign(rec, {
        ms: Math.round(r.ms),
        inputTokens: r.inputTokens,
        outputTokens: r.usage?.output_tokens ?? null,
        cost: Number(r.usage?.cost) || null,
        answers: Object.fromEntries(
          Object.entries(r.answers).map(([k, v]) => [k, v.noul ?? v.choice ?? null])
        ),
      });
      calls.push(rec);
      if (kind === "decide") lastDecideMs = rec.ms;
      return r;
    } catch (e) {
      calls.push({ ...rec, error: e.code ?? e.message });
      throw e;
    }
  }),
};

// query writer
const baseWriter = createQueryWriter({ apiKey, model: RAG.queryModel });
const queryWriter = track(async (input) => {
  const t = Date.now();
  const rec = { model: RAG.queryModel, kind: "query_writer", t: vt() };
  try {
    const r = await baseWriter(input);
    calls.push({
      ...rec,
      ms: Date.now() - t,
      totalTokens: r.tokens,
      cost: r.cost,
      queries: r.queries,
    });
    return r;
  } catch (e) {
    calls.push({
      ...rec,
      ms: Date.now() - t,
      error: e.name === "AbortError" ? "aborted" : (e.code ?? e.message),
    });
    throw e;
  }
});

// embeddings (query side; documents were embedded at indexing)
const embed = createEmbedClient({ apiKey });
const embedQueries = embed.embedQueries.bind(embed);
embed.embedQueries = track(async (texts) => {
  const t = Date.now();
  const r = await embedQueries(texts);
  calls.push({
    model: RAG.embedModel,
    kind: "embed",
    t: vt(),
    ms: Date.now() - t,
    totalTokens: r.tokens,
    cost: r.cost,
    cached: r.cached,
    n: texts.length,
  });
  return r;
});

// project search
const store = openStore({ dbPath: path.join(ragDir, "copilot.db") });
const pid = store.projects.list()[0].id;
const retriever = createRetriever({
  rag: store.rag,
  clients: () => ({ embed }),
  catalogMode: arm.catalogMode,
});
const searches = [];
const rag = {
  hasIndex: () => retriever.hasIndex([pid]),
  catalog: () => retriever.catalog([pid]),
  catalogLines: () => retriever.catalogLines([pid]),
  writerCatalog: () => retriever.writerCatalog([pid]),
  catalogMode: () => retriever.catalogMode(),
  prefetch: (q) => retriever.prefetch(q, [pid]),
  retrieve: async (o) => {
    const t = vt();
    const r = await retriever.retrieve({ ...o, projectIds: [pid] });
    searches.push({
      t,
      why: o.why,
      minScore: o.minScore,
      ms: r.ms,
      skipped: r.skipped,
      queries: r.queries,
      expandMs: r.expandMs,
      embedMs: r.embedMs,
      used: r.used,
      passageChars: r.text.length,
    });
    return r;
  },
};

// answer model
const ai = getCopilotAiConfig(process.env);
const realMain = createMainModel({ apiKey: ai.apiKey, model: ai.model });
const mainModel = track(async (r) => {
  const user =
    r.messages?.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n") ?? "";
  const rec = {
    model: r.model || ai.model,
    kind: "answer",
    tier: r.tier,
    t: vt(),
    promptChars: user.length,
    catalogChars: (/The USER's project files[\s\S]*?(?=\n\n|$)/.exec(user)?.[0] ?? "").length,
    passageChars: (
      /Passages from the USER's project files[\s\S]*?(?=\n\nSummary of|\n\nRecent transcript|$)/.exec(
        user
      )?.[0] ?? ""
    ).length,
    gateQueries: user.includes("Search queries a helper wrote for this moment"),
  };
  const t = Date.now();
  try {
    const res = await realMain(r);
    calls.push({
      ...rec,
      ms: Date.now() - t,
      firstTokenMs: res.firstTokenMs,
      inputTokens: res.usage?.prompt_tokens ?? null,
      outputTokens: res.usage?.completion_tokens ?? null,
      cost: Number(res.usage?.cost) || null,
    });
    return res;
  } catch (e) {
    calls.push({ ...rec, ms: Date.now() - t, error: e.code ?? e.message });
    throw e;
  }
});

// ---- the replay
const out = { decisions: [], cards: [], skips: [] };
const cardStart = new Map();
const engine = createEngine({
  env: { ...process.env, COPILOT_MAIN: "1", COPILOT_RAG_TRIGGER: "" },
  decisionCfg: { ...DEFAULT_DECISION_CONFIG, ragTrigger: arm.ragTrigger },
  panel: {
    send(ev) {
      if (ev.type === "decision" && ev.jobId)
        decidedAt.set(ev.jobId, { wall: Date.now(), d1Ms: lastDecideMs });
      if (ev.type === "decision")
        out.decisions.push({
          d1Ms: lastDecideMs,
          t: vt(),
          ids: ev.ids,
          jobId: ev.jobId,
          kind: ev.decision.kind,
          trigger: ev.decision.trigger,
          deliverable: ev.decision.deliverable,
          needs: ev.decision.needs,
          act: ev.decision.raw?.act,
          reasons: ev.decision.reasons,
          callMs: ev.callMs,
          text: ev.newText,
        });
      if (ev.type === "card_start") cardStart.set(ev.id, { t: vt(), focus: ev.focus });
      if (ev.type === "card_done")
        out.cards.push({
          id: ev.id,
          ...cardStart.get(ev.id),
          title: ev.title,
          body: ev.body,
          files: ev.files,
          timing: ev.timing,
          // real milliseconds: decision -> card done, and the whole way from the moment (D1 call + that)
          afterDecisionMs: decidedAt.has(ev.id) ? Date.now() - decidedAt.get(ev.id).wall : null,
          e2eMs: decidedAt.has(ev.id)
            ? Date.now() - decidedAt.get(ev.id).wall + (decidedAt.get(ev.id).d1Ms ?? 0)
            : null,
          usage: ev.usage,
        });
      if (ev.type === "card_skip") out.skips.push({ id: ev.id, t: vt(), reason: ev.reason });
      if (ev.type === "card_error")
        out.cards.push({ id: ev.id, ...cardStart.get(ev.id), error: ev.code });
    },
  },
  now: clock.now,
  setTimer: clock.setTimer,
  clearTimer: clock.clearTimer,
  client,
  mainModel,
  queryWriter,
  rag,
  getSettings: () => ({ apiKey, quiet: process.env.PACE || "normal" }),
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
const started = Date.now();
for (const r of rows) {
  await advanceTo(Date.parse(r.at));
  engine.onFinal({ text: r.text, source: r.source, speaker: r.speaker, timestamp: clock.now() });
}
await advanceTo(clock.now() + 20000);
// A search before the answer is not a tracked call: give the last cards real time to finish.
await new Promise((r) => setTimeout(r, 15000));
await settle();
const stats = engine.stats();
engine.endSession();
await settle();
store.close();

fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
fs.writeFileSync(
  outFile,
  JSON.stringify(
    {
      arm: armName,
      config: arm,
      meeting: path.basename(meetingFile),
      segments: rows.length,
      wallMs: Date.now() - started,
      models: { d1: dec.model, answer: ai.model, writer: RAG.queryModel, embed: RAG.embedModel },
      stats: { d1Calls: stats.d1Calls, d1InputTokens: stats.inputTokens, byKind: stats.byKind },
      calls,
      searches,
      ...out,
    },
    null,
    1
  )
);
const by = (k) => calls.filter((c) => c.kind === k);
console.log(
  `${armName}: ${rows.length} segs, ${out.decisions.length} decisions, D1 ${by("decide").length}+${by("gate").length} gate, writer ${by("query_writer").length}, searches ${searches.length}, cards ${out.cards.length}, skips ${out.skips.length} -> ${outFile}`
);
process.exit(0);
