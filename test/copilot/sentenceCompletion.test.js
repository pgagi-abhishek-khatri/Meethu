// Unit tests for sentenceCompletion module.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  completeLine,
  ensureSentenceCompletion,
  ensureQuestionCompletion,
} = require("../../src/copilot/core/answer/sentenceCompletion");

test("completeLine preserves already complete sentences and punctuation", () => {
  assert.equal(completeLine("This is a complete sentence."), "This is a complete sentence.");
  assert.equal(completeLine("Is this ready?"), "Is this ready?");
  assert.equal(completeLine("Great job!"), "Great job!");
  assert.equal(completeLine("He said 'hello.'"), "He said 'hello.'");
});

test("completeLine preserves markdown headers, code fences, and empty lines", () => {
  assert.equal(completeLine("# Header title"), "# Header title");
  assert.equal(completeLine("### Subheader"), "### Subheader");
  assert.equal(completeLine("```javascript"), "```javascript");
  assert.equal(completeLine("---"), "---");
  assert.equal(completeLine(""), "");
});

test("completeLine formats bullets and appends period if missing", () => {
  assert.equal(completeLine("- First key point"), "- First key point.");
  assert.equal(completeLine("* Second key point."), "* Second key point.");
  assert.equal(completeLine("1. Ranked item"), "1. Ranked item.");
});

test("completeLine trims trailing commas, semicolons, and dangling conjunctions", () => {
  assert.equal(completeLine("The service failed because,"), "The service failed.");
  assert.equal(completeLine("We need to check the logs and"), "We need to check the logs.");
  assert.equal(completeLine("Performance improved;"), "Performance improved.");
  assert.equal(completeLine("- Data migration finished, but"), "- Data migration finished.");
});

test("completeLine trims back to last complete sentence when cut off mid-thought across multiple sentences", () => {
  const truncated = "Phase one is verified. The next deployment step was started and";
  assert.equal(completeLine(truncated), "Phase one is verified.");
});

test("ensureSentenceCompletion formats multiline answers and bullets", () => {
  const input = `
# Executive Summary

- We examined the error rates across clusters
- Latency spike was observed during peak hours and

Next steps include checking database indexes
`;
  const expected = `# Executive Summary

- We examined the error rates across clusters.
- Latency spike was observed during peak hours.

Next steps include checking database indexes.`;

  assert.equal(ensureSentenceCompletion(input), expected);
});

test("ensureQuestionCompletion adds question mark and strips trailing punctuation", () => {
  assert.equal(ensureQuestionCompletion("What is the current latency"), "What is the current latency?");
  assert.equal(ensureQuestionCompletion("Can we deploy now?"), "Can we deploy now?");
  assert.equal(ensureQuestionCompletion("Should we rollback."), "Should we rollback?");
  assert.equal(ensureQuestionCompletion("Who approved this:"), "Who approved this?");
  assert.equal(ensureQuestionCompletion(""), "");
  assert.equal(ensureQuestionCompletion(null), "");
});
