// End-to-end check of the live meeting copilot on this desktop, with the real services:
//
//   audio (a file, or the mic recorded now) -> Soniox realtime (meeting mode, the app's own client)
//   -> copilot service (real engine, OpenRouter models, SQLite store, optional project file search)
//   -> saved meeting, transcript, proactive cards, a typed question, the end-of-meeting summary.
//
// It runs inside Electron (the app's own better-sqlite3 build) with a throwaway profile, so the
// real copilot.db and settings are never touched. Keys come from .env: SONIOX_API_KEY and
// OPENROUTER_API_KEY. It spends a little of both (about a minute of Soniox, a few model calls).
//
//   npm run test:e2e:desktop -- --audio meeting.mp3
//   npm run test:e2e:desktop -- --record 30          (speak, or play a call through the speakers)
//   npm run test:e2e:desktop -- --audio a.wav --project "Car Zilla Proposal.pdf" --ui
//
// Options:
//   --audio <file>      any audio/video ffmpeg reads (wav, mp3, m4a, webm, mp4 ...)
//   --record <seconds>  record the default microphone instead (PulseAudio / PipeWire)
//   --transcript <file> skip speech-to-text: feed saved lines to the copilot (a copilot-logs session
//                       .jsonl, or a .txt of "Them: ..." / "You: ..." lines). Soniox is only probed.
//   --max-lines <n>     with --transcript, feed at most n lines (default 40)
//   --source system|mic the side the audio plays as (default system: the other people in the call)
//   --speed <n>         stream n times faster than real time (default 1; Soniox accepts up to ~3)
//   --ask "<question>"  the typed question (default: a recap question)
//   --project <file>    index this file into a test project first and expect it to be searchable
//   --settle <seconds>  how long to wait for proactive cards after the audio ends (default 20)
//   --ui                open the real copilot window and save screenshots (needs `npm run build:renderer`)
//   --out <dir>         where the report, transcript and screenshots go (default ./copilot-e2e-<time>)
//
// Exit code 0 when every required check passed; the report lists warnings separately.
const { app, BrowserWindow, screen, ipcMain, dialog, safeStorage } = require("electron");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(__dirname, "..", "..");
require("dotenv").config({ path: path.join(root, ".env") });

// ---- arguments ----
function parseArgs(argv) {
  const out = { source: "system", speed: 1, settle: 20, ui: false, maxLines: 40 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--audio") out.audio = next();
    else if (a === "--record") out.record = Number(next());
    else if (a === "--transcript") out.transcript = next();
    else if (a === "--max-lines") out.maxLines = Math.max(1, Number(next()) || 40);
    else if (a === "--source") out.source = next() === "mic" ? "mic" : "system";
    else if (a === "--speed") out.speed = Math.max(0.5, Math.min(3, Number(next()) || 1));
    else if (a === "--ask") out.ask = next();
    else if (a === "--project") out.project = next();
    else if (a === "--settle") out.settle = Math.max(0, Number(next()) || 0);
    else if (a === "--ui") out.ui = true;
    else if (a === "--out") out.out = next();
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}
// Electron passes its own flags first; ours follow the script path.
const scriptIndex = process.argv.findIndex((a) => a.endsWith("desktop-e2e.js"));
const args = parseArgs(process.argv.slice(scriptIndex + 1));

const SAMPLE_RATE = 24000; // the meeting pipeline's rate (MEETING_STREAM_SAMPLE_RATE in ipcHandlers.js)
const CHUNK_MS = 100;
const CHUNK_BYTES = (SAMPLE_RATE * 2 * CHUNK_MS) / 1000;

// ---- report ----
const checks = [];
const check = (name, status, detail = "") => {
  checks.push({ name, status, detail });
  const mark = { pass: "PASS", fail: "FAIL", warn: "WARN", skip: "SKIP" }[status];
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, everyMs = 500) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(everyMs);
  }
}

// ---- audio ----
function ffmpegPath() {
  try {
    return require("ffmpeg-static");
  } catch {
    return "ffmpeg";
  }
}

function toPcm(file) {
  const r = spawnSync(
    ffmpegPath(),
    ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "-"],
    { maxBuffer: 1024 * 1024 * 1024 }
  );
  if (r.status !== 0)
    throw new Error(`ffmpeg could not read ${file}: ${r.stderr?.toString().trim()}`);
  return r.stdout;
}

// The default microphone, through the system ffmpeg (PulseAudio input), else pw-record.
async function recordMic(seconds, dir) {
  const wav = path.join(dir, "recording.wav");
  console.log(
    `Recording ${seconds} s from the default microphone. Speak now, or play a call aloud.`
  );
  const tryRun = (cmd, cmdArgs, killAfterMs) =>
    new Promise((resolve) => {
      let child;
      try {
        child = spawn(cmd, cmdArgs, { stdio: ["ignore", "ignore", "pipe"] });
      } catch {
        return resolve(false);
      }
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      child.on("error", () => resolve(false));
      const timer = killAfterMs ? setTimeout(() => child.kill("SIGINT"), killAfterMs) : null;
      child.on("exit", () => {
        clearTimeout(timer);
        resolve(
          fs.existsSync(wav) && fs.statSync(wav).size > 44
            ? true
            : (console.warn(err.trim()), false)
        );
      });
    });
  const ok =
    (await tryRun("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "pulse",
      "-i",
      "default",
      "-t",
      String(seconds),
      "-ac",
      "1",
      "-ar",
      String(SAMPLE_RATE),
      wav,
    ])) ||
    (await tryRun(
      "pw-record",
      ["--rate", String(SAMPLE_RATE), "--channels", "1", wav],
      seconds * 1000
    ));
  if (!ok)
    throw new Error("Could not record the microphone (tried ffmpeg -f pulse and pw-record).");
  return wav;
}

// Saved lines: a session trace (.jsonl "segment" rows) or plain "Them:" / "You:" text.
function readTranscript(file, maxLines) {
  const raw = fs.readFileSync(file, "utf8");
  let lines;
  if (/\.jsonl$/i.test(file)) {
    lines = raw
      .split("\n")
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((r) => r?.type === "segment" && typeof r.text === "string" && r.text.trim())
      .map((r) => ({ source: r.source === "mic" ? "mic" : "system", text: r.text.trim() }));
  } else {
    lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const m = /^(you|me|them|other|speaker[^:]*)\s*:\s*(.+)$/i.exec(l);
        if (!m) return { source: "system", text: l };
        return { source: /^(you|me)$/i.test(m[1]) ? "mic" : "system", text: m[2] };
      });
  }
  return lines.slice(0, maxLines);
}

function rms(pcm) {
  let sum = 0;
  const n = pcm.length >> 1;
  for (let i = 0; i < n; i++) {
    const x = pcm.readInt16LE(i << 1) / 32768;
    sum += x * x;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

// ---- the copilot, wired like the app (src/copilot/main/index.js), on a temp profile ----
function startCopilot({ dir, logDir, ui }) {
  const { createCopilot } = require(path.join(root, "src/copilot/main/service"));
  // The built renderer, as a packaged app loads it (the app path here is this script's folder).
  const loadRenderer = (win, flag) =>
    win.loadFile(path.join(root, "src", "dist", "index.html"), { query: { [flag]: "true" } });
  // Keep a handle on every IPC handler so the test can call them like the window does.
  const handlers = new Map();
  const listeners = new Map();
  const ipc = {
    handle: (name, fn) => {
      handlers.set(name, fn);
      ipcMain.handle(name, fn);
    },
    on: (name, fn) => {
      listeners.set(name, fn);
      ipcMain.on(name, fn);
    },
  };
  const copilot = createCopilot({
    dir,
    logDir,
    env: process.env,
    electron: { app, BrowserWindow, screen, ipcMain: ipc, dialog, safeStorage },
    loadRenderer: ui ? loadRenderer : () => Promise.resolve(),
    setupAlwaysOnTop: (w) => w.setAlwaysOnTop?.(true, "floating"),
    ffmpegPath: ffmpegPath(),
  });
  if (!ui) copilot.settings.update({ autoOpen: false });
  else copilot.settings.update({ autoOpen: true, idleMode: "full" });
  const invoke = (name, ...a) => handlers.get(`copilot:${name}`)({}, ...a);
  return { copilot, invoke, listeners };
}

async function screenshot(copilot, outDir, name) {
  const wc = copilot.window.webContents();
  if (!wc) return null;
  const win = BrowserWindow.fromWebContents(wc);
  if (!win) return null;
  const img = await win.capturePage();
  const file = path.join(outDir, `${name}.png`);
  fs.writeFileSync(file, img.toPNG());
  return file;
}

async function main() {
  if (args.help || (!args.audio && !args.record && !args.transcript)) {
    console.log(
      fs
        .readFileSync(__filename, "utf8")
        .split("\n")
        .filter((l) => l.startsWith("//"))
        .join("\n")
    );
    if (!args.help)
      console.error("\nPass --audio <file>, --record <seconds> or --transcript <file>.");
    return args.help ? 0 : 2;
  }
  const outDir = path.resolve(
    args.out || `copilot-e2e-${new Date().toISOString().replace(/[:.]/g, "-")}`
  );
  fs.mkdirSync(outDir, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-e2e-profile-"));
  console.log(`Report: ${outDir}\nProfile (throwaway): ${profile}\n`);

  // 1. preflight
  const sonioxKey = (process.env.SONIOX_API_KEY || "").trim();
  const openrouterKey = (process.env.OPENROUTER_API_KEY || "").trim();
  check("SONIOX_API_KEY is set", sonioxKey ? "pass" : "fail", sonioxKey ? "" : "add it to .env");
  check(
    "OPENROUTER_API_KEY is set",
    openrouterKey ? "pass" : "fail",
    openrouterKey ? "" : "add it to .env"
  );
  if (args.ui) {
    const built = fs.existsSync(path.join(root, "src/dist/index.html"));
    check(
      "renderer is built (for --ui)",
      built ? "pass" : "fail",
      built ? "" : "run npm run build:renderer"
    );
  }
  if (!sonioxKey && !args.transcript) return finish(outDir, profile);

  // 2. audio (or saved lines)
  let pcm;
  let lines;
  if (args.transcript) {
    try {
      lines = readTranscript(path.resolve(args.transcript), args.maxLines);
      check("saved transcript read", lines.length ? "pass" : "fail", `${lines.length} lines`);
    } catch (error) {
      check("saved transcript read", "fail", error.message);
    }
    if (!lines?.length) return finish(outDir, profile);
  } else
    try {
      const file = args.audio ? path.resolve(args.audio) : await recordMic(args.record, outDir);
      pcm = toPcm(file);
      const seconds = pcm.length / (SAMPLE_RATE * 2);
      const level = rms(pcm);
      check(
        "audio decoded",
        seconds > 2 ? "pass" : "fail",
        `${seconds.toFixed(1)} s from ${path.basename(file)}`
      );
      check("audio is not silent", level > 0.003 ? "pass" : "fail", `RMS ${level.toFixed(4)}`);
    } catch (error) {
      check("audio decoded", "fail", error.message);
      return finish(outDir, profile);
    }

  // 3. copilot up (before the audio, as in the app: the recording starts, then begin())
  const { copilot, invoke, listeners } = startCopilot({
    dir: profile,
    logDir: outDir,
    ui: args.ui,
  });
  const view = await invoke("settings-get");
  check("copilot sees the OpenRouter key", view.hasKey ? "pass" : "fail");

  let projectId = null;
  if (args.project) {
    projectId = await invoke("project-create", "E2E project");
    await invoke("project-active", projectId, true);
    const added = await invoke("project-add-paths", projectId, [path.resolve(args.project)]);
    if (!added) check("project file indexed", "fail", "file not found or not a regular file");
    else {
      console.log("Indexing the project file (PDFs are read by a model; this can take a minute)…");
      const file = await waitFor(
        () => {
          const row = copilot.store.projects.files(projectId)[0];
          return row && (row.status === "ready" || row.status === "error")
            ? copilot.store.rag.file(row.id) || row
            : null;
        },
        240000,
        1000
      );
      check(
        "project file indexed",
        file?.status === "ready" ? "pass" : "fail",
        file ? `${file.status}${file.error ? `: ${file.error}` : ""}` : "timed out after 240 s"
      );
    }
  }

  copilot.begin();
  if (args.ui) {
    await sleep(1500);
    listeners.get("copilot:ready")?.({});
  }

  // 4. stream the audio through the app's Soniox client, feeding the copilot as the app does
  const SonioxStreaming = require(path.join(root, "src/helpers/sonioxStreaming"));
  const finals = [];
  if (lines) {
    // Soniox is only probed (the key works, the socket opens), then the saved lines play as finals.
    if (sonioxKey) {
      const probe = new SonioxStreaming();
      const t = Date.now();
      try {
        await probe.connect({
          apiKey: sonioxKey,
          streamLabel: "system",
          sampleRate: SAMPLE_RATE,
          language: "en",
        });
        check("Soniox key accepted (connect probe)", "pass", `${Date.now() - t} ms`);
      } catch (error) {
        check("Soniox key accepted (connect probe)", "fail", error.message);
      }
      probe.sendAudio(Buffer.alloc(CHUNK_BYTES * 3)); // a little silence, so the server has audio to close on
      await probe.disconnect(true).catch(() => {});
    } else
      check(
        "Soniox key accepted (connect probe)",
        "warn",
        "no SONIOX_API_KEY: note recording will fail"
      );
    console.log(`Feeding ${lines.length} saved lines at ${args.speed}x…`);
    for (const line of lines) {
      copilot.onPartial({ source: line.source, text: line.text });
      const timestamp = Date.now();
      finals.push({ text: line.text, timestamp, source: line.source });
      process.stdout.write(`  ${line.source === "mic" ? "You" : "Them"}: ${line.text}\n`);
      copilot.onFinal({ text: line.text, source: line.source, timestamp });
      // roughly the time it takes to say the line
      await sleep(Math.min(6000, 250 + line.text.split(/\s+/).length * 330) / args.speed);
    }
    check("final transcript segments", "pass", `${finals.length} segments`);
  } else {
    const soniox = new SonioxStreaming();
    let partials = 0;
    let sonioxError = null;
    soniox.onPartialTranscript = (text) => {
      partials++;
      copilot.onPartial({ source: args.source, text });
    };
    soniox.onFinalTranscript = (text, timestamp) => {
      const clean = String(text || "").trim();
      if (!clean) return;
      finals.push({ text: clean, timestamp });
      process.stdout.write(`  ${args.source === "mic" ? "You" : "Them"}: ${clean}\n`);
      copilot.onFinal({ text: clean, source: args.source, timestamp });
    };
    soniox.onError = (e) => (sonioxError = e);
    soniox.onConnectionLost = (e) => (sonioxError = e);

    const t0 = Date.now();
    try {
      await soniox.connect({
        apiKey: sonioxKey,
        streamLabel: args.source,
        sampleRate: SAMPLE_RATE,
        language: "en",
      });
      check("Soniox connected (stt-rt-v5, meeting mode)", "pass", `${Date.now() - t0} ms`);
    } catch (error) {
      check("Soniox connected (stt-rt-v5, meeting mode)", "fail", error.message);
      copilot.close();
      return finish(outDir, profile);
    }
    console.log(
      `Streaming ${(pcm.length / SAMPLE_RATE / 2).toFixed(0)} s of audio at ${args.speed}x…`
    );
    const pace = CHUNK_MS / args.speed;
    for (let off = 0, next = Date.now(); off < pcm.length && !sonioxError; off += CHUNK_BYTES) {
      const chunk = pcm.subarray(off, off + CHUNK_BYTES);
      soniox.sendAudio(chunk);
      copilot.onLevel(chunk);
      next += pace;
      const wait = next - Date.now();
      if (wait > 0) await sleep(wait);
    }
    soniox.finalize();
    await soniox.disconnect(true).catch((e) => (sonioxError = sonioxError || e));
    check(
      "Soniox streamed without errors",
      sonioxError ? "fail" : "pass",
      sonioxError?.message || ""
    );
    check("live partials arrived", partials > 0 ? "pass" : "fail", `${partials} partial updates`);
    check(
      "final transcript segments",
      finals.length > 0 ? "pass" : "fail",
      `${finals.length} segments`
    );
  }
  fs.writeFileSync(
    path.join(outDir, "transcript.txt"),
    finals.map((f) => f.text).join("\n") + "\n"
  );
  if (args.ui) await screenshot(copilot, outDir, "1-live");

  // 5. the copilot's view of the meeting
  const sessionId = await waitFor(async () => (await invoke("sessions-list"))[0]?.id, 5000);
  check("meeting saved in the copilot store", sessionId ? "pass" : "fail");
  if (!sessionId) {
    copilot.close();
    return finish(outDir, profile);
  }
  const saved = () => copilot.store.getSession(sessionId);
  check(
    "every final reached the copilot transcript",
    saved().segments.length === finals.length ? "pass" : "fail",
    `${saved().segments.length} saved / ${finals.length} sent`
  );

  if (args.settle) console.log(`Waiting up to ${args.settle} s for proactive cards…`);
  const settled = (s) => s.cards.every((c) => !["queued", "running"].includes(c.status));
  await sleep(args.settle * 1000);
  await waitFor(() => settled(saved()), 60000);
  const proactive = saved().cards.filter((c) => c.proactive);
  const proactiveDone = proactive.filter((c) => c.status === "done");
  check(
    "proactive cards (depends on what was said)",
    proactiveDone.length ? "pass" : "warn",
    `${proactiveDone.length} shown, ${proactive.filter((c) => c.status === "skipped").length} skipped, ${proactive.filter((c) => c.status === "error").length} errors`
  );

  // 6. a typed question, as from the window's composer
  const question =
    args.ask ||
    (projectId
      ? "Based on the project files, what is the key point of the proposal?"
      : "Recap what has been said so far in two short bullets.");
  const jobId = await invoke("ask", { text: question, web: false, threadId: "main" });
  check("typed question accepted", jobId ? "pass" : "fail", question);
  if (jobId) {
    const card = await waitFor(
      () => {
        const c = saved().cards.find((x) => x.id === jobId);
        return c && !["queued", "running"].includes(c.status) ? c : null;
      },
      120000,
      1000
    );
    const ok = card?.status === "done" && (card.body || "").trim().length > 0;
    check(
      "typed question answered",
      ok ? "pass" : "fail",
      card
        ? `${card.status}${card.timing?.totalMs ? `, ${card.timing.totalMs} ms` : ""}: ${card.title || ""}`
        : "timed out after 120 s"
    );
    if (card?.body)
      fs.writeFileSync(path.join(outDir, "typed-answer.md"), `# ${card.title}\n\n${card.body}\n`);
  }
  const errored = saved().cards.filter((c) => c.status === "error");
  check(
    "no card failed",
    errored.length ? "fail" : "pass",
    errored.map((c) => c.title || c.id).join(", ")
  );
  if (args.ui) await screenshot(copilot, outDir, "2-cards");

  // 7. end of the meeting
  copilot.endSession();
  const ended = await waitFor(() => saved().session.ended_at != null, 10000);
  check("meeting ended and closed in the store", ended ? "pass" : "fail");
  const summary = await waitFor(() => (saved().session.summary || "").trim(), 45000, 1000);
  check(
    "meeting summary written",
    summary ? "pass" : "warn",
    summary ? `${summary.split(/\s+/).length} words` : "none (short meetings may not get one)"
  );
  await waitFor(() => settled(saved()), 60000);
  fs.writeFileSync(path.join(outDir, "session.json"), JSON.stringify(saved(), null, 2));
  if (args.ui) await screenshot(copilot, outDir, "3-ended");

  copilot.close();
  return finish(outDir, profile);
}

function finish(outDir, profile) {
  const fails = checks.filter((c) => c.status === "fail");
  const warns = checks.filter((c) => c.status === "warn");
  const lines = [
    "# Copilot desktop e2e",
    "",
    `Run: ${new Date().toISOString()} · ${os.platform()} ${os.release()} · Electron ${process.versions.electron}`,
    "",
    "| Check | Result | Detail |",
    "| --- | --- | --- |",
    ...checks.map(
      (c) => `| ${c.name} | ${c.status.toUpperCase()} | ${String(c.detail).replace(/\|/g, "\\|")} |`
    ),
    "",
    `**${fails.length ? "FAILED" : "PASSED"}**: ${checks.length - fails.length - warns.length} passed, ${warns.length} warnings, ${fails.length} failed.`,
    "",
  ];
  fs.writeFileSync(path.join(outDir, "report.md"), lines.join("\n"));
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify({ checks }, null, 2));
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {}
  console.log(`\n${fails.length ? "FAILED" : "PASSED"} — ${path.join(outDir, "report.md")}`);
  return fails.length ? 1 : 0;
}

app.disableHardwareAcceleration();
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "copilot-e2e-app-")));
app.on("window-all-closed", () => {}); // the test decides when to quit
app.whenReady().then(async () => {
  let code = 1;
  try {
    code = await main();
  } catch (error) {
    console.error(error);
    check("e2e run", "fail", error.message);
    code = finish(path.resolve(args.out || "copilot-e2e-crash"), os.tmpdir() + "/__none__");
  }
  app.exit(code);
});
