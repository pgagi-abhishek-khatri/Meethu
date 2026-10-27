// End-to-end replay: saved meeting segments -> the real engine (scheduler, D1 decider, main model, verifier) on a
// virtual clock, so a 40-minute meeting takes a couple of minutes. Writes every decision and every card with its
// surrounding transcript, for reading/grading. Costs real tokens (D1 + main model).
//   node scripts/copilot/replay-e2e.mjs <out.json> seg1.jsonl seg2.jsonl ...
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
const { createLiquidClient } = require(path.join(root, "src/copilot/core/decision/liquidClient"));
const { getDecisionEnv } = require(path.join(root, "src/copilot/core/decision/config"));
const { getCopilotAiConfig } = require(path.join(root, "src/copilot/config/aiDefaults"));
const { createMainModel } = require(path.join(root, "src/copilot/main/mainCall"));

const [outFile, ...files] = process.argv.slice(2);

// RAG_DIR=<folder written by scripts/copilot/rag-live.js>: the replayed meeting searches that project's files.
// Run under Electron's Node (ELECTRON_RUN_AS_NODE=1 npx electron ...) so better-sqlite3 loads.
let rag = null;
const ragCalls = []; // every project search the replay made
if (process.env.RAG_DIR) {
  const { openStore } = require(path.join(root, "src/copilot/main/store"));
  const { createEmbedClient } = require(path.join(root, "src/copilot/rag/embedClient"));
  const { createRetriever } = require(path.join(root, "src/copilot/rag/retrieve"));
  const { createRagLog } = require(path.join(root, "src/copilot/rag/ragLog"));
  const store = openStore({ dbPath: path.join(process.env.RAG_DIR, "copilot.db") });
  const pid = store.projects.list()[0].id;
  const embed = createEmbedClient({ apiKey: process.env.OPENROUTER_API_KEY });
  const r = createRetriever({
    rag: store.rag,
    clients: () => ({ embed }),
    log: createRagLog({ dir: process.env.RAG_DIR, now: Date.now }),
  });
  rag = {
    hasIndex: () => r.hasIndex([pid]),
    catalog: () => r.catalog([pid]),
    prefetch: (q) => r.prefetch(q, [pid]),
    retrieve: async (o) => {
      const res = await r.retrieve({ ...o, projectIds: [pid] });
      ragCalls.push({
        query: o.query,
        why: o.why,
        deep: !!o.deep,
        skipped: res.skipped,
        ms: res.ms,
        used: res.used,
        passages: res.text,
      });
      return res;
    },
  };
}

async function replay(file) {
  const rows = fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const t0 = Date.parse(rows[0].at);
  const clock = fakeClock(t0);
  const e = getDecisionEnv(process.env);
  const base = createLiquidClient({
    apiKey: e.apiKey,
    url: e.url,
    model: e.model,
    timeoutMs: 30000,
  });
  const ai = getCopilotAiConfig(process.env);
  const real = createMainModel({ apiKey: ai.apiKey, model: ai.model });
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
  const client = { systemOne: track((r) => base.systemOne(r)) };
  // what each answer call was given: the passages and catalog parts of its prompt, and how long it took
  const modelCalls = [];
  const main = track(async (r) => {
    const user = r.messages?.[1]?.content ?? "";
    const rec = {
      tier: r.tier,
      web: !!r.web,
      focus: (/(?:Help with|The USER asks):\n([\s\S]*?)(?:\n\n|$)/.exec(user)?.[1] ?? "").slice(
        0,
        200
      ),
      hasCatalog: user.includes("project files (what each holds"),
      passages: (
        /Passages from the USER's project files[^\n]*\n\n([\s\S]*?)(?:\n\nSummary of|\n\nRecent transcript|$)/.exec(
          user
        )?.[1] ?? ""
      ).slice(0, 1500),
      userChars: user.length,
    };
    const t = Date.now();
    const res = await real(r);
    rec.ms = Date.now() - t;
    rec.tokens = res.usage?.total_tokens ?? null;
    modelCalls.push(rec);
    return res;
  });
  const transcript = [];
  const out = { decisions: [], cards: [], skips: [], ideas: [], threads: [] };
  const cards = new Map();
  const recent = () =>
    transcript.slice(-8).map((s) => `${s.source === "mic" ? "USER" : "OTHER"}: ${s.text}`);
  const engine = createEngine({
    env: { ...process.env, COPILOT_MAIN: "1" },
    panel: {
      send(ev) {
        const t = Math.round((clock.now() - t0) / 1000);
        if (ev.type === "decision")
          out.decisions.push({
            t,
            kind: ev.decision.kind,
            why: (ev.decision.reasons ?? []).slice(-2).join(" | "),
            deliverable: ev.decision.deliverable,
            trigger: ev.decision.trigger,
            needs: ev.decision.needs,
            act: ev.decision.raw?.act,
            text: ev.newText,
          });
        if (ev.type === "ideas")
          out.ideas.push({ t, ideas: ev.ideas.map((i) => `${i.kind}: ${i.line}`) });
        if (ev.type === "thread" && ev.action === "create")
          out.threads.push({ t, title: ev.thread.title });
        if (ev.type === "card_start")
          cards.set(ev.id, {
            auto: ev.auto,
            thread: ev.threadId,
            t,
            id: ev.id,
            focus: ev.focus,
            deliverable: ev.deliverable,
            proactive: ev.proactive,
            web: ev.web,
            deep: ev.deep,
            of: ev.of,
            context: recent(),
          });
        if (ev.type === "card_done")
          out.cards.push({
            ...cards.get(ev.id),
            title: ev.title,
            body: ev.body,
            confidence: ev.confidence,
            files: ev.files, // project files the card was given passages from (RAG_DIR)
            sources: (ev.sources ?? []).length,
            totalMs: ev.timing?.totalMs,
          });
        if (ev.type === "skipped") out.skippedBox = ev.items.map((i) => i.line);
        if (ev.type === "card_skip")
          out.skips.push({ t, id: ev.id, reason: ev.reason, focus: cards.get(ev.id)?.focus });
        if (ev.type === "card_error") out.cards.push({ ...cards.get(ev.id), error: ev.code });
      },
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    client,
    mainModel: main,
    rag,
    llm: null,
    getSettings: () => ({
      apiKey: process.env.OPENROUTER_API_KEY,
      quiet: process.env.PACE || "normal",
    }),
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
    if (r.type !== "segment") continue;
    await advanceTo(Date.parse(r.at));
    transcript.push(r);
    engine.onFinal({ text: r.text, source: r.source, speaker: r.speaker, timestamp: clock.now() });
  }
  await advanceTo(clock.now() + 20000);
  // "Rerun with high effort" on a few cards: some that were given project passages, some that were not
  if (process.env.RERUN) {
    const done = out.cards.filter((c) => c.id && !c.deep && c.body);
    const pick = [
      ...done.filter((c) => c.files?.length).slice(0, 3),
      ...done.filter((c) => !c.files?.length).slice(0, 2),
    ];
    for (const c of pick) {
      engine.rerun(c.id);
      await settle();
    }
    // the project search before a rerun is not a tracked model call: give the cards real time to finish
    await new Promise((r) => setTimeout(r, 30000));
    await settle();
    await advanceTo(clock.now() + 3000);
  }
  // The Skipped box: tap a few of the items, as the user would
  if (process.env.SKIPASK && out.skippedBox?.length) {
    for (const line of out.skippedBox.slice(0, Number(process.env.SKIPASK))) {
      engine.ask({ text: line });
      await settle();
    }
    await advanceTo(clock.now() + 3000);
  }
  const stats = engine.stats();
  engine.endSession();
  await settle();
  return {
    name: path.basename(file, ".jsonl"),
    segments: rows.length,
    ragCalls: ragCalls.splice(0),
    modelCalls: modelCalls.splice(0),
    stats: { d1Calls: stats.d1Calls, tokens: stats.inputTokens, byKind: stats.byKind },
    ...out,
  };
}

const results = [];
for (const f of files) {
  const r = await replay(f);
  results.push(r);
  console.log(
    `${r.name}: segs ${r.segments} decisions ${r.decisions.length} d1calls ${r.stats.d1Calls} cards ${r.cards.length} skipped ${r.skips.length}`
  );
}
fs.writeFileSync(outFile, JSON.stringify(results, null, 1));
