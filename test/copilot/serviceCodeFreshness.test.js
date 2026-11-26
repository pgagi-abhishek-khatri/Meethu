// Phase 1.6: the repo index follows the repo; nobody has to press Refresh.
// ELECTRON_RUN_AS_NODE=1 npx electron --test test/copilot/serviceCodeFreshness.test.js
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

function setup(pickedDir) {
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
  createCopilot({
    dir: fs.mkdtempSync(path.join(os.tmpdir(), "copilot-fresh-")),
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
const names = (res) => JSON.stringify(res);

test("edits, new files and deletes show up without a manual refresh", sqlite, async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "fresh-repo-"));
  fs.writeFileSync(
    path.join(repo, "billing.js"),
    "export function chargeCustomer() { return 1 }\n"
  );
  git(repo, "init", "-q");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  const invoke = setup(repo);
  assert.equal((await invoke("code-repo-pick")).ok, true);

  assert.match(names(await invoke("code-modules", repo)), /chargeCustomer/);

  fs.writeFileSync(
    path.join(repo, "billing.js"),
    "export function refundCustomer() { return 2 }\n"
  );
  const afterEdit = names(await invoke("code-modules", repo));
  assert.match(afterEdit, /refundCustomer/);
  assert.doesNotMatch(afterEdit, /chargeCustomer/);

  fs.writeFileSync(path.join(repo, "shipping.js"), "export function shipOrder() { return 3 }\n");
  assert.match(names(await invoke("code-modules", repo)), /shipOrder/);

  fs.rmSync(path.join(repo, "shipping.js"));
  assert.doesNotMatch(names(await invoke("code-modules", repo)), /shipOrder/);
});

test("an unchanged repo is not rebuilt on every question", sqlite, async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "fresh-repo-"));
  fs.writeFileSync(path.join(repo, "a.js"), "export function alpha() {}\n");
  git(repo, "init", "-q");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  const invoke = setup(repo);
  await invoke("code-repo-pick");
  await invoke("code-modules", repo); // may rebuild once to record its fingerprint
  const t = Date.now();
  for (let i = 0; i < 5; i++) await invoke("code-modules", repo);
  assert.ok(Date.now() - t < 1500, `5 warm calls took ${Date.now() - t}ms`);
});
