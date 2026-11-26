// Wires the copilot together inside the app: engine (decisions + cards), storage, settings, the window
// and the IPC the window uses. The app calls only the hooks returned here (see src/copilot/main/index.js).
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createEngine } = require("./engine");
const { createSettings } = require("./settings");
const { openStore } = require("./store");
const { createCopilotWindow } = require("./window");
const { readReference } = require("./reference");
const { startMemProbe } = require("./memProbe");
const { matchProject, rulesFromEvent } = require("./projectMatch");
const { createEmbedClient } = require("../rag/embedClient");
const { createAnalyzer } = require("../rag/analyzeClient");
const { createMedia } = require("../rag/media");
const { createIngestor, friendly } = require("../rag/ingest");
const { createRetriever } = require("../rag/retrieve");
const { createRagLog } = require("../rag/ragLog");
const { createAuthoritativeLookup } = require("../rag/authoritativeLookup");
const { createDeltaIngest } = require("../rag/deltaIngest");
const { createBehavior } = require("./behavior");
const { createOpenRouterLlm, DEFAULT_SUMMARY_MODEL } = require("../core/summary/rollingSummary");
const { createOkfRegistry } = require("../core/okf/registry");
const { createOkfRouter } = require("../core/okf/router");
const { createTemporalRouter } = require("../core/okf/temporalRouter");
const { createScientistSynthesizerAsync } = require("../core/answer/scientistSynthesizer");
const gitLocalAdapter = require("../../helpers/connectors/gitLocalAdapter");
const { backfillProfiles } = require("../rag/profileBackfill");
const { repoFingerprint } = require("../rag/repoFingerprint");
const { resolveRegisteredRepo, checkDroppedFile } = require("../core/validation/pathPolicy");

const NOT_REPLAYED = new Set([
  "partial",
  "stats",
  "defer",
  "activity",
  "mode",
  "card_update",
  "level",
]);
const MAX_HISTORY = 1500;

// The app's debug log when the copilot runs inside it; plain console in tests and scripts.
function defaultLogError(message, error) {
  try {
    require("../../helpers/debugLogger").error(message, { error: error?.message }, "copilot");
  } catch {
    console.error(message, error);
  }
}

function createCopilot({
  dir, // userData
  logDir = null,
  env = process.env,
  electron, // { app, BrowserWindow, screen, ipcMain, dialog, safeStorage }
  loadRenderer,
  setupAlwaysOnTop,
  getActiveEvents = () => [], // calendar events happening now (the app's database), to pick the project
  ffmpegPath = null, // bundled ffmpeg, for audio/video project files
  transcribeAudio = null, // optional host STT callback: (buffer, mimeType) => Promise<{ ok, text, error }>
  onStartMeeting = null, // optional host callback: start a meeting note (the app's manual meeting)
  onStopMeeting = null, // optional host callback: end the live meeting note
  onOpenReference = null, // optional host callback: ({ fileId, projectId, name, page, snippet }) => void
  onOpenSettings = null, // optional host callback: (section?: string) => void
  engineOptions = {}, // tests
  Database,
  logError = defaultLogError,
}) {
  const { BrowserWindow, screen, ipcMain, dialog, safeStorage } = electron;
  const settings = createSettings({ dir, safeStorage, env });
  const store = openStore({
    dbPath: path.join(dir, "copilot.db"),
    ...(Database ? { Database } : {}),
  });
  store.closeOpenSessions();
  store.prune(settings.view().retentionDays);

  const broadcast = (channel, payload) => {
    for (const w of BrowserWindow.getAllWindows?.() ?? []) {
      if (!w.isDestroyed?.() && !w.webContents?.isDestroyed?.()) {
        w.webContents.send(channel, payload);
      }
    }
  };

  const win = createCopilotWindow({
    BrowserWindow,
    screen,
    loadRenderer,
    setupAlwaysOnTop,
    getWindowState: () => settings.view().window,
    saveWindowState: (window) => settings.update({ window }),
    onVisibilityChange: (open) => broadcast("copilot:window-state", open),
  });

  let sessionId = null;
  let projectId = null; // the project of the meeting on now (null = none picked: the ticked projects apply)
  let calendarEvent = null; // the event this meeting is linked to
  let history = []; // the current meeting's events, replayed when the window (re)loads
  let lastStats = null;
  const jobs = new Map(); // job id -> the card as started (its session, thread, focus ...)

  const push = (e) => win.send("copilot:event", e);

  // Loudness of the meeting audio for the orb's bars: the loudest chunk of each ~80 ms, from either side.
  let levelPeak = 0;
  let levelAt = 0;
  const onLevel = (pcm16) => {
    if (!pcm16 || pcm16.length < 2 || !win.isOpen() || engine.isPaused()) return;
    let sum = 0;
    const n = pcm16.length >> 1;
    for (let i = 0; i < n; i++) {
      const x = pcm16.readInt16LE(i << 1) / 32768;
      sum += x * x;
    }
    levelPeak = Math.max(levelPeak, Math.sqrt(sum / n));
    const t = Date.now();
    if (t - levelAt < 80) return;
    levelAt = t;
    // rms of speech is ~0.01..0.2: a square root spreads it over the bars
    push({ type: "level", v: Math.min(1, Math.sqrt(levelPeak * 6)) });
    levelPeak = 0;
  };

  // Everything the engine reports passes here: remember it, save it, show it.
  const sink = {
    open() {
      const s = settings.view();
      // Opens without a key too: the window then shows the transcript and says the key is missing,
      // instead of the meeting going by with no sign of the copilot at all.
      if (!(s.enabled && s.autoOpen)) return;
      // A window that fails to open must never break the meeting itself.
      try {
        win.open({ focus: false, startMode: s.idleMode });
      } catch (error) {
        logError("Copilot window failed to open", error);
      }
    },
    send(e) {
      const started = e.type === "session" && e.state === "start";
      if (started) history = [];
      try {
        persist(e);
      } catch (error) {
        ragLog({ event: "persist_failed", type: e.type, error: error.message });
      }
      if (started) e = { ...e, sessionId };
      if (e.type === "stats") lastStats = e;
      if (!NOT_REPLAYED.has(e.type)) {
        history.push(e);
        if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
      }
      push(e);
      if (started) {
        announceMeeting();
        if (!settings.view().hasKey) {
          const problem = { type: "problem", kind: "no_key" };
          history.push(problem);
          push(problem);
        }
      }
    },
  };

  // The project of this meeting: from the calendar event now on (rules the user made), else none.
  const projectView = () => {
    const p = projectId != null ? store.projects.get(projectId) : null;
    return {
      type: "project",
      projectId: p ? p.id : null,
      name: p?.name ?? null,
      event: calendarEvent
        ? { title: calendarEvent.summary ?? "", endsAt: Date.parse(calendarEvent.end_time) || null }
        : null,
    };
  };
  function announceProject() {
    const v = projectView();
    history = history.filter((h) => h.type !== "project");
    history.push(v);
    push(v);
  }
  function pickProject() {
    try {
      const events = getActiveEvents() ?? [];
      // the event that started most recently is the call you are in
      calendarEvent =
        [...events].sort((a, b) => Date.parse(b.start_time) - Date.parse(a.start_time))[0] ?? null;
    } catch {
      calendarEvent = null;
    }
    if (calendarEvent?.summary && sessionId)
      store.setSessionTitle(sessionId, calendarEvent.summary);
    if (settings.view().autoProject && calendarEvent)
      projectId = matchProject(calendarEvent, store.projects.rules());
    if (sessionId) store.setSessionProject(sessionId, projectId);
  }
  // After the window has been told the meeting started (its state resets on that event).
  function announceMeeting() {
    if (calendarEvent)
      engine.setMeeting({
        title: calendarEvent.summary,
        endsAt: Date.parse(calendarEvent.end_time) || undefined,
      });
    announceProject();
  }
  // The files and notes the engine reads: the meeting's project, else every ticked project.
  const projectFiles = () =>
    projectId != null ? store.projects.files(projectId) : store.projects.activeFiles();
  const engineSettings = () => {
    const st = settings.engine();
    const p = projectId != null ? store.projects.get(projectId) : null;
    if (!p) return st;
    const join = (a, b) =>
      [a, b]
        .map((x) => (x ?? "").trim())
        .filter(Boolean)
        .join("\n\n");
    return {
      ...st,
      instructions: join(st.instructions, p.instructions),
      plan: join(st.plan, p.plan),
    };
  };

  // ---- project files: indexing and search (src/copilot/rag, docs/copilot/RAG_PLAN.md)
  const ragLog = createRagLog({ dir: logDir ?? dir, echo: env.COPILOT_LOG === "1" });
  let clientCache = null;
  const ragClients = () => {
    const st = settings.engine();
    if (!st.apiKey || st.ragEnabled === false) return null;
    const sig = [st.apiKey, st.embedModel, st.analysisModel].join("|");
    if (clientCache?.sig !== sig)
      clientCache = {
        sig,
        embed: createEmbedClient({
          apiKey: st.apiKey,
          ...(st.embedModel ? { model: st.embedModel } : {}),
        }),
        analyze: createAnalyzer({
          apiKey: st.apiKey,
          ...(st.analysisModel ? { model: st.analysisModel } : {}),
        }),
      };
    return clientCache;
  };
  // ---- OKF canonical registry & bi-temporal routing (graceful fallback if OKF bundle is missing/invalid)
  let okfRegistry = null;
  let okfRouter = null;
  let authoritativeLookup = null;
  let temporalRouter = null;
  let deltaIngest = null;
  try {
    okfRegistry = createOkfRegistry({
      okfDir: path.resolve(__dirname, "../../../OKF"),
      log: ragLog,
    });
    okfRouter = createOkfRouter();
    // Check every document against the manifest now, so a tampered or stale bundle shows up in the log at launch
    // (each failing document is also refused at lookup, see registry.getDocument).
    okfRegistry.verifyAll();
    ragLog({ event: "okf_status", ...okfRegistry.getLoadStatus(), documents: okfRegistry.getDocuments().length });
    const featReg = okfRegistry?.featureRegistry;
    if (featReg && featReg.hasRegistry() && store.rag?.temporal) {
      store.rag.temporal.configure({ featureRegistry: featReg, log: ragLog });
      store.rag.configure?.({ log: ragLog });
      authoritativeLookup =
        typeof store.rag.createAuthoritativeLookup === "function"
          ? store.rag.createAuthoritativeLookup({ featureRegistry: featReg, log: ragLog })
          : createAuthoritativeLookup({
              ragStore: store.rag,
              temporalStore: store.rag.temporal,
              featureRegistry: featReg,
              log: ragLog,
            });
      temporalRouter = createTemporalRouter({
        log: ragLog,
        featureRegistry: featReg,
        temporalStore: store.rag.temporal,
        authoritativeLookup,
      });
      deltaIngest =
        typeof store.rag.createDeltaIngest === "function"
          ? store.rag.createDeltaIngest({
              featureRegistry: featReg,
              log: ragLog,
              options: { autoIndexUnmatched: true },
            })
          : createDeltaIngest({
              ragStore: store.rag,
              temporalStore: store.rag.temporal,
              featureRegistry: featReg,
              log: ragLog,
              options: { autoIndexUnmatched: true },
            });
    }
  } catch (err) {
    ragLog({ event: "okf_init_fallback", error: err.message });
  }

  const ingestor = createIngestor({
    rag: store.rag,
    clients: ragClients,
    media: createMedia({ ffmpegPath }),
    deltaIngest,
    log: ragLog,
    getCfg: () => ({ mediaEmbedMinutes: settings.engine().mediaEmbedMinutes }),
  });
  const retriever = createRetriever({
    rag: store.rag,
    clients: ragClients,
    log: ragLog,
    catalogMode: env.COPILOT_CATALOG || undefined, // "profile" | "summary" (RAG.catalogMode)
    als: authoritativeLookup,
    temporalRouter,
  });
  const projectIds = () => (projectId != null ? [projectId] : store.projects.activeIds());

  function persist(e) {
    switch (e.type) {
      case "session":
        if (e.state === "start") {
          sessionId = crypto.randomUUID();
          store.startSession(sessionId, "Live meeting");
          projectId = null;
          calendarEvent = null;
          pickProject();
        } else if (sessionId) {
          store.endSession(sessionId, e.summary);
          void behavior.maybeUpdate(); // a meeting just ended: a good time, if enough feedback has piled up
        }
        break;
      case "segment":
        if (sessionId)
          store.addSegment(sessionId, {
            id: e.id,
            source: e.source,
            speaker: e.label,
            text: e.text,
            at: e.at,
          });
        break;
      case "summary":
        if (sessionId) store.setSummary(sessionId, e.text);
        break;
      case "thread":
        if (sessionId && e.action !== "close") store.saveThread(sessionId, e.thread);
        if (sessionId && e.action === "close")
          store.saveThread(sessionId, { id: e.thread.id, title: "" }, true);
        break;
      case "card_queued":
      case "card_start": {
        const card = {
          ...(jobs.get(e.id) ?? {}),
          ...e,
          sessionId: jobs.get(e.id)?.sessionId ?? sessionId,
          createdAt: Date.now(),
        };
        jobs.set(e.id, card);
        store.saveCard(card.sessionId, {
          ...card,
          status: e.type === "card_queued" ? "queued" : "running",
        });
        break;
      }
      case "card_done":
      case "card_error":
      case "card_skip":
      case "card_cancel": {
        const card = jobs.get(e.id);
        if (!card) break;
        const status = {
          card_done: "done",
          card_error: "error",
          card_skip: "skipped",
          card_cancel: "cancelled",
        }[e.type];
        store.saveCard(card.sessionId, {
          ...card,
          ...(e.type === "card_done" ? e : {}),
          status,
          createdAt: card.createdAt,
        });
        jobs.delete(e.id);
        break;
      }
      default:
    }
  }

  // The global behaviour guide: learned rarely from feedback, never from stored samples.
  const behavior = createBehavior({
    dir,
    settings,
    llm: () => {
      const st = settings.engine();
      return st.apiKey
        ? createOpenRouterLlm({
            apiKey: st.apiKey,
            model: st.summaryModel || DEFAULT_SUMMARY_MODEL,
            timeoutMs: 30000,
          })
        : null;
    },
  });

  // ---- Local Vectorless Code Intelligence (100% offline, 0 vectors, 0 GitHub API) ----
  const MAX_CODE_SYNTHS = 8;
  const codeSynths = new Map(); // absRepoPath -> ScientistSynthesizer (insertion order = least recently built first)
  const codeFingerprints = new Map(); // absRepoPath -> fingerprint the cached index was built from
  const codeBuilds = new Map(); // absRepoPath -> in-flight freshSynth promise, so concurrent questions share one check
  const cachedSynth = (repoDir) => codeSynths.get(path.resolve(String(repoDir || ""))) || null;
  const remember = (abs, synth) => {
    codeSynths.delete(abs);
    codeSynths.set(abs, synth);
    while (codeSynths.size > MAX_CODE_SYNTHS) {
      const oldest = codeSynths.keys().next().value;
      codeSynths.delete(oldest);
      codeFingerprints.delete(oldest);
    }
  };
  // The index follows the repo: compare a cheap fingerprint first and rebuild (in time slices) only when it moved.
  const freshSynth = (repoDir, { force = false } = {}) => {
    const abs = path.resolve(String(repoDir || ""));
    if (!abs || !fs.existsSync(abs)) return Promise.resolve(null);
    if (codeBuilds.has(abs)) return codeBuilds.get(abs);
    const job = (async () => {
      const fp = await repoFingerprint(abs);
      const stale = force || !codeSynths.has(abs) || (fp !== null && codeFingerprints.get(abs) !== fp);
      if (!stale) return codeSynths.get(abs);
      const synth = await createScientistSynthesizerAsync({ repoDir: abs, maxFiles: 1500, db: store.db || null, log: ragLog });
      remember(abs, synth);
      codeFingerprints.set(abs, fp);
      return synth;
    })().finally(() => codeBuilds.delete(abs));
    codeBuilds.set(abs, job);
    return job;
  };
  // Renderer-supplied repo paths are honoured only for repos the user added through the folder picker.
  const registeredRepoDir = (repoDir) => resolveRegisteredRepo(repoDir, store.codeRepos.list());
  const enrichRepo = (r) => {
    const abs = path.resolve(r.path);
    const activeBranch = fs.existsSync(abs) ? gitLocalAdapter.getCurrentBranch({ cwd: abs }) : null;
    return { ...r, activeBranch };
  };

  const engine = createEngine({
    env,
    logDir,
    panel: sink,
    getSettings: () => engineSettings(),
    // Files the search has not read yet (still indexing, or it failed) are inlined the old way.
    onSignal: (kind, line) => {
      behavior.note(kind, line);
      void behavior.maybeUpdate();
    },
    getReference: () => readReference(projectFiles().filter((f) => f.status !== "ready")),
    rag: {
      hasIndex: () => retriever.hasIndex(projectIds()),
      catalog: () => retriever.catalog(projectIds()),
      catalogLines: () => retriever.catalogLines(projectIds()),
      writerCatalog: () => retriever.writerCatalog(projectIds()),
      catalogMode: () => retriever.catalogMode(),
      prefetch: (query) => retriever.prefetch(query, projectIds()),
      retrieve: (o) => retriever.retrieve({ ...o, projectIds: projectIds() }),
      log: (record) => ragLog(record), // the engine's sufficiency verdict joins the search's own records
    },
    localCode: {
      hasRepos: () => store.codeRepos.list().length > 0,
      catalog: () => {
        const repos = store.codeRepos.list();
        if (!repos.length) return "";
        const sections = [
          "Connected local code repositories (vectorless Code-to-MD + PageRank RepoMap + local git):",
        ];
        let remainingChars = 4800;
        for (const r of repos) {
          const exists = fs.existsSync(r.path);
          const branch = exists ? gitLocalAdapter.getCurrentBranch({ cwd: r.path }) : "unknown";
          const header = `- ${r.name} (${r.path}, branch: ${branch}, ${r.stats?.codeModules ?? 0} modules)`;
          sections.push(header);
          remainingChars -= header.length + 1;
          if (exists && remainingChars > 300) {
            // The catalog is built synchronously from the cached index; refresh in the background for the next one.
            freshSynth(r.path).catch((error) => logError("Background repo refresh failed", error));
            const synth = cachedSynth(r.path);
            if (synth?.codeIndex) {
              const mapMd = synth.codeIndex.generateRepoMapMarkdown({ maxModules: 25 });
              const trimmed =
                mapMd.length > remainingChars
                  ? mapMd.slice(0, remainingChars).trimEnd() + "\n..."
                  : mapMd;
              sections.push(trimmed);
              remainingChars -= trimmed.length + 1;
            }
          }
        }
        return sections.join("\n");
      },
      search: async (query) => {
        const repos = store.codeRepos.list();
        if (!repos.length) return null;
        const sections = [];
        const files = [];
        for (const r of repos) {
          const synth = await freshSynth(r.path);
          if (!synth) continue;
          const res = synth.analyze(query, { topK: 6 });
          if (res?.markdown) {
            sections.push(res.markdown);
            for (const hit of res.evidence?.codeHits || []) {
              if (hit.relPath && !files.includes(hit.relPath)) files.push(hit.relPath);
            }
          }
        }
        return sections.length ? { passages: sections.join("\n\n---\n\n").slice(0, 12000), files } : null;
      },
    },
    okf:
      okfRegistry && okfRouter
        ? {
            registry: okfRegistry,
            router: okfRouter,
          }
        : null,
    ...engineOptions,
  });

  // ---- IPC for the window ----
  const str = (v, max = 4000) => (typeof v === "string" ? v.slice(0, max) : "");
  const handle = (name, fn) => ipcMain.handle(`copilot:${name}`, (_e, ...args) => fn(...args));
  ipcMain.on("copilot:ready", () => {
    for (const e of history) push(e);
    if (lastStats) push(lastStats);
    push({ type: "mode", mode: win.mode() });
  });
  handle("ask", (q = {}) =>
    engine.ask({
      text: str(q.text),
      web: !!q.web,
      threadId: str(q.threadId, 40) || "main",
      quote: str(q.quote, 1200),
      skippedId: str(q.skippedId, 20),
      attachment: q.attachment
        ? {
            name: str(q.attachment.name, 120),
            content: str(q.attachment.content, 100000),
            size: Number(q.attachment.size) || 0,
            type: str(q.attachment.type, 50),
          }
        : null,
    })
  );
  handle("pause", (paused) => {
    const isPaused = paused != null ? !!paused : true;
    const res = engine.setPaused(isPaused);
    if (isPaused) push({ type: "level", v: 0 });
    return res;
  });
  handle("resume", () => engine.resume());
  handle("pause-toggle", () => {
    const next = !engine.isPaused();
    const res = engine.setPaused(next);
    if (next) push({ type: "level", v: 0 });
    return res;
  });
  handle("cancel", (id) => engine.cancel(str(id, 40)));
  handle("rerun", (id) => engine.rerun(str(id, 40)));
  handle("transcribe-audio", async (audioData, mimeType = "audio/webm") => {
    const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
    let buffer = null;
    if (Buffer.isBuffer(audioData)) buffer = audioData;
    else if (audioData instanceof ArrayBuffer) buffer = Buffer.from(audioData);
    else if (ArrayBuffer.isView(audioData)) {
      buffer = Buffer.from(audioData.buffer, audioData.byteOffset, audioData.byteLength);
    }
    if (!buffer || buffer.length === 0) {
      return { ok: false, error: "No audio was recorded." };
    }
    if (buffer.length > MAX_AUDIO_BYTES) {
      return { ok: false, error: "Audio recording is too large (max 25 MB)." };
    }

    const mime = str(mimeType, 80) || "audio/webm";

    // 1. Try host app's local/configured transcription if provided.
    if (typeof transcribeAudio === "function") {
      try {
        const res = await transcribeAudio(buffer, mime);
        const text = typeof res?.text === "string" ? res.text.trim() : "";
        if (res?.ok && text) return { ok: true, text };
      } catch (err) {
        logError("Copilot host audio transcription failed; checking OpenRouter fallback", err);
      }
    }

    // 2. Fallback to Copilot's OpenRouter key + analysis model (supports input_audio).
    const st = settings.engine();
    if (!st.apiKey) {
      return {
        ok: false,
        error: "Add your OpenRouter key in Settings to use voice input.",
      };
    }

    const voiceMedia = createMedia({ ffmpegPath });
    let tmpDir = null;
    try {
      let payloadBuf = buffer;
      let format = mime.includes("wav")
        ? "wav"
        : mime.includes("mpeg") || mime.includes("mp3")
          ? "mp3"
          : null;
      if (!format) {
        if (!voiceMedia.available()) {
          return {
            ok: false,
            error: "Audio converter (ffmpeg) is unavailable for voice input.",
          };
        }
        tmpDir = voiceMedia.makeDir();
        const ext = mime.includes("ogg") ? "ogg" : mime.includes("mp4") ? "m4a" : "webm";
        const rawPath = path.join(tmpDir, `voice.${ext}`);
        fs.writeFileSync(rawPath, buffer);
        const mp3Path = await voiceMedia.workingCopy("audio", rawPath, tmpDir);
        payloadBuf = fs.readFileSync(mp3Path);
        format = "mp3";
      }

      const analyzer = createAnalyzer({
        apiKey: st.apiKey,
        ...(st.analysisModel ? { model: st.analysisModel } : {}),
      });
      const result = await analyzer.ask(
        [
          {
            type: "text",
            text: "Transcribe the spoken words in this audio accurately and verbatim. Output only the transcribed text, with no timestamps, labels, or commentary.",
          },
          {
            type: "input_audio",
            input_audio: {
              data: payloadBuf.toString("base64"),
              format,
            },
          },
        ],
        { maxTokens: 2000 }
      );
      const text = String(result?.text ?? "").trim();
      if (!text) {
        return { ok: false, error: "No speech was detected in the recording." };
      }
      return { ok: true, text };
    } catch (err) {
      logError("Copilot voice transcription failed", err);
      return {
        ok: false,
        error: err?.message || "Voice transcription failed.",
      };
    } finally {
      if (tmpDir) {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (error) {
          logError("Could not remove the temporary voice folder", error); // best effort, but not silent
        }
      }
    }
  });
  handle("thread-create", (title) => engine.createThread({ title: str(title, 40) }));
  handle("thread-rename", (id, title) => engine.renameThread(str(id, 40), str(title, 40)));
  handle("thread-close", (id) => engine.closeThread(str(id, 40)));
  handle("feedback", (sid, jobId, value) => {
    const v = ["up", "down", "dismissed"].includes(value) ? value : null;
    engine.noteFeedback(str(jobId, 40), v);
    return store.setFeedback(str(sid, 80), str(jobId, 40), v);
  });
  handle("settings-get", () => withError(settings.view()));
  // The window toggle key. The app registers it (main.js gives us the registrar); a key the desktop refuses is not saved.
  let registrar = null;
  let hotkeyError = "";
  const bindHotkey = async (key) => {
    if (!registrar) return true;
    try {
      const r = await registrar(key);
      hotkeyError = r?.success === false ? r.error || "That key could not be registered." : "";
    } catch (error) {
      hotkeyError = error?.message || "That key could not be registered.";
    }
    return !hotkeyError;
  };
  const withError = (view) => ({ ...view, hotkeyError });
  // One update at a time: each may wait on the hotkey registrar, and two keys pressed quickly must not
  // interleave (the first key's late answer would save it while the second one is registered).
  let settingsQueue = Promise.resolve();
  handle("settings-update", (patch) => {
    const run = settingsQueue.then(() => applySettings(patch));
    settingsQueue = run.catch(() => {});
    return run;
  });
  async function applySettings(patch) {
    patch = patch && typeof patch === "object" ? { ...patch } : {};
    if (typeof patch.hotkey === "string" && patch.hotkey !== settings.view().hotkey) {
      if (!(await bindHotkey(patch.hotkey.slice(0, 80)))) {
        delete patch.hotkey;
        await bindHotkey(settings.view().hotkey); // put the old key back
        hotkeyError = "That key could not be registered (already in use?).";
      }
    }
    const view = withError(settings.update(patch));
    push({ type: "settings", settings: view });
    broadcast("copilot:settings-updated", view);
    return view;
  }
  handle("projects-list", () => store.projects.list());
  handle("project-create", (name) => store.projects.create(str(name, 80)));
  handle("project-rename", (id, name) => store.projects.rename(Number(id), str(name, 80)));
  handle("project-update", (id, patch = {}) =>
    store.projects.update(Number(id), {
      name: str(patch.name, 80) || undefined,
      instructions:
        typeof patch.instructions === "string" ? str(patch.instructions, 8000) : undefined,
      plan: typeof patch.plan === "string" ? str(patch.plan, 8000) : undefined,
    })
  );
  handle("project-rule-add", (id, kind, pattern) =>
    store.projects.addRule(Number(id), str(kind, 20), str(pattern, 200))
  );
  handle("project-rule-remove", (id) => store.projects.removeRule(Number(id)));
  // The user picks (or clears) the project of the meeting on now; "remember" teaches the calendar rule.
  handle("session-project", (id, remember) => {
    projectId = id == null ? null : Number(id);
    if (sessionId) store.setSessionProject(sessionId, projectId);
    if (remember && projectId != null)
      for (const r of rulesFromEvent(calendarEvent))
        store.projects.addRule(projectId, r.kind, r.pattern);
    announceProject();
    return projectView();
  });
  handle("session-project-get", () => projectView());
  const filesRoot = path.join(dir, "copilot-files");
  const isManagedFile = (p) => {
    if (!p) return false;
    const rel = path.relative(filesRoot, path.resolve(p));
    return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  };
  const deleteManagedFile = (p) => {
    if (!isManagedFile(p)) return;
    try {
      fs.rmSync(p, { force: true });
    } catch (error) {
      logError("Could not remove a project file copy", error); // best effort, but not silent
    }
  };
  handle("project-remove", (id) => {
    const pid = Number(id);
    for (const f of store.projects.files(pid)) deleteManagedFile(f.path);
    try {
      fs.rmSync(path.join(filesRoot, String(pid)), { recursive: true, force: true });
    } catch (error) {
      logError("Could not remove a project's file folder", error); // best effort, but not silent
    }
    return store.projects.remove(pid);
  });
  handle("project-active", (id, active) => store.projects.setActive(Number(id), !!active));
  handle("project-remove-file", (id) => {
    const f = store.rag.file(Number(id));
    if (f) deleteManagedFile(f.path);
    return store.projects.removeFile(Number(id));
  });
  handle("project-download-file", async (id) => {
    const f = store.rag.file(Number(id));
    if (!f || !f.path || !fs.existsSync(f.path)) {
      return { ok: false, error: "File is no longer available on disk." };
    }
    const parentWin = win.webContents() ? BrowserWindow.fromWebContents(win.webContents()) : null;
    const res = await dialog.showSaveDialog(parentWin, {
      defaultPath: f.name || path.basename(f.path),
    });
    if (res.canceled || !res.filePath) {
      return { ok: false, canceled: true };
    }
    try {
      fs.copyFileSync(f.path, res.filePath);
      return { ok: true, path: res.filePath };
    } catch (error) {
      return { ok: false, error: error?.message || "Failed to save file." };
    }
  });
  handle("project-preview-file", async (id) => {
    const { classify, MIME, extOf } = require("../rag/config");
    const f = store.rag.file(Number(id));
    if (!f) return { ok: false, error: "File not found." };
    const kind = f.kind || classify(f.name) || "text";
    const mime = MIME[extOf(f.name)] || "text/plain";
    const exists = Boolean(f.path && fs.existsSync(f.path));

    if (kind === "office" || !exists) {
      const chunks = store.rag.fileChunks(f.id);
      if (!chunks.length) {
        return {
          ok: false,
          error: exists
            ? "Preview is not ready yet for this document."
            : "File is no longer available on disk.",
        };
      }
      return {
        ok: true,
        kind: "text",
        name: f.name,
        mime: "text/plain",
        text: chunks.map((c) => c.text).join("\n\n---\n\n"),
        truncated: false,
      };
    }

    try {
      if (kind === "text") {
        const MAX_TEXT = 200 * 1024;
        const stat = fs.statSync(f.path);
        const buf = fs.readFileSync(f.path);
        const truncated = stat.size > MAX_TEXT;
        return {
          ok: true,
          kind: "text",
          name: f.name,
          mime,
          text: (truncated ? buf.subarray(0, MAX_TEXT) : buf).toString("utf8"),
          truncated,
        };
      }
      if (kind === "pdf" || kind === "image" || kind === "audio" || kind === "video") {
        const MAX_MEDIA = 25 * 1024 * 1024;
        const stat = fs.statSync(f.path);
        if (stat.size > MAX_MEDIA) {
          const chunks = store.rag.fileChunks(f.id);
          if (chunks.length) {
            return {
              ok: true,
              kind: "text",
              name: f.name,
              mime: "text/plain",
              text: chunks.map((c) => c.text).join("\n\n---\n\n"),
              truncated: true,
            };
          }
          return { ok: false, error: "File is too large to preview inline. Use Download instead." };
        }
        const buf = fs.readFileSync(f.path);
        return {
          ok: true,
          kind,
          name: f.name,
          mime,
          dataBase64: buf.toString("base64"),
        };
      }
      return { ok: false, error: "Preview is not supported for this file type." };
    } catch (error) {
      return { ok: false, error: error?.message || "Could not load file preview." };
    }
  });
  handle("project-add-files", async (id) => {
    const r = await dialog.showOpenDialog(
      win.webContents() ? BrowserWindow.fromWebContents(win.webContents()) : null,
      {
        properties: ["openFile", "multiSelections"],
      }
    );
    if (r.canceled) return 0;
    return addPaths(id, r.filePaths);
  });
  // Files dropped on the Copilot page: only existing regular files are taken and copied into local managed storage.
  const addPaths = (id, paths) => {
    const pid = Number(id);
    const files = [];
    for (const p of Array.isArray(paths) ? paths : []) {
      if (files.length >= 50) break;
      const check = checkDroppedFile(p);
      if (check.ok) files.push(check.path);
      else logError(`Skipped dropped file (${check.reason})`, new Error(path.basename(String(p))));
    }
    const projectDir = path.join(filesRoot, String(pid));
    if (files.length) fs.mkdirSync(projectDir, { recursive: true });
    let added = 0;
    for (const p of files) {
      const base = path.basename(p);
      const safeName = base.replace(/[^a-zA-Z0-9._-]/g, "_");
      const localPath = path.join(projectDir, `${crypto.randomUUID().slice(0, 8)}-${safeName}`);
      try {
        fs.copyFileSync(p, localPath);
      } catch (error) {
        // Never index the original location: it is outside managed storage and was not vetted beyond the drop.
        logError("Failed to copy project file to local storage; skipping it", error);
        continue;
      }
      const targetPath = localPath;
      const f = store.projects.addFileRow(pid, targetPath, base);
      added += 1;
      ingestor.ingest(f).catch((error) => {
        ragLog({ event: "background_ingest_failed", file_id: f.id, error: error?.message });
      }); // reads, splits, embeds and summarises in the background; the page shows its progress
    }
    return added;
  };
  handle("project-add-paths", addPaths);
  // Try a failed (or changed) file again.
  handle("project-reindex", (fileId) => {
    const f = store.rag.file(Number(fileId));
    if (!f) return false;
    ingestor.ingest(f).catch((error) => {
      ragLog({ event: "background_reindex_failed", file_id: f.id, error: error?.message });
    });
    return true;
  });
  handle("open-reference", (ref = {}) => {
    const requestedId = ref?.fileId != null ? Number(ref.fileId) : null;
    const requestedName = str(ref?.name, 260);
    let file =
      requestedId != null && Number.isFinite(requestedId) ? store.rag.file(requestedId) : null;
    if (!file && requestedName) {
      const candidates = store.projects
        .list()
        .flatMap((p) => p.files.map((f) => ({ ...f, project_id: p.id })));
      file =
        candidates.find(
          (f) => projectId != null && f.project_id === projectId && f.name === requestedName
        ) ||
        candidates.find((f) => f.name === requestedName) ||
        null;
    }
    if (!file) return { ok: false, error: "Referenced file not found in Copilot projects." };
    const payload = {
      fileId: file.id,
      projectId: file.project_id,
      name: file.name,
      page: ref?.page != null && Number.isFinite(Number(ref.page)) ? Number(ref.page) : null,
      where: str(ref?.where, 120) || null,
      snippet: str(ref?.snippet, 300) || null,
    };
    if (typeof onOpenReference === "function") {
      onOpenReference(payload);
    }
    return { ok: true, ...payload };
  });
  handle("sessions-list", () => store.listSessions());
  handle("sessions-count", () => store.countSessions());
  handle("sessions-get", (id) => store.getSession(str(id, 80)));
  handle("sessions-remove", (id) => store.deleteSession(str(id, 80)));

  handle("code-repos-list", () => store.codeRepos.list().map(enrichRepo));
  handle("code-repo-pick", async () => {
    const r = await dialog.showOpenDialog(
      win.webContents() ? BrowserWindow.fromWebContents(win.webContents()) : null,
      { properties: ["openDirectory"] }
    );
    if (r.canceled || !r.filePaths?.length) return { ok: false, canceled: true };
    const repoPath = r.filePaths[0];
    const synth = await freshSynth(repoPath, { force: true });
    if (!synth) return { ok: false, error: "Could not read selected folder." };
    const saved = store.codeRepos.upsert(repoPath, path.basename(repoPath), synth.codeIndex.stats);
    return { ok: true, repo: saved ? enrichRepo(saved) : null };
  });
  handle("code-repo-refresh", async (repoDir) => {
    const root = registeredRepoDir(repoDir);
    const synth = root ? await freshSynth(root, { force: true }) : null;
    if (!synth) return { ok: false, error: "Repository folder not found." };
    const saved = store.codeRepos.upsert(synth.repoDir, path.basename(synth.repoDir), synth.codeIndex.stats);
    return { ok: true, repo: saved ? enrichRepo(saved) : null };
  });
  handle("code-repo-remove", (id) => {
    const target = store.codeRepos.list().find((r) => String(r.id) === String(id));
    if (!target) return false;
    codeSynths.delete(path.resolve(target.path));
    store.codeRepos.remove(target.id);
    return true;
  });
  handle("code-analyze", async (repoDir, query, topK = 6) => {
    const root = registeredRepoDir(repoDir);
    const synth = root ? await freshSynth(root) : null;
    if (!synth) return { ok: false, error: "Repository folder not found." };
    const res = synth.analyze(str(query, 1000), { topK: Math.min(Number(topK) || 6, 15) });
    return { ok: true, ...res };
  });
  handle("code-branches", (repoDir) => {
    const abs = registeredRepoDir(repoDir);
    if (!abs || !fs.existsSync(abs)) return { ok: false, branches: [] };
    return {
      ok: true,
      current: gitLocalAdapter.getCurrentBranch({ cwd: abs }),
      branches: gitLocalAdapter.listLocalBranches({ cwd: abs }),
    };
  });
  handle("code-diff", (repoDir, base, head) => {
    const abs = registeredRepoDir(repoDir);
    if (!abs || !fs.existsSync(abs)) return { ok: false, error: "Repository folder not found." };
    return {
      ok: true,
      ...gitLocalAdapter.getLocalDiff(str(base, 120) || "main", str(head, 120) || "HEAD", {
        cwd: abs,
        maxChars: 30000,
      }),
    };
  });
  handle("code-modules", async (repoDir) => {
    const root = registeredRepoDir(repoDir);
    const synth = root ? await freshSynth(root) : null;
    if (!synth) return { ok: false, modules: [] };
    return {
      ok: true,
      stats: synth.codeIndex.stats,
      modules: synth.codeIndex.modules.map((m) => ({
        relPath: m.relPath,
        language: m.language,
        totalLines: m.structure.totalLines,
        classes: m.structure.classes.map((c) => c.name),
        functions: m.structure.functions.map((f) => f.name),
        markdown: m.markdown,
      })),
    };
  });
  handle("code-context", async (repoDir) => {
    try {
      const root = registeredRepoDir(repoDir);
      const synth = root ? await freshSynth(root) : null;
      if (!synth) return { ok: false, error: "Repository folder not found." };
      const compiled = synth.compileContextFile({ maxModules: 500, maxChars: 240000 });
      const repoName = path.basename(synth.repoDir) || "repository";
      const fileName = `${repoName}-context.md`;
      const activeBranch = synth.gitRegistry.activeBranch;
      const summary = `Unified offline Code-to-MD context for ${repoName} (${activeBranch}) covering ${compiled.metrics.includedModules} modules (${compiled.metrics.compressionPct}% compressed).`;
      return {
        ok: true,
        fileName,
        activeBranch,
        summary,
        markdown: compiled.markdown,
        metrics: compiled.metrics,
      };
    } catch (error) {
      logError("Failed to compile single repository context file", error);
      return { ok: false, error: error?.message || "Failed to compile context file." };
    }
  });
  handle("code-context-download", async (repoDir) => {
    try {
      const root = registeredRepoDir(repoDir);
      const synth = root ? await freshSynth(root) : null;
      if (!synth) return { ok: false, error: "Repository folder not found." };
      const compiled = synth.compileContextFile({ maxModules: 500, maxChars: 240000 });
      const repoName = path.basename(synth.repoDir) || "repository";
      const defaultName = `${repoName}-context.md`;
      const targetWin = win.webContents() ? BrowserWindow.fromWebContents(win.webContents()) : null;
      const r = await dialog.showSaveDialog(targetWin, {
        defaultPath: defaultName,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (r.canceled || !r.filePath) return { ok: false, canceled: true };
      fs.writeFileSync(r.filePath, compiled.markdown, "utf8");
      return { ok: true, path: r.filePath };
    } catch (error) {
      logError("Failed to download repository context file", error);
      return { ok: false, error: error?.message || "Could not save file." };
    }
  });
  handle("start-meeting", () => {
    if (typeof onStartMeeting === "function") void onStartMeeting();
  });
  handle("open-settings", (section) => {
    if (typeof onOpenSettings === "function") {
      void onOpenSettings(typeof section === "string" && section ? section : "copilot");
    }
  });
  handle("stop-meeting", () => {
    if (typeof onStopMeeting === "function") onStopMeeting();
  });
  handle("window-is-open", () => win.isOpen());
  handle("window", (action, value) => {
    if (action === "expand") win.expand(!!value);
    else if (action === "mode") win.setMode(String(value));
    else if (action === "opacity") win.setOpacity(value);
    else if (action === "hide") win.hide();
    else if (action === "close") win.close();
    else if (action === "open") win.open({ focus: true, startMode: "full" });
    else if (action === "drag-start") win.startDrag();
    else if (action === "drag-stop") win.stopDrag();
  });

  const probe = startMemProbe({
    dir: logDir ?? dir,
    engine,
    metrics: () =>
      electron.app?.getAppMetrics?.().map((m) => ({
        type: m.type,
        pid: m.pid,
        workingSetMB: Math.round((m.memory?.workingSetSize ?? 0) / 1024),
      })) ?? null,
  });

  // Files that were mid-index when the app closed, or were added before indexing existed. Without a key (or
  // with file search off) they cannot be read now: they are marked failed with the reason, so the page stops
  // showing them as in progress and offers "Read again".
  const resumeIndexing = () => {
    const files = store.rag.unfinished();
    if (files.length) {
      if (ragClients()) {
        for (const f of files) {
          ingestor.ingest(f).catch((error) => {
            ragLog({ event: "resume_ingest_failed", file_id: f.id, error: error?.message });
          });
        }
      } else {
        const error = settings.engine().apiKey
          ? "Project file search is off in the Copilot settings. Turn it on, then read the file again."
          : friendly({ code: "no_key" });
        for (const f of files) store.rag.setFile(f.id, { status: "error", stage: null, error });
      }
    }
    // Background profile backfill for stale files when catalogMode is profile
    if (retriever.catalogMode?.() === "profile" && ragClients()) {
      const ask = (parts, opts) => ragClients()?.analyze?.ask(parts, opts);
      backfillProfiles({
        rag: store.rag,
        ask,
        log: ragLog,
        now,
      }).catch((error) => {
        ragLog({ event: "profile_backfill_failed", error: error?.message });
      });
    }
    return files.length;
  };
  setTimeout(() => {
    try {
      resumeIndexing();
    } catch (error) {
      ragLog({ event: "resume_indexing_failed", error: error.message });
    }
  }, 4000).unref?.();

  return {
    // hooks for the meeting pipeline (same shape as the engine)
    onFinal: (x) => settings.view().enabled && !engine.isPaused() && engine.onFinal(x),
    onPartial: (x) => settings.view().enabled && !engine.isPaused() && engine.onPartial(x),
    begin() {
      if (!settings.view().enabled) return;
      try {
        engine.begin();
      } catch (error) {
        logError("Copilot failed to begin", error);
      }
    },
    onLevel,
    endSession: () => engine.endSession(),
    // for the hotkey / menus
    toggleWindow: () => win.toggle(),
    setHotkeyRegistrar(fn) {
      registrar = fn;
      void bindHotkey(settings.view().hotkey);
    },
    openWindow: (opts) => win.open(opts),
    resumeIndexing, // runs 4 s after launch; exposed for tests
    engine,
    store,
    settings,
    window: win,
    close() {
      probe.stop();
      engine.endSession();
      store.close();
    },
  };
}

module.exports = { createCopilot };
