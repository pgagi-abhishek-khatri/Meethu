const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCopilot } = require("../../src/copilot/main/service");

let canOpen = true;
try {
  const D = require("better-sqlite3");
  new D(":memory:").close();
} catch {
  canOpen = false;
}
const sqlite = {
  skip: canOpen ? false : "better-sqlite3 is not built for this runtime (see store.test.js)",
};

function fakeMain() {
  const calls = [];
  const fn = ({ messages, signal, onDelta }) =>
    new Promise((resolve, reject) => {
      const call = { messages };
      calls.push(call);
      signal.addEventListener("abort", () => reject(new Error("aborted")));
      call.finish = (text = "TITLE: Answer\nIt is 4%.\nCONFIDENCE: high") => {
        onDelta(text);
        resolve({
          text,
          sources: [{ url: "https://a.b", title: "A" }],
          usage: null,
          firstTokenMs: 5,
          totalMs: 9,
        });
      };
    });
  fn.calls = calls;
  return fn;
}

function setup({ events = [], env = { OPENROUTER_API_KEY: "k", COPILOT_QUERY_WRITER: "0" } } = {}) {
  const handlers = new Map();
  const listeners = new Map();
  const sent = [];
  const windowCalls = [];
  const electron = {
    BrowserWindow: class {
      static fromWebContents() {
        return null;
      }
      constructor() {
        windowCalls.push("create");
        this.webContents = { send: (c, p) => sent.push([c, p]), isDestroyed: () => false };
      }
      setMenuBarVisibility() {}
      once() {}
      on() {}
      isDestroyed() {
        return false;
      }
      isVisible() {
        return true;
      }
      showInactive() {}
      show() {}
      hide() {
        windowCalls.push("hide");
      }
      getBounds() {
        return { x: 0, y: 0, width: 400, height: 600 };
      }
      isMinimized() {
        return false;
      }
    },
    screen: {
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    },
    ipcMain: { handle: (n, fn) => handlers.set(n, fn), on: (n, fn) => listeners.set(n, fn) },
    dialog: {},
    safeStorage: null,
  };
  const main = fakeMain();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-svc-"));
  const copilot = createCopilot({
    dir,
    env, // the query writer is off: no real query-model call from a test
    electron,
    loadRenderer: () => Promise.resolve(),
    setupAlwaysOnTop: () => {},
    getActiveEvents: () => events,
    engineOptions: {
      mainModel: main,
      client: { systemOne: async () => ({ answers: {}, inputTokens: 1 }) },
      llm: async () => ({ text: "s" }),
    },
  });
  const invoke = (name, ...args) => handlers.get(`copilot:${name}`)({}, ...args);
  return { copilot, invoke, listeners, sent, main, windowCalls };
}
const tick = () => new Promise((r) => setImmediate(r));

test(
  "a meeting is saved as it happens, the window gets the events, and a reload replays them",
  sqlite,
  async () => {
    const { copilot, invoke, listeners, sent, main, windowCalls } = setup();
    copilot.begin();
    assert.deepEqual(windowCalls, ["create"], "the window opens when the meeting starts");
    copilot.onFinal({
      text: "What does ARR stand for in this context?",
      source: "system",
      timestamp: Date.now(),
    });
    const id = await invoke("ask", { text: "what is ARR", web: false, threadId: "main" });
    assert.ok(id);
    main.calls.at(-1).finish();
    await tick();
    const events = sent.filter(([c]) => c === "copilot:event").map(([, e]) => e);
    assert.ok(events.some((e) => e.type === "card_done" && e.threadId === "main"));
    const sid = (await invoke("sessions-list"))[0].id; // the start event predates the window; a reload replays it
    assert.ok(sid);

    const saved = await invoke("sessions-get", sid);
    assert.equal(saved.segments.length, 1);
    assert.equal(saved.cards.find((c) => c.status === "done").title, "Answer");

    sent.length = 0;
    listeners.get("copilot:ready")();
    const replay = sent.map(([, e]) => e.type);
    assert.equal(replay[0], "session");
    assert.ok(replay.includes("segment") && replay.includes("card_done"));
    assert.ok(!replay.includes("partial"));

    copilot.endSession();
    assert.ok((await invoke("sessions-list"))[0].summary !== undefined);
  }
);

test("settings go through IPC, the key is never returned, and projects work", sqlite, async () => {
  const { invoke } = setup();
  const view = await invoke("settings-update", { quiet: "chatty", apiKey: "secret-123" });
  assert.equal(view.quiet, "chatty");
  assert.equal(JSON.stringify(view).includes("secret-123"), false);
  const pid = await invoke("project-create", "Acme");
  await invoke("project-active", pid, true);
  assert.equal((await invoke("projects-list"))[0].active, true);
  assert.equal(await invoke("ask", { text: "" }), false);
});

test("typed asks with a custom thread, cancel and close", sqlite, async () => {
  const { invoke, main, copilot } = setup();
  const t = await invoke("thread-create", "Pricing");
  const j = await invoke("ask", { text: "price?", threadId: t });
  await invoke("cancel", j);
  await invoke("thread-close", t);
  main.calls.at(-1).finish?.();
  await tick();
  assert.equal(copilot.store.listSessions().length, 1);
});

test(
  "the project comes from the calendar event, after the window learned the meeting started",
  sqlite,
  async () => {
    const event = {
      summary: "Acme weekly sync",
      start_time: new Date(Date.now() - 600000).toISOString(),
      end_time: new Date(Date.now() + 1800000).toISOString(),
      hangout_link: "https://meet.google.com/abc-defg-hij",
    };
    const { copilot, invoke, sent, listeners } = setup({ events: [event] });
    const pid = await invoke("project-create", "Acme");
    await invoke("project-update", pid, {
      instructions: "Be brief",
      plan: "Pricing is 10 per seat",
    });
    await invoke("project-rule-add", pid, "title", "weekly sync");
    copilot.begin();
    sent.length = 0;
    listeners.get("copilot:ready")(); // the window loads after the meeting started and replays it
    const types = sent.filter(([c]) => c === "copilot:event").map(([, e]) => e);
    const start = types.findIndex((e) => e.type === "session" && e.state === "start");
    const project = types.findIndex((e) => e.type === "project");
    assert.ok(start >= 0 && project > start, "the project is announced after the session start");
    assert.equal(types[project].projectId, pid);
    assert.equal(types[project].name, "Acme");
    assert.equal(types.find((e) => e.type === "meeting").title, "Acme weekly sync");
    const sid = (await invoke("sessions-list"))[0];
    assert.equal(sid.project_id, pid);
    assert.equal(sid.title, "Acme weekly sync");
    const view = (await invoke("projects-list"))[0];
    assert.equal(view.instructions, "Be brief");
    assert.deepEqual(
      view.rules.map((r) => r.pattern),
      ["weekly sync"]
    );
  }
);

test("picking a project by hand is remembered as a calendar rule", sqlite, async () => {
  const event = {
    summary: "Board call",
    start_time: new Date(Date.now() - 60000).toISOString(),
    end_time: new Date(Date.now() + 60000).toISOString(),
  };
  const { copilot, invoke } = setup({ events: [event] });
  const pid = await invoke("project-create", "Board");
  copilot.begin();
  assert.equal((await invoke("session-project-get")).projectId, null);
  const v = await invoke("session-project", pid, true);
  assert.equal(v.projectId, pid);
  assert.deepEqual(
    (await invoke("projects-list"))[0].rules.map((r) => r.pattern),
    ["Board call"]
  );
  assert.equal((await invoke("session-project", null, false)).projectId, null);
});

test("window mode requests reach the window", sqlite, async () => {
  const { copilot, invoke } = setup();
  copilot.begin();
  await invoke("window", "mode", "orb"); // the fake window has no bounds API: it must not throw
});

test("two hotkeys pressed quickly: the last one is both saved and registered", sqlite, async () => {
  const { copilot, invoke } = setup();
  const registered = [];
  copilot.setHotkeyRegistrar(async (key) => {
    // the first key's registration answers last
    await new Promise((r) => setTimeout(r, key === "CommandOrControl+Shift+K" ? 40 : 1));
    registered.push(key);
    return { success: true };
  });
  await new Promise((r) => setTimeout(r, 10));
  registered.length = 0;
  const [a, b] = await Promise.all([
    invoke("settings-update", { hotkey: "CommandOrControl+Shift+K" }),
    invoke("settings-update", { hotkey: "CommandOrControl+Shift+J" }),
  ]);
  assert.equal(a.hotkey, "CommandOrControl+Shift+K");
  assert.equal(b.hotkey, "CommandOrControl+Shift+J");
  assert.deepEqual(registered, ["CommandOrControl+Shift+K", "CommandOrControl+Shift+J"]);
  assert.equal((await invoke("settings-get")).hotkey, "CommandOrControl+Shift+J");
});

test(
  "files cut off mid-index are marked failed with the reason when they cannot be read now",
  sqlite,
  async () => {
    const { copilot, invoke } = setup({ env: { COPILOT_QUERY_WRITER: "0" } }); // no key
    const pid = await invoke("project-create", "Acme");
    const f = copilot.store.projects.addFileRow(pid, "C:/x/brief.pdf", "brief.pdf");
    copilot.store.rag.setFile(f.id, { status: "embedding", stage: "Embedding 40 pieces" });
    assert.equal(copilot.resumeIndexing(), 1);
    const row = (await invoke("projects-list"))[0].files[0];
    assert.equal(row.status, "error");
    assert.match(row.error, /OpenRouter key/);
    assert.equal(copilot.resumeIndexing(), 0, "nothing is left in progress");
  }
);

test("with a key but file search off, the reason says so", sqlite, async () => {
  const { copilot, invoke } = setup();
  await invoke("settings-update", { ragEnabled: false });
  const pid = await invoke("project-create", "Acme");
  const f = copilot.store.projects.addFileRow(pid, "C:/x/a.md", "a.md");
  copilot.store.rag.setFile(f.id, { status: "reading" });
  copilot.resumeIndexing();
  assert.match((await invoke("projects-list"))[0].files[0].error, /search is off/);
});

test("the meeting count is the real total, past the list's 50", sqlite, async () => {
  const { copilot, invoke } = setup();
  for (let i = 0; i < 55; i++) copilot.store.startSession(`s${i}`, `Meeting ${i}`);
  assert.equal((await invoke("sessions-list")).length, 50);
  assert.equal(await invoke("sessions-count"), 55);
});

test(
  "with no OpenRouter key the window still opens and says the key is missing",
  sqlite,
  async () => {
    const { copilot, sent, listeners, windowCalls } = setup({
      env: { COPILOT_QUERY_WRITER: "0" },
    });
    copilot.begin();
    assert.deepEqual(windowCalls, ["create"], "the meeting is not silently ignored");
    const problems = () =>
      sent.filter(([c, e]) => c === "copilot:event" && e.type === "problem").map(([, e]) => e.kind);
    // The transcript still reaches the window and the saved meeting.
    copilot.onFinal({
      text: "Hello there, can you hear me?",
      source: "system",
      timestamp: Date.now(),
    });
    await tick();

    // The window loads after the start event; its ready replay carries the warning and the transcript.
    sent.length = 0;
    listeners.get("copilot:ready")();
    assert.deepEqual(problems(), ["no_key"]);
    assert.ok(sent.some(([, e]) => e?.type === "segment"));
    copilot.endSession();
  }
);

test("a failing begin is logged, never thrown into the meeting pipeline", sqlite, () => {
  const { copilot } = setup();
  copilot.engine.begin = () => {
    throw new Error("boom");
  };
  assert.doesNotThrow(() => copilot.begin());
});
