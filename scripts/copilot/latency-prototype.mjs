// Phase 0B latency prototype. Standalone: no app code, no new dependencies.
//
//   node scripts/copilot/latency-prototype.mjs --mic [--runs 20] [--region us]
//        speak; each Soniox <end> triggers router -> main model (web search only
//        when the router asks). Prints one timing line per utterance and the
//        median / p90 at the end (Ctrl+C or --runs reached).
//   node scripts/copilot/latency-prototype.mjs --text "what is the GDP of France?" [--runs 5]
//        skips speech: router -> main only.
//
// Env (.env is loaded): SONIOX_API_KEY, OPENROUTER_API_KEY,
//   COPILOT_ROUTER_MODEL (default anthropic/claude-haiku-4.5:nitro),
//   COPILOT_AI_MODEL     (default deepseek/deepseek-v4.1-flash)
// Flags: --web (always search), --no-web (never), --out file.jsonl,
//        --router-only (skip the main model), --router-model X, --main-model X, --effort minimal|low|medium|high
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
require("dotenv").config({ path: path.join(root, ".env"), quiet: true });
const WebSocket = require("ws");
const { getCopilotAiConfig } = require("../../src/copilot/config/aiDefaults.js");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const RUNS = Number(opt("runs", 20));
const ai = getCopilotAiConfig();
const ROUTER_MODEL = opt(
  "router-model",
  process.env.COPILOT_ROUTER_MODEL || "anthropic/claude-haiku-4.5:nitro"
);
const MAIN_MODEL = opt("main-model", ai.model);
// Reasoning effort for the main model (minimal|low|medium|high); omitted = provider default.
const EFFORT = opt("effort", "");
const SONIOX_URLS = {
  us: "wss://stt-rt.soniox.com/transcribe-websocket",
  eu: "wss://stt-rt.eu.soniox.com/transcribe-websocket",
  jp: "wss://stt-rt.jp.soniox.com/transcribe-websocket",
  in: "wss://stt-rt.in.soniox.com/transcribe-websocket",
};

const ROUTER_PROMPT = `You are Jev, a quiet meeting copilot's router. Decide whether to help with the latest utterance.
Default is "wait". A wrong interruption is worse than a missed one.
Reply with ONE JSON object only, no prose:
{"action":"wait|answer|suggest|ask_question|search|summarize_now","intent":"","model_tier":"fast|reasoning","needs_project_search":false,"project_query":"","needs_web":false,"web_query":"","needs_past_meetings":false,"past_meetings_query":"","needs_screenshot":false,"thread":"main","transcript_window_seconds":60,"confidence":0.0,"reason":""}`;

const ACTIONS = new Set(["wait", "answer", "suggest", "ask_question", "search", "summarize_now"]);
const validRouter = (j) => j && ACTIONS.has(j.action) && typeof j.confidence === "number";

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];
const p90 = (xs) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * 0.9) - 1)];

async function openrouter(body, signal) {
  return fetch(`${ai.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ai.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

async function runRouter(model, transcript) {
  const t0 = performance.now();
  const res = await openrouter({
    model,
    max_tokens: 250,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: ROUTER_PROMPT },
      { role: "user", content: `Recent transcript:\n${transcript}\n\nDecide.` },
    ],
  });
  const data = await res.json().catch(() => ({}));
  const ms = performance.now() - t0;
  let json = null;
  try {
    json = JSON.parse(data.choices?.[0]?.message?.content ?? "");
  } catch {}
  return {
    ms,
    json,
    valid: validRouter(json),
    error: res.ok ? null : JSON.stringify(data.error ?? data),
  };
}

// Streams the answer; resolves with time to first content token and total time.
async function runMain(transcript, intent, useWeb) {
  const t0 = performance.now();
  const res = await openrouter({
    model: MAIN_MODEL,
    stream: true,
    ...(EFFORT ? { reasoning: { effort: EFFORT } } : {}),
    max_tokens: 400,
    ...(useWeb ? { tools: [{ type: "openrouter:web_search" }] } : {}),
    messages: [
      {
        role: "system",
        content:
          "You are a live meeting copilot. Answer in at most 3 short sentences. Say when you are unsure. Never present a guess as fact.",
      },
      { role: "user", content: `Transcript:\n${transcript}\n\nWhat the user wants: ${intent}` },
    ],
  });
  if (!res.ok)
    return { error: await res.text(), firstTokenMs: null, totalMs: performance.now() - t0 };
  let firstTokenMs = null;
  let text = "";
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += Buffer.from(chunk).toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      let delta;
      try {
        delta = JSON.parse(line.slice(6)).choices?.[0]?.delta?.content;
      } catch {
        continue;
      }
      if (delta) {
        firstTokenMs ??= performance.now() - t0;
        text += delta;
      }
    }
  }
  return { firstTokenMs, totalMs: performance.now() - t0, text, error: null };
}

const rows = [];
function report(row) {
  rows.push(row);
  const f = (v) => (v == null ? "  -  " : `${Math.round(v)}ms`.padStart(6));
  console.log(
    `#${String(rows.length).padStart(2)} sttLag${f(row.sttLagMs)} router${f(row.routerMs)} ` +
      `firstTok${f(row.mainFirstTokenMs)} total${f(row.mainTotalMs)} ` +
      `speech->token${f(row.speechToTokenMs)} | ${row.action}${row.web ? "+web" : ""}` +
      `${row.routerValid ? "" : " (INVALID JSON)"} | "${row.utterance.slice(0, 50)}"`
  );
  if (opt("out")) appendFileSync(opt("out"), JSON.stringify(row) + "\n");
}

function summary() {
  const col = (k) => rows.map((r) => r[k]).filter((v) => typeof v === "number");
  console.log(
    `\n--- ${rows.length} runs, router=${ROUTER_MODEL}, main=${MAIN_MODEL}${EFFORT ? ` effort=${EFFORT}` : ""} ---`
  );
  for (const [label, key] of [
    ["Soniox end lag     ", "sttLagMs"],
    ["router             ", "routerMs"],
    ["main first token   ", "mainFirstTokenMs"],
    ["main total         ", "mainTotalMs"],
    ["speech -> 1st token", "speechToTokenMs"],
  ]) {
    const v = col(key);
    if (v.length)
      console.log(
        `${label} median ${Math.round(median(v))}ms  p90 ${Math.round(p90(v))}ms  (n=${v.length})`
      );
  }
  const invalid = rows.filter((r) => !r.routerValid).length;
  console.log(`router JSON invalid: ${invalid}/${rows.length}`);
}

let busy = false; // the brief: skip a trigger while a call is running, never queue
async function handleUtterance(utterance, context, timing = {}) {
  if (busy)
    return console.log(`(skipped: previous call still running) "${utterance.slice(0, 40)}"`);
  busy = true;
  try {
    const transcript = [...context, utterance].slice(-4).join("\n");
    const router = await runRouter(ROUTER_MODEL, transcript);
    if (router.error) return console.error("router error:", router.error);
    const action = router.json?.action ?? "wait";
    const web = flag("web") || (!flag("no-web") && router.json?.needs_web === true);
    const row = {
      utterance,
      sttLagMs: timing.sttLagMs ?? null,
      routerMs: router.ms,
      routerValid: router.valid,
      action,
      web,
    };
    if (flag("router-only")) return report(row);
    // For the latency test the main model runs even when the router says wait.
    const main = await runMain(transcript, router.json?.intent || utterance, web);
    if (main.error) return console.error("main error:", main.error);
    row.mainFirstTokenMs = main.firstTokenMs;
    row.mainTotalMs = main.totalMs;
    if (timing.speechEndAt) {
      row.speechToTokenMs =
        performance.now() - timing.speechEndAt - (main.totalMs - main.firstTokenMs);
    }
    report(row);
  } finally {
    busy = false;
  }
}

async function textMode() {
  const text = opt("text", "");
  for (let i = 0; i < RUNS; i++)
    await handleUtterance(text, ["(earlier) Let's review the Q3 plan."]);
  summary();
}

function micMode() {
  const key = process.env.SONIOX_API_KEY;
  if (!key) throw new Error("SONIOX_API_KEY missing in .env");
  const ws = new WebSocket(SONIOX_URLS[opt("region", "us")] ?? SONIOX_URLS.us, { family: 4 });
  const context = [];
  let open = "";
  let lastLoudAt = null; // energy-based marker for "the user stopped talking"
  const ENERGY = 600; // s16 RMS threshold for "voice"

  ws.on("open", () => {
    ws.send(
      JSON.stringify({
        api_key: key,
        model: "stt-rt-v5",
        audio_format: "pcm_s16le",
        sample_rate: 16000,
        num_channels: 1,
        enable_endpoint_detection: true,
        enable_language_identification: true,
      })
    );
    const rec = spawn("parec", [
      "--rate=16000",
      "--channels=1",
      "--format=s16le",
      "--latency-msec=40",
    ]);
    rec.stdout.on("data", (buf) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(buf);
      const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
      let sum = 0;
      for (const s of samples) sum += s * s;
      if (Math.sqrt(sum / Math.max(1, samples.length)) > ENERGY) lastLoudAt = performance.now();
    });
    rec.on("error", (e) => console.error("parec failed:", e.message));
    const keepAlive = setInterval(() => ws.send(JSON.stringify({ type: "keepalive" })), 10000);
    ws.on("close", () => {
      clearInterval(keepAlive);
      rec.kill();
    });
    process.on("SIGINT", () => {
      rec.kill();
      summary();
      process.exit(0);
    });
    console.log(
      `Listening (region ${opt("region", "us")}). Speak a question, then pause. Ctrl+C to stop.`
    );
  });

  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.error_code) return console.error("Soniox:", msg.error_code, msg.error_message);
    for (const t of msg.tokens ?? []) {
      if (t.text === "<end>") {
        const utterance = open.trim();
        open = "";
        if (!utterance) continue;
        const now = performance.now();
        const timing = {
          sttLagMs: lastLoudAt ? now - lastLoudAt : null,
          speechEndAt: lastLoudAt ?? now,
        };
        handleUtterance(utterance, context, timing).then(() => {
          context.push(utterance);
          if (rows.length >= RUNS) {
            summary();
            process.exit(0);
          }
        });
      } else if (t.is_final && t.text !== "<fin>") {
        open += t.text;
      }
    }
  });
  ws.on("error", (e) => console.error("socket error:", e.message));
}

if (!ai.apiKey) {
  console.error("OPENROUTER_API_KEY missing in .env");
  process.exit(1);
}
if (flag("mic")) micMode();
else if (opt("text")) await textMode();
else console.log('Use --mic or --text "..." (see the header of this file).');
