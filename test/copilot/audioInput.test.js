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
  skip: canOpen ? false : "better-sqlite3 is not built for this runtime",
};

function setupCopilot({ env = {}, transcribeAudio = null } = {}) {
  const handlers = new Map();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-audio-test-"));
  const electron = {
    BrowserWindow: class {
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
    ipcMain: {
      handle: (name, fn) => handlers.set(name, fn),
      on: () => {},
    },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    safeStorage: { isEncryptionAvailable: () => false },
  };
  const copilot = createCopilot({
    dir,
    env,
    electron,
    loadRenderer: async () => {},
    setupAlwaysOnTop: () => {},
    transcribeAudio,
    logError: () => {},
  });
  return {
    copilot,
    invoke: (channel, ...args) => handlers.get(channel)(null, ...args),
    cleanup: () => {
      copilot.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("copilot:transcribe-audio rejects empty and oversized audio buffers", sqlite, async () => {
  const { invoke, cleanup } = setupCopilot();
  try {
    const empty = await invoke("copilot:transcribe-audio", new ArrayBuffer(0), "audio/webm");
    assert.deepEqual(empty, { ok: false, error: "No audio was recorded." });

    const invalid = await invoke("copilot:transcribe-audio", null, "audio/webm");
    assert.deepEqual(invalid, { ok: false, error: "No audio was recorded." });

    const tooBig = await invoke(
      "copilot:transcribe-audio",
      new Uint8Array(25 * 1024 * 1024 + 1),
      "audio/webm"
    );
    assert.deepEqual(tooBig, { ok: false, error: "Audio recording is too large (max 25 MB)." });
  } finally {
    cleanup();
  }
});

test("copilot:transcribe-audio uses host transcribeAudio callback when available", sqlite, async () => {
  let receivedMime = null;
  let receivedSize = 0;
  const { invoke, cleanup } = setupCopilot({
    transcribeAudio: async (buf, mime) => {
      receivedMime = mime;
      receivedSize = buf.length;
      return { ok: true, text: "  What are the action items?  " };
    },
  });
  try {
    const payload = Uint8Array.from([1, 2, 3, 4]).buffer;
    const res = await invoke("copilot:transcribe-audio", payload, "audio/webm;codecs=opus");
    assert.equal(receivedMime, "audio/webm;codecs=opus");
    assert.equal(receivedSize, 4);
    assert.deepEqual(res, { ok: true, text: "What are the action items?" });
  } finally {
    cleanup();
  }
});

test("copilot:transcribe-audio returns clear error when no host STT and no OpenRouter key", sqlite, async () => {
  const { invoke, cleanup } = setupCopilot({
    env: {},
    transcribeAudio: async () => ({ ok: false }),
  });
  try {
    const payload = Uint8Array.from([1, 2, 3, 4]).buffer;
    const res = await invoke("copilot:transcribe-audio", payload, "audio/webm");
    assert.equal(res.ok, false);
    assert.match(res.error, /OpenRouter key/i);
  } finally {
    cleanup();
  }
});
