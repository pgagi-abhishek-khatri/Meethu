const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSettings, isOpenRouterKey } = require("../../src/copilot/main/settings");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "copilot-settings-"));
const ENV = { OPENROUTER_API_KEY: "sk-or-v1-from-env" };

test("only OpenRouter keys count as OpenRouter keys", () => {
  assert.equal(isOpenRouterKey("sk-or-v1-abc"), true);
  assert.equal(isOpenRouterKey("  sk-or-v1-abc "), true);
  assert.equal(isOpenRouterKey("snx_pr_abc"), false); // a Soniox key
  assert.equal(isOpenRouterKey("sk-proj-abc"), false); // an OpenAI key
  assert.equal(isOpenRouterKey(""), false);
});

test("a Soniox key pasted as the OpenRouter key is refused and the .env key keeps working", () => {
  const s = createSettings({ dir: tmp(), env: ENV });
  const view = s.update({ apiKey: "snx_pr_soniox_key" });
  assert.match(view.keyError, /not an OpenRouter key/);
  assert.equal(view.keyFromEnv, true);
  assert.equal(s.engine().apiKey, "sk-or-v1-from-env");
  // The next update clears the message.
  assert.equal(s.update({ quiet: "chatty" }).keyError, "");
});

test("a non-OpenRouter key saved before is ignored: the .env key is used and the page is told", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "copilot-key.bin"), "snx_pr_saved_earlier"); // no keyring: plain text
  const s = createSettings({ dir, env: ENV });
  assert.equal(s.engine().apiKey, "sk-or-v1-from-env", "never sends the Soniox key to OpenRouter");
  const view = s.view();
  assert.equal(view.hasKey, true);
  assert.equal(view.keyFromEnv, true);
  assert.match(view.keyWarning, /not an OpenRouter key/);
  // "Remove saved key" clears it.
  const after = s.update({ apiKey: "" });
  assert.equal(after.keyWarning, "");
  assert.equal(fs.existsSync(path.join(dir, "copilot-key.bin")), false);
});

test("a real OpenRouter key is saved and wins over the .env one", () => {
  const s = createSettings({ dir: tmp(), env: ENV });
  const view = s.update({ apiKey: "sk-or-v1-saved" });
  assert.equal(view.keyError, "");
  assert.equal(view.keyFromEnv, false);
  assert.equal(s.engine().apiKey, "sk-or-v1-saved");
  assert.equal(
    JSON.stringify(view).includes("sk-or-v1-saved"),
    false,
    "the key never reaches the window"
  );
});

test("opacity defaults to 50% and clamps within limits", () => {
  const s = createSettings({ dir: tmp(), env: ENV });
  assert.equal(s.view().opacity, 0.5, "default opacity is 50%");
  assert.equal(s.view().fadeWhenIdle, false, "default fadeWhenIdle is false");

  assert.equal(s.update({ opacity: 0.8 }).opacity, 0.8);
  assert.equal(s.update({ opacity: 0.1 }).opacity, 0.3, "clamped to minimum 0.3");
  assert.equal(s.update({ opacity: 1.5 }).opacity, 1.0, "clamped to maximum 1.0");
  assert.equal(s.update({ opacity: "invalid" }).opacity, 0.5, "falls back to default 0.5");
});

test("the page is told where the saved key lives, so a plain-text fallback can be flagged", () => {
  const key = "sk-or-v1-abc";
  const plain = createSettings({ dir: tmp(), env: {} });
  assert.equal(plain.view().keyStorage, "none");
  assert.equal(plain.update({ apiKey: key }).keyStorage, "plaintext");

  const store = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`enc:${s}`),
    decryptString: (b) => b.toString().replace(/^enc:/, ""),
  };
  const keychain = createSettings({ dir: tmp(), env: {}, safeStorage: store });
  assert.equal(keychain.update({ apiKey: key }).keyStorage, "keychain");
  assert.equal(keychain.engine().apiKey, key);
});

test("the plain-text key file is private to the user", { skip: process.platform === "win32" }, () => {
  const dir = tmp();
  createSettings({ dir, env: {} }).update({ apiKey: "sk-or-v1-abc" });
  assert.equal(fs.statSync(path.join(dir, "copilot-key.bin")).mode & 0o077, 0);
});
