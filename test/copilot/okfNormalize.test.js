// Phase 5.7: one normalisation for titles and keywords, shared by the document lookup and the feature registry.
const test = require("node:test");
const assert = require("node:assert/strict");
const shared = require("../../src/copilot/core/okf/normalize");
const lookup = require("../../src/copilot/core/okf/lookup");

test("normalizeTitle: case, dashes, quotes, trailing punctuation and spacing", () => {
  assert.equal(
    shared.normalizeTitle("  “Live  Meeting” Copilot — Architecture...  "),
    "live meeting copilot - architecture"
  );
  assert.equal(shared.normalizeTitle(null), "");
  assert.equal(shared.normalizeTitle(42), "");
});

test("normalizeKeyword keeps letters, digits and hyphens only", () => {
  assert.equal(shared.normalizeKeyword("  Ingestion_Pipeline! "), "ingestionpipeline");
  assert.equal(shared.normalizeKeyword("real-time"), "real-time");
  assert.equal(shared.normalizeKeyword(undefined), "");
});

test("the lookup service re-exports the shared functions, not copies", () => {
  assert.equal(lookup.normalizeTitle, shared.normalizeTitle);
  assert.equal(lookup.normalizeKeyword, shared.normalizeKeyword);
});
