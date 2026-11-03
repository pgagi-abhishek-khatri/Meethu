const test = require("node:test");
const assert = require("node:assert/strict");
const { hotkeyKeyAction } = require("../../src/components/copilot/copilotFormat.ts");
const { validateHotkey } = require("../../src/utils/hotkeyValidator.ts");

const press = (key, mods = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});
const act = (key, mods, platform = "win32") =>
  hotkeyKeyAction(press(key, mods), (h) => validateHotkey(h, platform));

test("hotkey field: Tab and Shift+Tab move focus, never become the hotkey", () => {
  assert.deepEqual(act("Tab"), { kind: "pass" });
  assert.deepEqual(act("Tab", { shiftKey: true }), { kind: "pass" });
});

test("hotkey field: the system's own shortcuts are refused", () => {
  for (const [key, mods] of [
    ["c", { ctrlKey: true }],
    ["v", { ctrlKey: true }],
    ["a", { ctrlKey: true }],
    ["z", { ctrlKey: true }],
    ["F4", { altKey: true }],
  ]) {
    const r = act(key, mods);
    assert.equal(r.kind, "reject", `${key} ${JSON.stringify(mods)}`);
  }
  assert.equal(act("c", { metaKey: true }, "darwin").kind, "reject");
});

test("hotkey field: a free combination is set, Backspace clears, a lone key or modifier waits", () => {
  assert.deepEqual(act("k", { ctrlKey: true, shiftKey: true }), {
    kind: "set",
    hotkey: "CommandOrControl+Shift+K",
  });
  assert.deepEqual(act("Backspace"), { kind: "clear" });
  assert.deepEqual(act("Delete"), { kind: "clear" });
  assert.deepEqual(act("Shift", { shiftKey: true }), { kind: "ignore" });
  assert.deepEqual(act("k"), { kind: "ignore" });
});

const { createSettingsSync } = require("../../src/components/copilot/copilotSettingsSync.ts");

function deferredApi(initial) {
  const pending = [];
  const later = (value) =>
    new Promise((resolve, reject) => pending.push({ resolve: () => resolve(value), reject }));
  return {
    pending,
    api: {
      getSettings: () => later({ ...initial }),
      updateSettings: (patch) => later({ ...initial, ...patch }),
    },
  };
}

test("settings sync: only the newest update's answer is published, whatever order they come back in", async () => {
  const { pending, api } = deferredApi({ hotkey: "", quiet: "normal" });
  const sync = createSettingsSync(() => api);
  const seen = [];
  sync.subscribe((s) => seen.push(s?.hotkey));
  const loaded = sync.load();
  pending.shift().resolve();
  await loaded;
  const a = sync.update({ hotkey: "A" });
  const b = sync.update({ hotkey: "B" });
  assert.equal(sync.get().hotkey, "B", "optimistic");
  const [pa, pb] = pending.splice(0);
  pb.resolve();
  await b;
  pa.resolve(); // the older answer arrives last
  await a;
  assert.equal(sync.get().hotkey, "B");
  assert.deepEqual(seen, ["", "A", "B", "B"]);
});

test("settings sync: a load that started before an update never undoes it", async () => {
  const { pending, api } = deferredApi({ hotkey: "old" });
  const sync = createSettingsSync(() => api);
  const first = sync.load();
  pending.shift().resolve();
  await first;
  const stale = sync.load(); // a second component mounts
  const upd = sync.update({ hotkey: "new" });
  const [load, update] = pending.splice(0);
  update.resolve();
  await upd;
  load.resolve(); // carries "old"
  await stale;
  assert.equal(sync.get().hotkey, "new");
});

test("settings sync: a failed update reloads what main really holds; the key is never shown", async () => {
  const { pending, api } = deferredApi({ hotkey: "kept" });
  const sync = createSettingsSync(() => api);
  const l = sync.load();
  pending.shift().resolve();
  await l;
  const u = sync.update({ hotkey: "x", apiKey: "secret" });
  assert.equal(JSON.stringify(sync.get()).includes("secret"), false);
  pending.shift().reject(new Error("ipc"));
  await u;
  pending.shift().resolve(); // the reload
  await new Promise((r) => setImmediate(r));
  assert.equal(sync.get().hotkey, "kept");
});

test("project actions: a failure is reported and the list still reloads; success just reloads", async () => {
  const { runThenReload } = require("../../src/components/copilot/copilotFormat.ts");
  const calls = [];
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    await runThenReload(
      Promise.resolve(1),
      () => calls.push("reload"),
      () => calls.push("error")
    );
    assert.deepEqual(calls, ["reload"]);
    calls.length = 0;
    await runThenReload(
      Promise.reject(new Error("SQLITE_BUSY")),
      () => calls.push("reload"),
      (e) => calls.push(`error:${e.message}`)
    );
    assert.deepEqual(calls, ["error:SQLITE_BUSY", "reload"]);
    await new Promise((r) => setImmediate(r));
    assert.equal(unhandled.length, 0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
