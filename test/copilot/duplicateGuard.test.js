const test = require("node:test");
const assert = require("node:assert");
const { isDuplicate } = require("../../src/copilot/core/decision/duplicateGuard");

const NOW = 1_000_000;
const opts = { now: NOW, windowMs: 300000, minOverlap: 0.6 };
const card = (gist, shownAt = NOW - 1000) => ({ jobId: "j1", gist, shownAt });

test("identical text is a duplicate of a recent card", () => {
  const r = isDuplicate({ text: "What is the pricing for the pro plan", cards: [card("What is the pricing for the pro plan")], asked: new Set(), ...opts });
  assert.strictEqual(r.duplicate, true);
  assert.strictEqual(r.matchedJobId, "j1");
});

test("same need in other words is a duplicate", () => {
  const r = isDuplicate({ text: "what's the price", cards: [card("how much does the price cost")], asked: new Set(), ...opts });
  assert.strictEqual(r.duplicate, true);
});

test("different topic is not a duplicate", () => {
  const r = isDuplicate({ text: "when does the contract renew", cards: [card("what is the price")], asked: new Set(), ...opts });
  assert.strictEqual(r.duplicate, false);
});

test("a card older than the window does not count", () => {
  const r = isDuplicate({ text: "what is the price", cards: [card("what is the price", NOW - 400000)], asked: new Set(), ...opts });
  assert.strictEqual(r.duplicate, false);
});

test("empty text is not a duplicate", () => {
  const r = isDuplicate({ text: "  ", cards: [card("what is the price")], asked: new Set(["what is the price"]), ...opts });
  assert.deepStrictEqual(r, { duplicate: false, score: 0 });
});

test("different numbers are not a duplicate", () => {
  const r = isDuplicate({ text: "it costs $40 a month", cards: [card("it costs $20 a month")], asked: new Set(), ...opts });
  assert.strictEqual(r.duplicate, false);
});

test("matches a previously asked question", () => {
  const r = isDuplicate({ text: "What is the price?", cards: [], asked: new Set(["what is the price"]), ...opts });
  assert.strictEqual(r.duplicate, true);
  assert.strictEqual(r.matchedJobId, undefined);
});
