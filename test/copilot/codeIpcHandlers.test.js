// Phase 6.3: what the code-* handlers return for a registered repository (permissions are in serviceIpcSecurity).
// ELECTRON_RUN_AS_NODE=1 npx electron --test test/copilot/codeIpcHandlers.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createCopilot } = require("../../src/copilot/main/service");

let canOpen = true;
try {
  const D = require("better-sqlite3");
  new D(":memory:").close();
} catch {
  canOpen = false;
}
const sqlite = { skip: canOpen ? false : "better-sqlite3 is not built for this runtime" };

function setup({ picked, savePath }) {
  const handlers = new Map();
  const electron = {
    BrowserWindow: class {
      static fromWebContents() {
        return null;
      }
      constructor() {
        this.webContents = { send() {}, isDestroyed: () => false, on() {} };
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
      hide() {}
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
    ipcMain: { handle: (n, fn) => handlers.set(n, fn), on() {} },
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: [picked] }),
      showSaveDialog: async () => ({ canceled: !savePath, filePath: savePath }),
    },
    safeStorage: null,
  };
  createCopilot({
    dir: fs.mkdtempSync(path.join(os.tmpdir(), "copilot-ipc-")),
    env: { OPENROUTER_API_KEY: "k", COPILOT_QUERY_WRITER: "0" },
    electron,
    loadRenderer: () => Promise.resolve(),
    setupAlwaysOnTop: () => {},
    getActiveEvents: () => [],
    engineOptions: {
      mainModel: () => new Promise(() => {}),
      client: { systemOne: async () => ({ answers: {}, inputTokens: 1 }) },
      llm: async () => ({ text: "s" }),
    },
  });
  return (name, ...a) => handlers.get(`copilot:${name}`)({}, ...a);
}

const git = (cwd, ...a) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], {
    cwd,
    stdio: "ignore",
  });
function repo() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "ipc-repo-"));
  fs.mkdirSync(path.join(r, "src"));
  fs.writeFileSync(path.join(r, "src/pay.js"), "export function chargeCard(id) { return id }\n");
  git(r, "init", "-q", "-b", "main");
  git(r, "add", ".");
  git(r, "commit", "-qm", "init");
  git(r, "checkout", "-qb", "feature");
  fs.writeFileSync(
    path.join(r, "src/pay.js"),
    "export function chargeCard(id) { return id }\nexport function refund(id) { return -id }\n"
  );
  git(r, "commit", "-qam", "add refund");
  git(r, "checkout", "-q", "main");
  return r;
}

test("the list shows a picked repo with its stats and branch", sqlite, async () => {
  const r = repo();
  const invoke = setup({ picked: r });
  assert.deepEqual(await invoke("code-repos-list"), []);
  const picked = await invoke("code-repo-pick");
  assert.equal(picked.ok, true);
  const list = await invoke("code-repos-list");
  assert.equal(list.length, 1);
  assert.equal(list[0].name, path.basename(r));
  assert.equal(list[0].stats.codeModules, 1);
  assert.equal(list[0].activeBranch, "main");
});

test("picking the same folder twice does not duplicate it", sqlite, async () => {
  const r = repo();
  const invoke = setup({ picked: r });
  await invoke("code-repo-pick");
  await invoke("code-repo-pick");
  assert.equal((await invoke("code-repos-list")).length, 1);
});

test("code-analyze answers a symbol question and clamps topK", sqlite, async () => {
  const r = repo();
  const invoke = setup({ picked: r });
  await invoke("code-repo-pick");
  const res = await invoke("code-analyze", r, "where is the definition of chargeCard", 9999);
  assert.equal(res.ok, true);
  assert.ok(res.evidence.codeHits.length <= 15, "topK is capped");
  assert.ok(res.evidence.codeHits.some((h) => h.relPath === "src/pay.js"));
});

test("code-branches lists branches and the current one", sqlite, async () => {
  const r = repo();
  const invoke = setup({ picked: r });
  await invoke("code-repo-pick");
  const res = await invoke("code-branches", r);
  assert.equal(res.current, "main");
  assert.deepEqual(res.branches.map((b) => b.name).sort(), ["feature", "main"]);
});

test(
  "code-diff between real refs returns the change; a bad ref returns an error",
  sqlite,
  async () => {
    const r = repo();
    const invoke = setup({ picked: r });
    await invoke("code-repo-pick");
    const ok = await invoke("code-diff", r, "main", "feature");
    assert.equal(ok.ok, true);
    assert.match(ok.diff, /refund/);
    const bad = await invoke("code-diff", r, "no-such-branch", "feature");
    assert.ok(bad.error || bad.diff === "");
  }
);

test(
  "code-context returns a markdown file and code-context-download writes it",
  sqlite,
  async () => {
    const r = repo();
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ipc-out-")), "ctx.md");
    const invoke = setup({ picked: r, savePath: out });
    await invoke("code-repo-pick");
    const ctx = await invoke("code-context", r);
    assert.equal(ctx.ok, true);
    assert.match(ctx.fileName, /-context\.md$/);
    assert.match(ctx.markdown, /pay\.js/);
    const saved = await invoke("code-context-download", r);
    assert.equal(saved.ok, true);
    assert.match(fs.readFileSync(out, "utf8"), /pay\.js/);
  }
);

test("cancelling the save dialog writes nothing", sqlite, async () => {
  const r = repo();
  const invoke = setup({ picked: r, savePath: null });
  await invoke("code-repo-pick");
  const res = await invoke("code-context-download", r);
  assert.equal(res.ok, false);
  assert.equal(res.canceled, true);
});
