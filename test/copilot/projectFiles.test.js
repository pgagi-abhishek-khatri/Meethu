const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAnalyzer, computeSummaryBudget } = require("../../src/copilot/rag/analyzeClient");
const { createCopilot } = require("../../src/copilot/main/service");

let canOpen = true;
try {
  const D = require("better-sqlite3");
  new D(":memory:").close();
} catch {
  canOpen = false;
}
const sqlite = {
  skip: canOpen ? false : "better-sqlite3 is not built for this runtime",
};

test("computeSummaryBudget scales target words, tokens, and chars with document length", () => {
  const shortDoc = computeSummaryBudget(1500);
  const mediumDoc = computeSummaryBudget(20000);
  const longDoc = computeSummaryBudget(45000);

  assert.equal(shortDoc.targetWords, 60);
  assert.equal(shortDoc.maxChars, 600);

  assert.ok(mediumDoc.targetWords > shortDoc.targetWords);
  assert.ok(mediumDoc.maxChars > shortDoc.maxChars);

  assert.equal(longDoc.targetWords, 350);
  assert.equal(longDoc.maxChars, 2500);
  assert.equal(longDoc.maxTokens, 900);
});

test("createAnalyzer.summarize uses map-reduce above 24k chars and preserves >500 char summary", async () => {
  const calls = [];
  const longOutput = "Section 1 covers architecture. ".repeat(35).trim(); // ~1085 chars
  const analyzer = createAnalyzer({
    apiKey: "test-key",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      const isReduce = body.messages[0].content[0].text.includes("Below are summaries");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: isReduce ? longOutput : "Part summary content." } }],
          usage: { total_tokens: 100, cost: 0.001 },
        }),
      };
    },
  });

  const paragraph = "Detailed specification paragraph with metrics and milestones.\n\n";
  const longText = paragraph.repeat(500); // ~31,500 chars -> triggers map-reduce (> 24,000)
  const res = await analyzer.summarize({ name: "Spec.pdf", kind: "pdf", text: longText });

  assert.ok(calls.length >= 3, `expected map + reduce calls, got ${calls.length}`);
  assert.ok(res.summary.length > 500, `expected >500 char summary, got ${res.summary.length}`);
});

test("copilot:open-reference resolves file by id or name and invokes onOpenReference", sqlite, async () => {
  const handlers = new Map();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-ref-test-"));
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-ref-src-"));
  const filePath = path.join(srcDir, "Proposal.pdf");
  fs.writeFileSync(filePath, "fake pdf bytes");
  const opened = [];

  const electron = {
    BrowserWindow: class {
      static fromWebContents() {
        return null;
      }
      constructor() {
        this.webContents = { send: () => {}, isDestroyed: () => false };
      }
      setMenuBarVisibility() {}
      once() {}
      on() {}
      isDestroyed() {
        return false;
      }
      isVisible() {
        return false;
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
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: () => {} },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    safeStorage: { isEncryptionAvailable: () => false },
  };

  const copilot = createCopilot({
    dir,
    env: {},
    electron,
    loadRenderer: async () => {},
    setupAlwaysOnTop: () => {},
    onOpenReference: (ref) => opened.push(ref),
    logError: () => {},
  });

  const invoke = (ch, ...args) => handlers.get(ch)(null, ...args);
  try {
    const pid = await invoke("copilot:project-create", "CarZilla");
    await invoke("copilot:project-add-paths", pid, [filePath]);
    const file = (await invoke("copilot:projects-list"))[0].files[0];

    const res = await invoke("copilot:open-reference", {
      name: "Proposal.pdf",
      page: 4,
      snippet: "Basic plan costs $2.99",
    });
    assert.equal(res.ok, true);
    assert.equal(res.fileId, file.id);
    assert.equal(res.projectId, pid);
    assert.equal(res.page, 4);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].page, 4);
    assert.equal(opened[0].snippet, "Basic plan costs $2.99");

    const missing = await invoke("copilot:open-reference", { name: "Missing.pdf" });
    assert.equal(missing.ok, false);
  } finally {
    copilot.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(srcDir, { recursive: true, force: true });
  }
});

test("project files copy locally on add, preview, download, and clean up managed copy on remove", sqlite, async () => {
  const handlers = new Map();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-files-test-"));
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-src-test-"));
  const dstDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-dst-test-"));
  const originalPath = path.join(srcDir, "notes.txt");
  const downloadTarget = path.join(dstDir, "downloaded-notes.txt");
  fs.writeFileSync(originalPath, "Hello CarZilla pricing tiers: Basic $2.99, Pro $9.99.");

  const electron = {
    BrowserWindow: class {
      static fromWebContents() {
        return null;
      }
      constructor() {
        this.webContents = { send: () => {}, isDestroyed: () => false };
      }
      setMenuBarVisibility() {}
      once() {}
      on() {}
      isDestroyed() {
        return false;
      }
      isVisible() {
        return false;
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
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: () => {} },
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: false, filePath: downloadTarget }),
    },
    safeStorage: { isEncryptionAvailable: () => false },
  };

  const copilot = createCopilot({
    dir,
    env: {},
    electron,
    loadRenderer: async () => {},
    setupAlwaysOnTop: () => {},
    logError: () => {},
  });

  const invoke = (ch, ...args) => handlers.get(ch)(null, ...args);
  try {
    const pid = await invoke("copilot:project-create", "CarZilla");
    const added = await invoke("copilot:project-add-paths", pid, [originalPath]);
    assert.equal(added, 1);

    const projects = await invoke("copilot:projects-list");
    const file = projects[0].files[0];
    assert.ok(file.path.startsWith(path.join(dir, "copilot-files", String(pid))));
    assert.ok(fs.existsSync(file.path));

    const preview = await invoke("copilot:project-preview-file", file.id);
    assert.equal(preview.ok, true);
    assert.equal(preview.kind, "text");
    assert.match(preview.text, /CarZilla pricing tiers/);

    const dl = await invoke("copilot:project-download-file", file.id);
    assert.deepEqual(dl, { ok: true, path: downloadTarget });
    assert.equal(
      fs.readFileSync(downloadTarget, "utf8"),
      "Hello CarZilla pricing tiers: Basic $2.99, Pro $9.99."
    );

    await invoke("copilot:project-remove-file", file.id);
    assert.equal(fs.existsSync(file.path), false, "managed copy should be deleted on remove");
    assert.equal(fs.existsSync(originalPath), true, "original file on disk must remain untouched");
  } finally {
    copilot.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.rmSync(dstDir, { recursive: true, force: true });
  }
});
