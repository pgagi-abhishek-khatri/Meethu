// Wires the copilot together inside the app: engine (decisions + cards), storage, settings, the window
// and the IPC the window uses. The app calls only the hooks returned here (see src/copilot/main/index.js).
const crypto = require("crypto");
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
const { createIngestor } = require("../rag/ingest");
const { createRetriever } = require("../rag/retrieve");
const { createRagLog } = require("../rag/ragLog");
const { createBehavior } = require("./behavior");
const { createOpenRouterLlm, DEFAULT_SUMMARY_MODEL } = require("../core/summary/rollingSummary");

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

function createCopilot({
  dir, // userData
  logDir = null,
  env = process.env,
  electron, // { app, BrowserWindow, screen, ipcMain, dialog, safeStorage }
  loadRenderer,
  setupAlwaysOnTop,
  getActiveEvents = () => [], // calendar events happening now (the app's database), to pick the project
  ffmpegPath = null, // bundled ffmpeg, for audio/video project files
  engineOptions = {}, // tests
  Database,
}) {
  const { BrowserWindow, screen, ipcMain, dialog, safeStorage } = electron;
  const settings = createSettings({ dir, safeStorage, env });
  const store = openStore({
    dbPath: path.join(dir, "copilot.db"),
    ...(Database ? { Database } : {}),
  });
  store.closeOpenSessions();
  store.prune(settings.view().retentionDays);

  const win = createCopilotWindow({
    BrowserWindow,
    screen,
    loadRenderer,
    setupAlwaysOnTop,
    getWindowState: () => settings.view().window,
    saveWindowState: (window) => settings.update({ window }),
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
    if (!pcm16 || pcm16.length < 2 || !win.isOpen()) return;
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
      if (s.enabled && s.hasKey && s.autoOpen) win.open({ focus: false, startMode: s.idleMode });
    },
    send(e) {
      const started = e.type === "session" && e.state === "start";
      if (started) history = [];
      try {
        persist(e);
      } catch {}
      if (started) e = { ...e, sessionId };
      if (e.type === "stats") lastStats = e;
      if (!NOT_REPLAYED.has(e.type)) {
        history.push(e);
        if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
      }
      push(e);
      if (started) announceMeeting();
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
  const ingestor = createIngestor({
    rag: store.rag,
    clients: ragClients,
    media: createMedia({ ffmpegPath }),
    log: ragLog,
    getCfg: () => ({ mediaEmbedMinutes: settings.engine().mediaEmbedMinutes }),
  });
  const retriever = createRetriever({ rag: store.rag, clients: ragClients, log: ragLog });
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
      prefetch: (query) => retriever.prefetch(query, projectIds()),
      retrieve: (o) => retriever.retrieve({ ...o, projectIds: projectIds() }),
    },
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
    })
  );
  handle("cancel", (id) => engine.cancel(str(id, 40)));
  handle("rerun", (id) => engine.rerun(str(id, 40)));
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
  handle("settings-update", async (patch) => {
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
    return view;
  });
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
  handle("project-remove", (id) => store.projects.remove(Number(id)));
  handle("project-active", (id, active) => store.projects.setActive(Number(id), !!active));
  handle("project-remove-file", (id) => store.projects.removeFile(Number(id)));
  handle("project-add-files", async (id) => {
    const r = await dialog.showOpenDialog(
      win.webContents() ? BrowserWindow.fromWebContents(win.webContents()) : null,
      {
        properties: ["openFile", "multiSelections"],
      }
    );
    if (r.canceled) return 0;
    for (const p of r.filePaths) {
      const f = store.projects.addFileRow(Number(id), p, path.basename(p));
      ingestor.ingest(f).catch(() => {}); // reads, splits, embeds and summarises in the background; the page shows its progress
    }
    return r.filePaths.length;
  });
  // Try a failed (or changed) file again.
  handle("project-reindex", (fileId) => {
    const f = store.rag.file(Number(fileId));
    if (!f) return false;
    ingestor.ingest(f).catch(() => {});
    return true;
  });
  handle("sessions-list", () => store.listSessions());
  handle("sessions-get", (id) => store.getSession(str(id, 80)));
  handle("sessions-remove", (id) => store.deleteSession(str(id, 80)));
  handle("window", (action, value) => {
    if (action === "expand") win.expand(!!value);
    else if (action === "mode") win.setMode(String(value));
    else if (action === "opacity") win.setOpacity(value);
    else if (action === "hide") win.hide();
    else if (action === "close") win.close();
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

  // Files that were mid-index when the app closed, or were added before indexing existed.
  setTimeout(() => {
    try {
      if (ragClients()) for (const f of store.rag.unfinished()) ingestor.ingest(f).catch(() => {});
    } catch {}
  }, 4000).unref?.();

  return {
    // hooks for the meeting pipeline (same shape as the engine)
    onFinal: (x) => settings.view().enabled && engine.onFinal(x),
    onPartial: (x) => settings.view().enabled && engine.onPartial(x),
    begin: () => settings.view().enabled && engine.begin(),
    onLevel,
    endSession: () => engine.endSession(),
    // for the hotkey / menus
    toggleWindow: () => win.toggle(),
    setHotkeyRegistrar(fn) {
      registrar = fn;
      void bindHotkey(settings.view().hotkey);
    },
    openWindow: (opts) => win.open(opts),
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
