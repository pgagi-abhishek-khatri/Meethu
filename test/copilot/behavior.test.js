const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createBehavior } = require("../../src/copilot/main/behavior");

const setup = (reply = "- Leave out basic definitions.\n- Prefer numbers.") => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-behavior-"));
  let values = { behavior: "" };
  const settings = { view: () => values, update: (p) => (values = { ...values, ...p }) };
  let t = 1_000_000_000;
  const calls = [];
  const make = () =>
    createBehavior({
      dir,
      settings,
      now: () => t,
      llm: () => async (req) => (calls.push(req), { text: reply }),
    });
  return {
    dir,
    settings,
    calls,
    make,
    advance: (ms) => (t += ms),
    get values() {
      return values;
    },
  };
};

test("the guide is rewritten only after enough signals, then the signals are thrown away", async () => {
  const s = setup();
  const b = s.make();
  for (let i = 0; i < 4; i++) b.note("down", `moment ${i}`);
  assert.equal(await b.maybeUpdate(), false, "four signals: too few");
  b.note("wanted", "a moment the user asked for");
  assert.equal(await b.maybeUpdate(), true);
  assert.equal(s.values.behavior, "- Leave out basic definitions.\n- Prefer numbers.");
  assert.equal(b.pending(), 0, "no samples are kept");
  const prompt = s.calls[0].messages.map((m) => m.content).join("\n");
  assert.match(prompt, /GLOBAL/);
  assert.match(prompt, /not helpful: moment 0/);
  assert.match(prompt, /wanted: a moment the user asked for/);
  assert.match(prompt, /Never quote or list the signals/);
});

test("updates are rare: not again within hours, unless a lot piled up; an undo removes the signal", async () => {
  const s = setup();
  const b = s.make();
  for (let i = 0; i < 5; i++) b.note("down", `a${i}`);
  assert.equal(await b.maybeUpdate(), true);
  for (let i = 0; i < 5; i++) b.note("down", `b${i}`);
  assert.equal(await b.maybeUpdate(), false, "too soon");
  s.advance(13 * 3600 * 1000);
  b.note("undo", "b0");
  assert.equal(b.pending(), 4);
  b.note("down", "b5");
  assert.equal(await b.maybeUpdate(), true, "enough time has passed");
  for (let i = 0; i < 12; i++) b.note("down", `c${i}`);
  assert.equal(await b.maybeUpdate(), true, "twelve signals do not wait");
});

test("pending signals survive a restart; an empty or runaway reply changes nothing", async () => {
  const s = setup("");
  const b = s.make();
  for (let i = 0; i < 6; i++) b.note("down", `x${i}`);
  assert.equal(s.make().pending(), 6);
  assert.equal(await b.maybeUpdate(), false, "empty reply");
  assert.equal(s.values.behavior, "");
  assert.equal(b.pending(), 6, "the signals wait for the next try");
});
