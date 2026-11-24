const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validateUserInput } = require("../../src/copilot/core/validation/inputValidation");

test("validateUserInput: rejects empty or whitespace-only inputs", () => {
  const r1 = validateUserInput("");
  assert.equal(r1.valid, false);
  assert.equal(r1.reason, "empty");

  const r2 = validateUserInput("   \n\t ");
  assert.equal(r2.valid, false);
  assert.equal(r2.reason, "empty");
});

test("validateUserInput: rejects inputs under the minimum word threshold", () => {
  const r1 = validateUserInput("price");
  assert.equal(r1.valid, false);
  assert.equal(r1.reason, "too_short");
  assert.ok(r1.message.includes("1 word"));

  const r2 = validateUserInput("what price");
  assert.equal(r2.valid, false);
  assert.equal(r2.reason, "too_short");
  assert.ok(r2.message.includes("2 words"));
});

test("validateUserInput: rejects pure filler and backchannel pleasantries", () => {
  assert.equal(validateUserInput("yeah").valid, false);
  assert.equal(validateUserInput("hello").valid, false);
  assert.equal(validateUserInput("ok sure").valid, false);
  assert.equal(validateUserInput("thank you").valid, false);
  const r = validateUserInput("okay got it");
  assert.equal(r.valid, false);
  assert.equal(r.reason, "filler_only");
});

test("validateUserInput: rejects repetitive keyboard smashing / gibberish", () => {
  const r = validateUserInput("check this aaaaaaa please");
  assert.equal(r.valid, false);
  assert.equal(r.reason, "irrelevant");
});

test("validateUserInput: rejects inputs ending with dangling conjunctions or prepositions", () => {
  const r1 = validateUserInput("The client asked for pricing and");
  assert.equal(r1.valid, false);
  assert.equal(r1.reason, "incomplete");

  const r2 = validateUserInput("We cannot deploy this because");
  assert.equal(r2.valid, false);
  assert.equal(r2.reason, "incomplete");

  const r3 = validateUserInput("The contract was signed with,");
  assert.equal(r3.valid, false);
  assert.equal(r3.reason, "incomplete");
});

test("validateUserInput: accepts valid questions and auto-formats missing question mark", () => {
  const q1 = validateUserInput("What is the buyer premium?");
  assert.equal(q1.valid, true);
  assert.equal(q1.kind, "question");
  assert.equal(q1.formattedText, "What is the buyer premium?");

  // Question starting with interrogative word but omitting '?'
  const q2 = validateUserInput("How does the bidding engine work");
  assert.equal(q2.valid, true);
  assert.equal(q2.kind, "question");
  assert.equal(q2.formattedText, "How does the bidding engine work?");

  // Question ending in ? without initial question word
  const q3 = validateUserInput("This works on mobile right?");
  assert.equal(q3.valid, true);
  assert.equal(q3.kind, "question");
  assert.equal(q3.formattedText, "This works on mobile right?");
});

test("validateUserInput: accepts complete sentences and auto-formats missing terminal punctuation", () => {
  const s1 = validateUserInput("Please draft an email to the client.");
  assert.equal(s1.valid, true);
  assert.equal(s1.kind, "sentence");
  assert.equal(s1.formattedText, "Please draft an email to the client.");

  // Complete statement without period auto-appends period
  const s2 = validateUserInput("We need to confirm the regional deployment budget");
  assert.equal(s2.valid, true);
  assert.equal(s2.kind, "sentence");
  assert.equal(s2.formattedText, "We need to confirm the regional deployment budget.");

  // Exclamation sentence
  const s3 = validateUserInput("The auction is now live!");
  assert.equal(s3.valid, true);
  assert.equal(s3.kind, "sentence");
  assert.equal(s3.formattedText, "The auction is now live!");
});
