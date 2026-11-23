// One answer = one card: build the context pack, stream the main model, report card events.
// Electron-free. A proactive failure is reported as an event only (the UI decides to show nothing);
// every call can be cancelled.
const { buildAnswerMessages } = require("../core/answer/contextPack");
const { parseAnswer } = require("../core/answer/parseAnswer");

// True while a proactive answer could still be a SKIP: nothing yet, or a prefix of "SKIP" ("S", "SK", "SKI").
// Text that starts with SKIP itself is caught by parseAnswer.
const maybeSkip = (text) => {
  const head = String(text ?? "")
    .trimStart()
    .slice(0, 4)
    .toUpperCase();
  return head.length < 4 && "SKIP".startsWith(head);
};

function createAnswerRunner({ model, emit = () => {}, now = Date.now }) {
  // job: { id, deliverable, tier, web, proactive, focus, context: {meeting, summary, transcript, contextSeconds, thread} }
  function run(job) {
    const ctl = new AbortController();
    const t0 = now();
    const base = {
      id: job.id,
      deliverable: job.deliverable,
      tier: job.tier,
      web: job.web,
      proactive: job.proactive,
      label: job.label,
      auto: job.auto,
      deep: job.deep,
      of: job.of,
    };
    // A proactive card may turn out to be a SKIP, so it appears only once its first words are known
    // (a web card shows "searching" at once: its wait is long and the user should see work happening).
    let started = false;
    let firstVisibleMs = null; // when the card first reached the window (latency report)
    const start = () => {
      if (started) return;
      started = true;
      firstVisibleMs = now() - t0;
      emit({ type: "card_start", ...base, focus: job.focus });
    };
    if (!job.proactive || job.web) start();
    // `prepare` (the project search) runs first and adds `passages`; the build and the model call follow.
    const build = (extra = {}) =>
      buildAnswerMessages({
        deliverable: job.deliverable,
        web: job.web,
        proactive: job.proactive,
        deep: job.deep,
        focus: job.focus,
        now: t0,
        ...job.context,
        ...extra,
      });
    let files = [];
    let cancelled = false;
    let settled = false;
    // Without a search the model is called at once (synchronously); with one, after the passages are found.
    const go = (extra) => {
      {
        if (cancelled) return null;
        files = extra?.files ?? [];
        return model({
          messages: build({ passages: extra?.passages ?? "" }),
          tier: job.tier,
          web: job.web,
          model: job.model,
          signal: ctl.signal,
          onDelta: (text) => {
            if (cancelled) return;
            const a = parseAnswer(text);
            if (a.skip) return; // the call is finished off below
            // A proactive card streams as soon as its first words show it is not a SKIP (a late SKIP removes it,
            // see below). Waiting for the whole answer used to hide every card until it was finished.
            // (Also for a web card that is already shown: "SK" on its way to "SKIP" is never displayed.)
            if (job.proactive && maybeSkip(text)) return;
            start();
            emit({ type: "card_update", id: job.id, ...a });
          },
        })
          .then(async (r) => {
            settled = true;
            if (cancelled) return null;
            const a = parseAnswer(r.text);
            // Cut off by the token cap: an unfinished card is worse than none when nobody asked for it, unless the
            // user is already reading it (it streamed): then it stays, marked truncated.
            if (r.finishReason === "length" && job.proactive && !started) {
              emit({ type: "card_skip", id: job.id, reason: "truncated", shown: started });
              return { skipped: true, reason: "truncated" };
            }
            if (job.proactive && a.skip) {
              emit({ type: "card_skip", id: job.id, reason: a.reason, shown: started });
              return { skipped: true, reason: a.reason };
            }
            start();
            const card = {
              id: job.id,
              title: a.title,
              body: a.body,
              followups: a.followups ?? [],
              confidence: a.confidence ?? "low", // an asked card with no label is not trusted
              truncated: r.finishReason === "length",
              sources: r.sources,
              timing: {
                firstTokenMs: r.firstTokenMs,
                totalMs: r.totalMs,
                sinceTriggerMs: now() - t0,
                firstVisibleMs: firstVisibleMs ?? now() - t0,
              },
              usage: r.usage,
              files, // which project files the answer was given passages from
            };
            if (!a.body) {
              emit({
                type: "card_error",
                id: job.id,
                proactive: job.proactive,
                code: "empty",
                message: "empty answer",
              });
              return { error: "empty" };
            }
            emit({ type: "card_done", ...card });
            return card;
          })
          .catch((e) => {
            settled = true;
            if (cancelled) return null;
            emit({
              type: "card_error",
              id: job.id,
              proactive: job.proactive,
              code: e.code ?? "error",
              message: e.message,
            });
            return { error: e.code ?? "error" };
          });
      }
    };
    const done = job.prepare
      ? job
          .prepare()
          .catch(() => ({}))
          .then(go)
      : go({});
    return {
      id: job.id,
      done,
      cancel() {
        if (cancelled || settled) return; // a finished card is not cancelled
        cancelled = true;
        ctl.abort();
        emit({ type: "card_cancel", id: job.id });
      },
    };
  }
  return { run };
}

module.exports = { createAnswerRunner };
