const test = require("node:test");
const assert = require("node:assert/strict");
const { reduce, initialState, cardsOf } = require("../../src/components/copilot/copilotState.ts");

const run = (events, s = initialState()) => events.reduce(reduce, s);

test("a session start resets, segments are idempotent, a partial clears when its line arrives", () => {
  let s = run([
    { type: "session", state: "start", sessionId: "a", active: true, canAnswer: true },
    { type: "partial", label: "OTHER", text: "what was the" },
  ]);
  assert.equal(s.partial.text, "what was the");
  const seg = {
    type: "segment",
    id: 1,
    source: "system",
    label: "OTHER",
    text: "What was the revenue?",
  };
  s = run([seg, seg], s);
  assert.equal(s.segments.length, 1);
  assert.equal(s.partial, null);
});

test("a card streams, finishes, and a replay of the same events changes nothing", () => {
  const events = [
    { type: "session", state: "start" },
    { type: "card_start", id: "j1", threadId: "main", web: false, proactive: false, focus: "q" },
    { type: "card_update", id: "j1", title: "ARR", body: "Annual", confidence: null },
    {
      type: "card_done",
      id: "j1",
      threadId: "main",
      title: "ARR",
      body: "Annual recurring revenue",
      confidence: "high",
      sources: [],
      timing: { totalMs: 9 },
    },
  ];
  const once = run(events);
  assert.equal(once.cards[0].status, "done");
  assert.deepEqual(run(events.slice(1), once), once);
  assert.equal(cardsOf(once, "main").length, 1);
});

test("a web card shows searching; skipped, cancelled and failed proactive cards disappear; asked failures stay", () => {
  let s = run([
    { type: "card_start", id: "a", web: true },
    { type: "card_start", id: "b" },
    { type: "card_start", id: "c" },
    { type: "card_start", id: "d", proactive: false },
  ]);
  assert.equal(s.cards[0].status, "searching");
  s = run(
    [
      { type: "card_skip", id: "a" },
      { type: "card_cancel", id: "b" },
      { type: "card_error", id: "c", proactive: true },
      { type: "card_error", id: "d", proactive: false, code: "http_402" },
    ],
    s
  );
  assert.deepEqual(
    s.cards.map((c) => [c.id, c.status]),
    [["d", "error"]]
  );
  assert.match(s.cards[0].error, /credits/);
});

test("threads: create, rename, close removes their cards; queued cards wait", () => {
  let s = run([
    { type: "thread", action: "create", thread: { id: "t1", title: "Pricing" } },
    { type: "card_queued", id: "j2", threadId: "t1", focus: "x" },
  ]);
  assert.equal(s.cards[0].status, "queued");
  s = run([{ type: "thread", action: "rename", thread: { id: "t1", title: "Costs" } }], s);
  assert.equal(s.threads[1].title, "Costs");
  s = run([{ type: "thread", action: "close", thread: { id: "t1" } }], s);
  assert.equal(s.threads.length, 1);
  assert.equal(s.cards.length, 0);
});

test("skipped replaces the list, project and mode are kept, activity sets busy", async () => {
  const { reduce, initialState } = await import("../../src/components/copilot/copilotState.ts");
  let s = initialState();
  s = reduce(s, { type: "skipped", items: [{ id: "k1", line: "Why?" }] });
  s = reduce(s, { type: "skipped", items: [{ id: "k2", line: "What is X?" }] });
  assert.deepEqual(
    s.skipped.map((i) => i.id),
    ["k2"]
  );
  s = reduce(s, { type: "project", projectId: 3, name: "Acme", event: null });
  assert.equal(s.project.name, "Acme");
  s = reduce(s, { type: "mode", mode: "orb" });
  assert.equal(s.mode, "orb");
  s = reduce(s, { type: "activity", busy: true });
  assert.equal(s.busy, true);
  s = reduce(s, { type: "session", state: "end" });
  assert.deepEqual(s.skipped, []);
});

test("marking a card not helpful sticks to that card only", () => {
  let s = run([
    { type: "card_start", id: "a", proactive: true },
    { type: "card_start", id: "b", proactive: true },
  ]);
  s = reduce(s, { type: "feedback", id: "a", value: "down" });
  assert.equal(s.cards.find((c) => c.id === "a").feedback, "down");
  assert.equal(s.cards.find((c) => c.id === "b").feedback, undefined);
  s = reduce(s, { type: "feedback", id: "a", value: null });
  assert.equal(s.cards.find((c) => c.id === "a").feedback, null);
});
