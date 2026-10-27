// Decides WHEN the decision model is called. Soniox already closes a segment at a pause
// (sentence end), so we never react to partials. On top of that:
//   - the user's own speech is judged like anyone else's (they ask real questions too); D1 decides
//   - filler and very short utterances never trigger
//   - a short debounce batches consecutive segments of one thought into one call
//   - a minimum gap between calls, and never two at once: a segment that arrives while a call
//     runs only marks the scheduler dirty (one follow-up call), nothing is queued per segment
// Pure apart from the injected clock and timers, so it is tested with a fake clock.
const { questionish } = require("../transcript/utterances");

const DEFAULT_TRIGGER_CONFIG = {
  minWords: 4,
  debounceMs: 1600, // quiet time after the last statement before D1 is asked (statements batch; they are rarely urgent)
  questionDebounceMs: 400, // a question mark shortens it
  maxBatchWaitMs: 3000, // never hold the first pending segment longer than this
  minGapMs: 4500, // between the START of two calls
  questionMinGapMs: 2000, // the same, when a question is waiting
  // Turn taking: D1 is asked when a speaker has finished, not while they are still talking.
  turnGapMs: 1500, // quiet time (no partial or final from that voice) that ends a turn
  questionTurnGapMs: 300, // a question mark means they handed over: a shorter wait
  maxTurnWaitMs: 20000, // a long monologue is still looked at this often
  quietFactor: 3, // after a long run of calls that found nothing to do, calls are spaced this much wider (a real question still goes at once)
};

const FILLER =
  /^(yeah|yes|yep|yup|okay|ok|right|sure|mm+|mhm|uh+|um+|hmm+|thanks|thank you|got it|alright|cool|great|exactly|correct|i see|no|nope|fine|good|nice)[\s.,!?]*$/i;
const words = (text) => (text.match(/\S+/g) ?? []).length;

function createScheduler({
  run,
  cfg = DEFAULT_TRIGGER_CONFIG,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  getQuiet = () => false, // true while the conversation has been giving the decider nothing to act on
}) {
  const stats = {
    fired: 0,
    deferred: 0,
    deferrals: 0,
    rechecks: 0,
    partialsIgnored: 0,
    turnWaits: 0,
    skipped: { filler: 0, too_short: 0 },
  };
  let timer = null;
  let pendingSince = null; // when the first unprocessed triggering segment arrived
  let lastStartedAt = -Infinity;
  let running = false;
  let dirty = false;
  let questionPending = false;
  let recheckPending = false; // a recheck is the same thought continuing, so the minimum gap does not apply
  let waitedMs = 0;
  let stopped = false;
  let lastActivityAt = -Infinity; // last partial or final from the voice that is pending
  let pendingSource = null; // who the pending text is from ("mic" | "system")
  let turnEnded = false; // another voice started: the pending speaker is done, no need to wait

  // "context" = keep it for the transcript but do not call D1 for it.
  function classify(seg) {
    const n = words(seg.text);
    if (FILLER.test(seg.text.trim())) return { trigger: false, reason: "filler" };
    if (n < cfg.minWords && !seg.text.includes("?")) return { trigger: false, reason: "too_short" };
    return { trigger: true };
  }

  // `capped` keeps a stream of new segments from postponing the call past maxBatchWaitMs; a
  // deferral already has a fixed retry time of its own.
  function arm(delay, capped = true) {
    clearTimer(timer);
    const cap =
      pendingSince == null || !capped
        ? delay
        : Math.max(0, pendingSince + cfg.maxBatchWaitMs - now());
    timer = setTimer(fire, Math.min(delay, cap));
  }

  async function fire() {
    timer = null;
    if (stopped) return;
    if (running) {
      dirty = true;
      stats.deferred++;
      return;
    }
    // The speaker is still going: let them finish (capped, so a monologue does not starve everything).
    if (!turnEnded && !recheckPending) {
      const quiet =
        lastActivityAt + (questionPending ? cfg.questionTurnGapMs : cfg.turnGapMs) - now();
      if (quiet > 0 && (pendingSince == null || now() - pendingSince < cfg.maxTurnWaitMs)) {
        stats.turnWaits++;
        return arm(quiet, false);
      }
    }
    const gap =
      lastStartedAt +
      (questionPending ? cfg.questionMinGapMs : cfg.minGapMs * (getQuiet() ? cfg.quietFactor : 1)) -
      now();
    if (gap > 0 && !recheckPending) return arm(gap, false); // uncapped: a gap longer than the batch cap would spin

    running = true;
    dirty = false;
    questionPending = false;
    recheckPending = false;
    pendingSince = null;
    turnEnded = false;
    lastStartedAt = now();
    stats.fired++;
    let result;
    try {
      result = await run({ waitedMs });
    } catch {
      result = null; // the runner reports its own failures; the scheduler just keeps going
    } finally {
      running = false;
    }
    if (stopped) return;
    if (result?.kind === "defer") {
      // Not the time yet (card cooldown, the user is speaking). Nothing was judged, so the text
      // stays pending and is retried, batched with whatever arrives meanwhile.
      stats.deferrals++;
      recheckPending = true;
      pendingSince ??= now();
      arm(result.retryAfterMs ?? cfg.debounceMs, false);
    } else if (result?.kind === "recheck") {
      stats.rechecks++;
      waitedMs += result.recheckAfterMs ?? 0;
      recheckPending = true;
      pendingSince ??= now();
      arm(result.recheckAfterMs ?? cfg.debounceMs);
    } else {
      waitedMs = 0;
      if (dirty) {
        pendingSince ??= now();
        arm(cfg.debounceMs);
      }
    }
  }

  return {
    stats,
    // Call for every FINAL segment. Returns what the scheduler made of it (for the dev panel).
    noteFinal(seg) {
      const c = classify(seg);
      if (!c.trigger) {
        stats.skipped[c.reason]++;
        return c;
      }
      waitedMs = 0; // new words: the "unfinished sentence" budget starts over
      if (pendingSource && pendingSource !== seg.source) turnEnded = true; // a new voice: the old turn is over
      pendingSource = seg.source;
      lastActivityAt = now();
      pendingSince ??= now();
      questionPending ||= questionish(seg.text);
      arm(questionish(seg.text) ? cfg.questionDebounceMs : cfg.debounceMs * (getQuiet() ? 2 : 1));
      return c;
    },
    // Words still being spoken never call D1, but they show whether the pending speaker has finished.
    notePartial(source) {
      stats.partialsIgnored++;
      if (pendingSource == null) return;
      if (source && source !== pendingSource) turnEnded = true;
      else lastActivityAt = now();
    },
    isRunning: () => running,
    stop() {
      stopped = true;
      clearTimer(timer);
    },
  };
}

module.exports = { createScheduler, DEFAULT_TRIGGER_CONFIG };
