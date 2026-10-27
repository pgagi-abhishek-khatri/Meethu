const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openStore } = require("../../src/copilot/main/store");
const { createSettings } = require("../../src/copilot/main/settings");
const { readReference } = require("../../src/copilot/main/reference");

// better-sqlite3 is built for Electron here; under plain node these are skipped.
// Run them with: ELECTRON_RUN_AS_NODE=1 npx electron --test test/copilot/store.test.js
let canOpen = true;
try {
  const D = require("better-sqlite3");
  new D(":memory:").close();
} catch {
  canOpen = false;
}
const sqlite = { skip: canOpen ? false : "better-sqlite3 is not built for this runtime" };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "copilot-store-"));

test("a meeting round-trips: segments, threads, cards and feedback", sqlite, () => {
  let t = 1000;
  const store = openStore({ dbPath: path.join(tmp(), "c.db"), now: () => (t += 10) });
  store.startSession("s1", "Live meeting");
  store.addSegment("s1", { id: 1, source: "system", text: "What is ARR?", at: 5 });
  store.saveThread("s1", { id: "t1", title: "Pricing" });
  store.saveCard("s1", {
    id: "j1",
    threadId: "main",
    deliverable: "quick_answer",
    focus: "q",
    status: "running",
  });
  store.saveCard("s1", {
    id: "j1",
    threadId: "main",
    title: "ARR",
    body: "Annual recurring revenue",
    confidence: "high",
    sources: [{ url: "https://x.y" }],
    status: "done",
    createdAt: 1010,
  });
  store.setFeedback("s1", "j1", "up");
  store.saveCard("s1", {
    id: "j1",
    threadId: "main",
    title: "ARR",
    body: "Annual recurring revenue",
    sources: [{ url: "https://x.y" }],
    status: "done",
    createdAt: 1010,
  }); // a re-save keeps the feedback
  store.endSession("s1", "Short summary");
  const got = store.getSession("s1");
  assert.equal(got.session.summary, "Short summary");
  assert.equal(got.segments[0].text, "What is ARR?");
  assert.deepEqual(
    got.threads.map((x) => x.id),
    ["main", "t1"]
  );
  assert.equal(got.cards[0].feedback, "up");
  assert.deepEqual(got.cards[0].sources, [{ url: "https://x.y" }]);
  assert.equal(store.listSessions()[0].cards, 1);
  store.deleteSession("s1");
  assert.equal(store.getSession("s1"), null);
});

test("projects: files, active flag, and retention pruning", sqlite, () => {
  let t = 1000;
  const store = openStore({ dbPath: path.join(tmp(), "c.db"), now: () => t });
  const id = store.projects.create("Acme");
  store.projects.addFile(id, "/a/notes.md", "notes.md");
  assert.equal(store.projects.activeFiles().length, 1);
  store.projects.setActive(id, false);
  assert.equal(store.projects.activeFiles().length, 0);
  assert.equal(store.projects.list()[0].files[0].name, "notes.md");
  store.projects.remove(id);
  assert.equal(store.projects.list().length, 0);
  store.startSession("old", "x");
  t += 100 * 86400000;
  store.startSession("new", "x");
  assert.equal(store.prune(90), 1);
  assert.deepEqual(
    store.listSessions().map((s) => s.id),
    ["new"]
  );
});

test("settings: the key stays out of the view, a saved key beats .env, bad values are clamped", () => {
  const dir = tmp();
  const s = createSettings({ dir, env: { OPENROUTER_API_KEY: "env-key" } });
  assert.equal(s.engine().apiKey, "env-key");
  assert.equal(s.view().keyFromEnv, true);
  s.update({ apiKey: "saved-key", quiet: "loud", maxParallel: 99, opacity: 0.01, plan: "Goal" });
  assert.equal(s.engine().apiKey, "saved-key");
  assert.equal(JSON.stringify(s.view()).includes("saved-key"), false);
  assert.equal(s.view().quiet, "normal");
  assert.equal(s.view().maxParallel, 6);
  assert.equal(s.view().opacity, 0.3);
  assert.equal(createSettings({ dir, env: {} }).engine().apiKey, "saved-key", "survives a restart");
  assert.equal(createSettings({ dir, env: {} }).view().plan, "Goal");
  s.update({ apiKey: "" });
  assert.equal(s.engine().apiKey, "env-key");
});

test("reference: text files are inlined within one budget, others are left out", () => {
  const files = [
    { path: "/a/one.md", name: "one.md" },
    { path: "/a/two.txt", name: "two.txt" },
    { path: "/a/deck.pdf", name: "deck.pdf" },
  ];
  const out = readReference(files, {
    budget: 40,
    read: (p) => (p.endsWith("one.md") ? "A".repeat(100) : "short"),
  });
  assert.match(out, /FILE one.md\nA{20} \[cut\]/);
  assert.match(out, /FILE two.txt\nshort/);
  assert.doesNotMatch(out, /deck/);
  assert.equal(readReference([{ path: "/x.pdf", name: "x.pdf" }]), "");
});
