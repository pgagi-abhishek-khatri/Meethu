const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createScheduler,
  DEFAULT_TRIGGER_CONFIG,
} = require("../../src/copilot/core/trigger/scheduler");
const { fakeClock } = require("./helpers");

const make = (runImpl) => {
  const clock = fakeClock();
  const runs = [];
  const scheduler = createScheduler({
    run: async (ctx) => {
      runs.push({ at: clock.now(), ...ctx });
      return runImpl ? runImpl(ctx, runs.length) : { kind: "wait" };
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, runs, scheduler };
};
const sys = (text) => ({ source: "system", text });
const mic = (text) => ({ source: "mic", text });
const LONG = "so what was the revenue number for last quarter again";

test("partials never call the decision model", async () => {
  const { clock, runs, scheduler } = make();
  for (let i = 0; i < 50; i++) scheduler.notePartial();
  await clock.advance(10_000);
  assert.equal(runs.length, 0);
  assert.equal(scheduler.stats.partialsIgnored, 50);
});

test("filler and short utterances are skipped but counted", async () => {
  const { clock, runs, scheduler } = make();
  scheduler.noteFinal(sys("Yeah."));
  scheduler.noteFinal(sys("okay right"));
  scheduler.noteFinal(sys("see you"));
  await clock.advance(5000);
  assert.equal(runs.length, 0);
  assert.deepEqual(scheduler.stats.skipped, { filler: 1, too_short: 2 });
});

test("the user's own speech is judged like anyone else's", async () => {
  const { clock, runs, scheduler } = make();
  scheduler.noteFinal(mic("what do you really know about Google Meet?"));
  await clock.advance(DEFAULT_TRIGGER_CONFIG.questionDebounceMs);
  assert.equal(runs.length, 1);
});

test("a short question still triggers; a long statement triggers after the debounce", async () => {
  const { clock, runs, scheduler } = make();
  scheduler.noteFinal(sys("Revenue?"));
  await clock.advance(DEFAULT_TRIGGER_CONFIG.questionDebounceMs - 1);
  assert.equal(runs.length, 0);
  await clock.advance(1);
  assert.equal(runs.length, 1);
  await clock.advance(10_000);
  scheduler.noteFinal(sys(LONG));
  await clock.advance(DEFAULT_TRIGGER_CONFIG.debounceMs);
  assert.equal(runs.length, 2);
});

test("consecutive segments of one thought are batched into one call", async () => {
  const { clock, runs, scheduler } = make();
  scheduler.noteFinal(sys("We looked at the numbers and they look good"));
  await clock.advance(500);
  scheduler.noteFinal(sys("although the European part is still uncertain"));
  await clock.advance(500);
  scheduler.noteFinal(sys("and nobody has signed off on the budget yet"));
  await clock.advance(DEFAULT_TRIGGER_CONFIG.debounceMs);
  assert.equal(runs.length, 1);
});

test("a steady stream cannot postpone the call past maxTurnWaitMs", async () => {
  const { clock, runs, scheduler } = make();
  const first = clock.now();
  for (let i = 0; i < 40; i++) {
    scheduler.noteFinal(sys(`${LONG} number ${i}`));
    await clock.advance(700);
  }
  assert.ok(runs.length >= 1);
  assert.ok(runs[0].at - first <= DEFAULT_TRIGGER_CONFIG.maxTurnWaitMs + 1000);
});

test("calls are at least minGapMs apart", async () => {
  const { clock, runs, scheduler } = make();
  scheduler.noteFinal(sys(LONG));
  await clock.advance(DEFAULT_TRIGGER_CONFIG.debounceMs);
  const firstAt = runs[0].at;
  scheduler.noteFinal(sys(`${LONG} again please`));
  await clock.advance(DEFAULT_TRIGGER_CONFIG.debounceMs);
  assert.equal(runs.length, 1);
  await clock.advance(DEFAULT_TRIGGER_CONFIG.minGapMs);
  assert.equal(runs.length, 2);
  assert.ok(runs[1].at - firstAt >= DEFAULT_TRIGGER_CONFIG.minGapMs);
});

test("never two calls at once: segments during a call cause one follow-up, not a queue", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { clock, runs, scheduler } = make(async (ctx, n) => {
    if (n === 1) await gate;
    return { kind: "wait" };
  });
  scheduler.noteFinal(sys(LONG));
  await clock.advance(DEFAULT_TRIGGER_CONFIG.debounceMs);
  assert.equal(runs.length, 1);
  for (let i = 0; i < 4; i++) {
    scheduler.noteFinal(sys(`${LONG} extra ${i}`));
    await clock.advance(1000);
  }
  assert.equal(runs.length, 1);
  assert.ok(scheduler.stats.deferred >= 1);
  release();
  await clock.advance(0); // let the finished call settle before time moves on
  await clock.advance(10_000);
  assert.equal(runs.length, 2);
});

test("an unfinished sentence is rechecked with the waited time, then the budget resets on new words", async () => {
  const { clock, runs, scheduler } = make((ctx, n) =>
    n < 3 ? { kind: "recheck", recheckAfterMs: 800 } : { kind: "wait" }
  );
  scheduler.noteFinal(sys("So what we really need to decide today is whether we"));
  await clock.advance(DEFAULT_TRIGGER_CONFIG.debounceMs);
  await clock.advance(800);
  await clock.advance(800);
  assert.equal(runs.length, 3);
  assert.deepEqual(
    runs.map((r) => r.waitedMs),
    [0, 800, 1600]
  );
  assert.equal(scheduler.stats.rechecks, 2);
});

test("stop cancels pending work", async () => {
  const { clock, runs, scheduler } = make();
  scheduler.noteFinal(sys(LONG));
  scheduler.stop();
  await clock.advance(10_000);
  assert.equal(runs.length, 0);
});

test("a deferral keeps the text pending and retries without spending a call or looping", async () => {
  let blocked = true;
  const { clock, runs, scheduler } = make(() =>
    blocked ? { kind: "defer", retryAfterMs: 5000 } : { kind: "wait" }
  );
  scheduler.noteFinal(sys(LONG));
  await clock.advance(DEFAULT_TRIGGER_CONFIG.debounceMs);
  assert.equal(runs.length, 1);
  await clock.advance(4900);
  assert.equal(runs.length, 1, "no tight loop while deferred");
  blocked = false;
  await clock.advance(200);
  assert.equal(runs.length, 2);
  assert.equal(scheduler.stats.deferrals, 1);
});

test("a speaker still talking (partials) is let finish before D1 is asked", async () => {
  const { clock, runs, scheduler } = make();
  scheduler.noteFinal(sys(LONG));
  // the same voice keeps going: every partial pushes the call back
  for (let i = 0; i < 6; i++) {
    await clock.advance(1000);
    scheduler.notePartial("system");
  }
  assert.equal(runs.length, 0);
  assert.ok(scheduler.stats.turnWaits > 0);
  await clock.advance(DEFAULT_TRIGGER_CONFIG.turnGapMs + 100);
  assert.equal(runs.length, 1);
});

test("another voice starting ends the turn: no more waiting", async () => {
  const { clock, runs, scheduler } = make();
  scheduler.noteFinal(sys(LONG));
  await clock.advance(1000);
  scheduler.notePartial("system");
  scheduler.notePartial("mic"); // the user answers
  await clock.advance(DEFAULT_TRIGGER_CONFIG.debounceMs);
  assert.equal(runs.length, 1);
});

test("a long monologue is still looked at after maxTurnWaitMs", async () => {
  const { clock, runs, scheduler } = make();
  scheduler.noteFinal(sys(LONG));
  for (let i = 0; i < 40; i++) {
    await clock.advance(700);
    scheduler.notePartial("system");
  }
  assert.ok(runs.length >= 1);
});

test("a quiet stretch spaces the calls out, a real question still goes at once, a tag question is not one", async () => {
  const { DEFAULT_TRIGGER_CONFIG } = require("../../src/copilot/core/trigger/scheduler");
  for (const [quiet, text, expected] of [
    [false, "We use the standard flow for onboarding workers, right?", 1],
    [true, "We use the standard flow for onboarding workers, right?", 0],
    [true, "How many levels does the reward ladder have in total?", 1],
  ]) {
    const clock = fakeClock();
    const calls = [];
    const s = createScheduler({
      run: async () => (calls.push(1), {}),
      cfg: DEFAULT_TRIGGER_CONFIG,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      getQuiet: () => quiet,
    });
    s.noteFinal({ id: 1, text, source: "system" });
    await clock.advance(2500);
    assert.equal(calls.length, expected, `${quiet} ${text}`);
  }
});
