const test = require("node:test");
const assert = require("node:assert/strict");
const { toUtterances, isBackchannel } = require("../../src/copilot/core/transcript/utterances");
const { speakerLabel } = require("../../src/copilot/core/decision/buildState");

const seg = (id, source, text, speaker) => ({ id, source, text, speaker, at: id });

test("backchannel is dropped, questions never are", () => {
  for (const t of ["Yeah.", "Uh-huh.", "Mm-hmm.", "You.", "Yeah, yeah, yeah.", "Right, okay."])
    assert.ok(isBackchannel(t), t);
  for (const t of ["Right?", "Yeah, so the price is fixed.", "Okay, let's start the review"])
    assert.ok(!isBackchannel(t), t);
});

test("slices of one voice that did not end a sentence become one utterance", () => {
  const out = toUtterances(
    [
      seg(
        1,
        "system",
        "So the agent will use this logic, not a generalized logic, getting",
        "system:1"
      ),
      seg(2, "system", "Yeah.", "system:2"), // a listener's "yeah" does not break the speech
      seg(3, "system", "my point? Now whenever we trade smaller stocks", "system:1"),
    ],
    speakerLabel
  );
  assert.equal(out.length, 1);
  assert.match(out[0].text, /getting my point/);
  assert.equal(out[0].id, 3);
  assert.equal(out[0].label, "OTHER-1");
});

test("a finished sentence or another voice starts a new utterance", () => {
  const out = toUtterances(
    [
      seg(1, "system", "We ship on Friday.", "system:1"),
      seg(2, "system", "Can we move it to Monday instead", "system:1"),
      seg(3, "mic", "Let me check with the team about it", undefined),
    ],
    speakerLabel
  );
  assert.deepEqual(
    out.map((u) => u.label),
    ["OTHER-1", "OTHER-1", "USER"]
  );
});

test("a long speech stays several pieces so the newest words are never clipped away", () => {
  const long = Array.from({ length: 6 }, (_, i) =>
    seg(i + 1, "system", `part ${i} ${"x".repeat(200)}`, "system:1")
  );
  const out = toUtterances(long, speakerLabel);
  assert.ok(out.length >= 3);
  assert.ok(out.every((u) => u.text.length < 700));
});

test("tag questions ask nothing; a real question is a sentence with its own words", () => {
  const { realQuestion } = require("../../src/copilot/core/transcript/utterances");
  assert.equal(realQuestion("So now it works, right?"), false);
  assert.equal(realQuestion("Uh, you know? Okay?"), false);
  assert.equal(realQuestion("What does it take to get it smarter?"), true);
  assert.equal(
    realQuestion("We use JWT tokens, right? And how long does a token stay valid?"),
    true
  );
  assert.equal(realQuestion("What is LLMs?"), false, "three words: too short to judge on its own");
  assert.equal(realQuestion("No question here."), false);
});
