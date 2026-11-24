const test = require("node:test");
const assert = require("node:assert/strict");
const { createEngine } = require("../../src/copilot/main/engine");
const { fakeClock } = require("./helpers");

function fakeMain() {
  const calls = [];
  const fn = async (opts) => {
    calls.push(opts);
    return { text: "TITLE: T\n- point.", sources: [] };
  };
  fn.calls = calls;
  return fn;
}

function setup(opts = {}, main = fakeMain()) {
  const clock = fakeClock();
  const events = [];
  const engine = createEngine({
    env: { OPENROUTER_API_KEY: "test-key" },
    panel: {
      send: (e) => events.push(e),
      onAsk: () => {},
    },
    mainModel: main,
    d1: async () => ({ text: JSON.stringify({ action: "run", kind: "quick_answer", gist: "test" }) }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...opts,
  });
  return { engine, events, main, clock };
}

test("engine.pause and resume control proactive analysis triggers", () => {
  const { engine, events } = setup();

  assert.equal(engine.isPaused(), false);

  // Pause workflow
  assert.equal(engine.pause(), true);
  assert.equal(engine.isPaused(), true);
  assert.ok(events.some((e) => e.type === "pause" && e.paused === true));

  // Feed final transcript while paused
  events.length = 0;
  engine.onFinal({ text: "What is the total revenue for this quarter?", source: "system" });

  // Segment should NOT be recorded or emitted while paused
  const segEvent = events.find((e) => e.type === "segment");
  assert.equal(segEvent, undefined, "audio segments are not listened to or emitted while paused");

  // Feed partial transcript while paused
  engine.onPartial({ text: "Partial words", source: "mic" });
  const partialEvent = events.find((e) => e.type === "partial");
  assert.equal(partialEvent, undefined, "partials are not listened to or emitted while paused");

  // Resume workflow
  events.length = 0;
  assert.equal(engine.resume(), true);
  assert.equal(engine.isPaused(), false);
  assert.ok(events.some((e) => e.type === "pause" && e.paused === false));

  // Next segment should trigger normally
  engine.onFinal({ text: "Can we verify the contract terms?", source: "system" });
  const segEvent2 = events.find((e) => e.type === "segment");
  assert.ok(segEvent2, "resumed engine ingests final segment");
  assert.equal(segEvent2.trigger, true, "resumed engine triggers analysis normally");
});

test("engine.setPaused toggles state accurately", () => {
  const { engine } = setup();

  engine.setPaused(true);
  assert.equal(engine.isPaused(), true);

  engine.setPaused(false);
  assert.equal(engine.isPaused(), false);
});
