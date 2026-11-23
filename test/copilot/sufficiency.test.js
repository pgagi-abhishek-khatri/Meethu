const test = require("node:test");
const assert = require("node:assert/strict");
const { judgeSufficiency } = require("../../src/copilot/core/answer/sufficiency");
const { DEFAULT_DECISION_CONFIG } = require("../../src/copilot/core/decision/config");

const { minScore, minHits } = DEFAULT_DECISION_CONFIG.sufficiency;
const LONG = "Refunds are accepted within 14 days of delivery. ".repeat(6); // > 200 chars

test("the thresholds live in the decision config", () => {
  assert.deepEqual(DEFAULT_DECISION_CONFIG.sufficiency, {
    minScore: 0.69,
    minHits: 1,
    thinChars: 200,
  });
});

test("no hits -> none", () => {
  assert.equal(
    judgeSufficiency({ project: true, passages: "", hits: [], minScore, minHits }),
    "none"
  );
});

test("one hit below minScore -> none", () => {
  assert.equal(
    judgeSufficiency({ project: true, passages: LONG, hits: [{ score: 0.6 }], minScore, minHits }),
    "none"
  );
});

test("one hit above minScore with long passages -> enough", () => {
  assert.equal(
    judgeSufficiency({ project: true, passages: LONG, hits: [{ score: 0.8 }], minScore, minHits }),
    "enough"
  );
});

test("one hit above minScore with passages under 200 chars -> thin", () => {
  assert.equal(
    judgeSufficiency({
      project: true,
      passages: "Refunds within 14 days.",
      hits: [{ score: 0.8 }],
      minScore,
      minHits,
    }),
    "thin"
  );
});

test("project search did not run -> enough (nothing changes)", () => {
  assert.equal(
    judgeSufficiency({ project: false, passages: "", hits: [], minScore, minHits }),
    "enough"
  );
});

test("bad input never throws", () => {
  assert.equal(judgeSufficiency({ project: true }), "none");
  assert.equal(judgeSufficiency(), "enough");
  assert.equal(
    judgeSufficiency({
      project: true,
      passages: LONG,
      hits: [null, { score: "x" }],
      minScore,
      minHits,
    }),
    "none"
  );
});

test("thinChars sets how short passages count as thin", () => {
  const args = {
    project: true,
    passages: "x".repeat(150),
    hits: [{ score: 0.8 }],
    minScore,
    minHits,
  };
  assert.equal(judgeSufficiency(args), "thin");
  assert.equal(judgeSufficiency({ ...args, thinChars: 100 }), "enough");
});
