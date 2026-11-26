// Phase 3.2: renderer-supplied paths and refs are untrusted at the IPC boundary.
// Needs Electron's better-sqlite3: ELECTRON_RUN_AS_NODE=1 npx electron --test test/copilot/serviceIpcSecurity.test.js
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

function setup({ pickedDir } = {}) {
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
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [pickedDir] }) },
    safeStorage: null,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-sec-"));
  const copilot = createCopilot({
    dir,
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
  const invoke = (name, ...args) => handlers.get(`copilot:${name}`)({}, ...args);
  return { copilot, invoke, dir };
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sec-repo-"));
  fs.writeFileSync(path.join(repo, "a.js"), "export function hello() { return 1 }\n");
  const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return repo;
}

test("code-* handlers refuse a directory that was never registered", sqlite, async () => {
  const { invoke } = setup();
  const stranger = makeRepo();
  assert.equal((await invoke("code-analyze", stranger, "hello")).ok, false);
  assert.equal((await invoke("code-modules", stranger)).ok, false);
  assert.equal((await invoke("code-context", stranger)).ok, false);
  assert.equal((await invoke("code-branches", stranger)).ok, false);
  assert.equal((await invoke("code-diff", stranger, "HEAD", "HEAD")).ok, false);
  assert.equal((await invoke("code-repo-refresh", stranger)).ok, false);
  assert.equal((await invoke("code-analyze", "/etc", "passwd")).ok, false);
});

test(
  "a repo added through the picker is usable; code-diff rejects option-like refs",
  sqlite,
  async () => {
    const repo = makeRepo();
    const { invoke } = setup({ pickedDir: repo });
    assert.equal((await invoke("code-repo-pick")).ok, true);
    assert.equal((await invoke("code-modules", repo)).ok, true);
    const out = path.join(os.tmpdir(), `pwned-${Date.now()}`);
    const bad = await invoke("code-diff", repo, `--output=${out}`, "HEAD");
    assert.equal(fs.existsSync(out), false, "git must not write the file");
    assert.ok(bad.error, "must report an error");
  }
);

test("removing a repo makes it unusable again", sqlite, async () => {
  const repo = makeRepo();
  const { invoke } = setup({ pickedDir: repo });
  const { repo: saved } = await invoke("code-repo-pick");
  assert.equal(await invoke("code-repo-remove", saved.id), true);
  assert.equal((await invoke("code-modules", repo)).ok, false);
  assert.equal(await invoke("code-repo-remove", 99999), false);
});

test("project-add-paths skips secret files and symlinks to them", sqlite, async () => {
  const { invoke } = setup();
  const pid = await invoke("project-create", "Acme");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-drop-"));
  const good = path.join(dir, "spec.md");
  const env = path.join(dir, ".env");
  const key = path.join(dir, "id_rsa");
  const link = path.join(dir, "notes.txt");
  fs.writeFileSync(good, "# spec");
  fs.writeFileSync(env, "TOKEN=1");
  fs.writeFileSync(key, "KEY");
  fs.symlinkSync(key, link);
  const added = await invoke("project-add-paths", pid, [
    good,
    env,
    key,
    link,
    "relative.txt",
    "/etc/shadow",
  ]);
  assert.equal(added, 1);
});
