// The copilot engine. It listens to the live meeting transcript, decides WHEN to ask D1 (scheduler),
// keeps a rolling summary so D1 reads little, asks D1 what the moment needs and, when something is
// worth a card, runs the main model (answerRunner) and reports card events. Cards live in threads:
// "main" (D1's cards and the user's questions) and custom threads the user opens (typed questions only,
// run in parallel up to a cap). Electron-free: the sink (`panel`), settings and clock are injected, so it
// is tested and simulated headless. Without an API key it only keeps the transcript.
const fs = require("fs");
const path = require("path");
const {
  decide,
  createLiquidClient,
  getDecisionEnv,
  DEFAULT_DECISION_CONFIG,
  DEFAULT_SETTINGS,
} = require("../core/decision");
const { speakerLabel, clip, oneLine } = require("../core/decision/buildState");
const { createScheduler, DEFAULT_TRIGGER_CONFIG } = require("../core/trigger/scheduler");
const { getCopilotAiConfig } = require("../config/aiDefaults");
const { createMainModel } = require("./mainCall");
const { createAnswerRunner } = require("./answerRunner");
const { createCardVerifier } = require("../core/answer/verify");
const { toUtterances, realQuestion } = require("../core/transcript/utterances");
const {
  createRollingSummary,
  createOpenRouterLlm,
  DEFAULT_SUMMARY_CONFIG,
  DEFAULT_SUMMARY_MODEL,
} = require("../core/summary/rollingSummary");

const MAX_TRANSCRIPT = 300;
// Per-meeting memory caps: a 2-hour meeting must not grow the heap without bound.
const MAX_SPECS = 60; // job specs kept for "rerun with high effort"
const MAX_ASKED = 150; // lines already turned into cards or offered
const MAX_THREAD_ANSWERS = 24; // finished cards a thread remembers (the model sees only the last few)
const MAX_TIMINGS = 200;
const MAX_SKIPPED = 12; // skipped moments kept for the user to tap
const SKIPPED_TTL_MS = 30 * 60 * 1000;
const MODEL_TRANSCRIPT = 120; // newest segments handed to the answer model (it reads a few hundred characters of them)
const PARTIAL_EMIT_MS = 300; // the window repaints at most this often while someone talks
const norm = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
// Words that mean the call is about to end (closing card). Said early in a call they are greetings, so a
// card also needs enough talk behind it.
const CLOSING_CUE =
  /\b(let'?s (wrap|round) (this |it )?up|wrap(ping)? (this |it )?up|any (other|more|last|final) questions|anything else (from|for) (you|me|anyone)|that'?s (all|it) (from|for) (me|my side|today)|thanks?,? (so much )?(everyone|all|guys|for (your time|joining|coming|today))|(running|out of) (out of )?time|we can (end|stop|close|finish) (here|there|it)|talk (to you )?(soon|later|tomorrow|next)|have a (great|good|nice|lovely) (day|one|evening|weekend|rest)|see you (all )?(soon|next|tomorrow|later)|good ?bye)\b/i;
const CLOSING_MIN_SEGMENTS = 12;
const CLOSING_GAP_MS = 5 * 60 * 1000;
const CLOSING_BEFORE_END_MS = 3 * 60 * 1000;
const DEFAULT_CLOSING =
  "The meeting is ending. Give me 3 to 5 short lines I can say out loud to close it: thank them, one line on what we agreed, who does what next, and ask if anything is missing.";
const QUIET_AFTER = 6; // this many decisions in a row with nothing to act on: the decider is called less often
const AUTO_SCORE = 0.69; // keep in step with RAG.autoScore
const SKIP_REASON = /below_bar|cooldown|already_handled|user_speaking/;
// The decider could not judge it (failed call, below its gate, no card kind sure enough): a real question is still worth a tap.
const UNJUDGED = /decision_unavailable|below_gate|deliverable: none/;
const pctile = (xs, p) =>
  xs.length
    ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]
    : null;

function createEngine({
  env = process.env,
  logDir,
  panel = null,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  client = null,
  llm = null,
  mainModel = null, // injected in tests; otherwise built from the settings / .env (COPILOT_MAIN=0 keeps the simulated jobs)
  getSettings = () => ({}), // live: { apiKey, mainModel, summaryModel, quiet, instructions, plan, startPrompt, endPrompt, endRecap, maxParallel }
  getReference = () => "", // text of the project files not indexed yet (small text files are inlined as before)
  onSignal = () => {}, // feedback for the behaviour guide: ("down" | "wanted", the moment's words)
  rag = null, // project search: { hasIndex(), catalog(), prefetch(query), retrieve({query, deep, why, expand}) }
  decisionCfg = DEFAULT_DECISION_CONFIG,
  triggerCfg = DEFAULT_TRIGGER_CONFIG,
  summaryCfg = DEFAULT_SUMMARY_CONFIG,
} = {}) {
  const logFile = logDir ? path.join(logDir, "copilot-decisions.jsonl") : null;
  // The clients depend on the settings (key, models), so they are built when a meeting starts:
  // a changed setting applies to the next meeting.
  let baseD1 = null;
  let summaryLlm = null;
  let model = null;
  let active = false;
  let deepModelId = null;
  const liveSettings = () => getSettings() ?? {};
  const hasIndex = () => {
    try {
      return !!rag?.hasIndex();
    } catch {
      return false;
    }
  };
  const decisionSettings = () => ({
    ...DEFAULT_SETTINGS,
    projectFiles: hasIndex(), // the decider asks "does it need the USER's project documents?" only when there are some
    quiet: liveSettings().quiet || env.COPILOT_QUIET || "normal",
  });
  const webOn = () => liveSettings().web === true; // web search in quick answers: off unless the user turned it on ("Go deeper" always searches)
  const MAIN = "main";
  const DEFAULT_START =
    "Remind me, from my notes for this meeting, of the goals and the points I wanted to cover, as a short checklist.";
  const DEFAULT_END =
    "Wrap up this meeting for me: decisions, open questions and next steps, as short bullets.";
  const DEFAULT_MAX_PARALLEL = 2;
  let jobSeq = 0;
  const nextJobId = () => `j${++jobSeq}`;
  const jobThread = new Map(); // job id -> thread id, so every card event says which thread it belongs to

  let session = null;
  let endedAt = -Infinity;
  // A final or partial still in flight when the meeting stops must not open a new meeting.
  const justEnded = () => !session && now() - endedAt < 5000;

  const emit = (event) => {
    try {
      panel?.send(event);
    } catch {}
  };
  // Words being spoken arrive many times a second; the window only needs a few repaints a second.
  let partialTimer = null;
  let partialPending = null;
  const flushPartial = () => {
    partialTimer = null;
    if (partialPending) emit(partialPending);
    partialPending = null;
  };
  function sendPartial(event) {
    if (!event.text) {
      clearTimer(partialTimer);
      partialTimer = null;
      partialPending = null;
      return emit(event); // "nobody is talking" is never delayed
    }
    partialPending = event;
    partialTimer ??= setTimer(flushPartial, PARTIAL_EMIT_MS);
  }
  // COPILOT_LOG=1 (or COPILOT_DEBUG=1): a full per-session trace (transcript, scheduler verdicts,
  // defers, every D1 request/answer/error, summaries) in <logDir>/sessions/, for reading after a meeting.
  const verbose = env.COPILOT_LOG === "1" || env.COPILOT_DEBUG === "1";
  let traceFile = null;
  let sessionNo = 0;
  const trace = (record) => {
    if (!verbose || !logDir) return;
    try {
      if (!traceFile) {
        const dir = path.join(logDir, "sessions");
        fs.mkdirSync(dir, { recursive: true });
        traceFile = path.join(
          dir,
          `session-${new Date(now()).toISOString().replace(/[:.]/g, "-")}.jsonl`
        );
      }
      fs.appendFileSync(
        traceFile,
        JSON.stringify({ at: new Date(now()).toISOString(), session: sessionNo, ...record }) + "\n"
      );
    } catch {}
  };
  let d1 = null;
  const wrapD1 = (base) =>
    verbose
      ? {
          async systemOne(req) {
            const t0 = now();
            try {
              const res = await base.systemOne(req);
              trace({
                type: "d1",
                model: getDecisionEnv(env).model,
                state: req.state,
                questions: Object.keys(req.questions ?? {}),
                answers: res.answers,
                inputTokens: res.inputTokens,
                ms: now() - t0,
              });
              return res;
            } catch (error) {
              trace({ type: "d1_error", code: error.code, message: error.message, ms: now() - t0 });
              throw error;
            }
          },
        }
      : base;
  const log = (record) => {
    trace(record);
    if (!logFile) return;
    try {
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(
        logFile,
        JSON.stringify({ at: new Date(now()).toISOString(), ...record }) + "\n"
      );
    } catch {}
  };

  // Card events go to the panel; finished and failed cards also go to the log.
  let runner = null;
  function buildRunner() {
    return model
      ? createAnswerRunner({
          model,
          verify: createCardVerifier({ client: baseD1 }),
          now,
          emit(e) {
            if (e.type === "card_skip") {
              // The main model judged the moment not worth a card: D1 must not count it as handled,
              // and the user may still want it: it goes to the Skipped box.
              if (session) {
                session.cards = session.cards.filter((c) => c.jobId !== e.id);
                const sp = session.specs.get(e.id)?.spec;
                if (sp?.proactive) addSkipped(session, sp.gist ?? sp.focus, e.reason);
              }
              log({ type: "card_skip", id: e.id, reason: e.reason });
            }
            if (e.type === "card_done" && session)
              session.answerTokens += e.usage?.total_tokens ?? 0;
            if (e.type === "card_done" || e.type === "card_error") {
              log({
                type: e.type,
                id: e.id,
                title: e.title,
                confidence: e.confidence,
                sources: e.sources?.length,
                timing: e.timing,
                code: e.code,
                message: e.message,
              });
            }
            emit({ ...e, threadId: jobThread.get(e.id) ?? MAIN });
          },
        })
      : null;
  }

  function build() {
    const st = liveSettings();
    const keyEnv = { ...env, ...(st.apiKey ? { OPENROUTER_API_KEY: st.apiKey } : {}) };
    const dec = getDecisionEnv(keyEnv);
    baseD1 = client ?? (dec.apiKey ? createLiquidClient({ ...dec, timeoutMs: 5000 }) : null);
    d1 = baseD1 ? wrapD1(baseD1) : null;
    summaryLlm =
      llm ??
      (dec.apiKey
        ? createOpenRouterLlm({
            apiKey: dec.apiKey,
            model: st.summaryModel || env.COPILOT_SUMMARY_MODEL || DEFAULT_SUMMARY_MODEL,
          })
        : null);
    const ai = getCopilotAiConfig({
      ...keyEnv,
      COPILOT_AI_MODEL: st.mainModel || env.COPILOT_AI_MODEL || "",
      COPILOT_DEEP_MODEL: st.deepModel || env.COPILOT_DEEP_MODEL || "",
    });
    deepModelId = ai.deepModel;
    model =
      mainModel ??
      (env.COPILOT_MAIN !== "0" && ai.apiKey
        ? createMainModel({ apiKey: ai.apiKey, model: ai.model, now })
        : null);
    runner = buildRunner();
    active = !!d1;
  }

  // Starts the real main-model call for a job and keeps the job bookkeeping straight.
  // A high-effort rerun searches with a few other wordings of the question (one cheap call, in parallel with nothing else to wait for).
  async function expandQuery(question) {
    const r = await summaryLlm({
      messages: [
        {
          role: "system",
          content:
            "Write up to 3 short search queries (each at most 12 words) that would find, in the speaker's own documents, what is needed to answer the question. Use the key names, products, numbers and terms, and different wordings. One query per line, nothing else.",
        },
        { role: "user", content: question },
      ],
    });
    return String(r.text ?? "")
      .split("\n")
      .map((l) => l.replace(/^[-*\d.)\s]+/, "").trim())
      .filter(Boolean);
  }
  const threadOf = (s, id) => s.threads.get(id) ?? s.threads.get(MAIN);
  function startAnswer(s, job, spec) {
    const st = liveSettings();
    const thread = threadOf(s, job.threadId);
    jobThread.set(job.id, thread.id);
    job.queued = false;
    s.specs.set(job.id, { spec, threadId: thread.id, topic: job.topic });
    if (s.specs.size > MAX_SPECS) s.specs.delete(s.specs.keys().next().value);
    const handle = s.runner.run({
      id: job.id,
      ...spec,
      context: {
        meeting: { title: s.title },
        summary: s.summary.text,
        transcript: s.transcript.slice(-MODEL_TRANSCRIPT),
        contextSeconds: spec.contextSeconds,
        thread: thread.answers.filter((a) => a.id !== spec.of).slice(-3),
        instructions: st.instructions ?? "",
        plan: st.plan ?? "",
        reference: getReference() ?? "",
        behavior: st.behavior ?? "",
        catalog: hasIndex() ? (rag.catalog() ?? "") : "",
      },
      // The moment needs the project's own documents: find the matching passages before the model is called.
      // Runs inside the card's own time; the question's embedding was usually warmed while the decider ran.
      prepare:
        (spec.project || spec.projectAuto) && hasIndex()
          ? async () => {
              const r = await rag.retrieve({
                query: spec.focus,
                deep: !!spec.deep,
                why: spec.project
                  ? spec.proactive
                    ? "decider"
                    : spec.deep
                      ? "rerun"
                      : "asked"
                  : "auto",
                minScore: spec.project ? 0 : AUTO_SCORE,
                expand: spec.deep && summaryLlm ? expandQuery : null,
              });
              trace({
                type: "context",
                id: job.id,
                kept: r.used.length,
                skipped: r.skipped,
                ms: r.ms,
              });
              return { passages: r.text, files: [...new Set(r.used.map((u) => u.file))] };
            }
          : null,
    });
    job.handle = handle;
    handle.done.then((card) => {
      job.finished = true;
      if (card && !card.error && !card.skipped) {
        thread.answers.push({ id: job.id, title: card.title, body: card.body });
        if (thread.answers.length > MAX_THREAD_ANSWERS) thread.answers.shift();
      }
      jobThread.delete(job.id);
      s.side = s.side.filter((j) => j.id !== job.id); // a finished side job is no longer running
      pump(s);
    });
    return handle;
  }

  const runningReal = (s) =>
    [...s.jobs, ...s.side].filter((j) => j.real && !j.finished && !j.queued).length;
  // Typed questions wait when the parallel cap is full (Main's first); D1's own cards never wait.
  function launchAsked(s, job, spec) {
    const max = Number(liveSettings().maxParallel) || DEFAULT_MAX_PARALLEL;
    const full = runningReal(s) >= max;
    (job.threadId === MAIN ? s.jobs : s.side).push(job);
    if (full) {
      job.queued = true;
      s.queue.push({ job, spec });
      emit({
        type: "card_queued",
        id: job.id,
        threadId: job.threadId,
        focus: spec.focus,
        deliverable: spec.deliverable,
      });
      return;
    }
    startAnswer(s, job, spec);
  }
  function pump(s) {
    const max = Number(liveSettings().maxParallel) || DEFAULT_MAX_PARALLEL;
    while (s.queue.length && runningReal(s) < max) {
      const i = Math.max(
        0,
        s.queue.findIndex((q) => q.job.threadId === MAIN)
      );
      const [{ job, spec }] = s.queue.splice(i, 1);
      startAnswer(s, job, spec);
    }
  }
  // The recap runs on the ended session's own state; D1 and the scheduler are already stopped.
  function startRecap(s, focus) {
    const job = { id: nextJobId(), topic: "Meeting recap", real: true, threadId: MAIN };
    s.jobs = [job];
    startAnswer(s, job, {
      deliverable: "summary",
      tier: "fast",
      web: false,
      proactive: false,
      label: "Meeting recap",
      focus,
      contextSeconds: 0,
    });
  }
  const cancelJob = (s, id) => {
    const q = s.queue.findIndex((x) => x.job.id === id);
    if (q >= 0) {
      s.queue.splice(q, 1);
      emit({ type: "card_cancel", id, threadId: jobThread.get(id) ?? MAIN });
    }
    const job = [...s.jobs, ...s.side].find((j) => j.id === id);
    job?.handle?.cancel();
    if (job) job.finished = true;
    s.jobs = s.jobs.filter((j) => j.id !== id);
    s.side = s.side.filter((j) => j.id !== id);
    s.cards = s.cards.filter((c) => c.jobId !== id);
  };

  const setBusy = (s, d) => {
    const was = s.busy > 0;
    s.busy = Math.max(0, s.busy + d);
    if (s.busy > 0 !== was && session === s) emit({ type: "activity", busy: s.busy > 0 });
  };
  // A refused key or an empty account breaks every call silently: tell the window once, clear it when a call works again.
  const PROBLEM_OF = { 401: "key", 403: "key", 402: "credits" };
  function reportProblem(s, source, status) {
    if (session !== s) return;
    if (status !== 0 && !PROBLEM_OF[status]) return; // other failures are transient: leave things as they are
    s.problems[source] = status === 0 ? null : PROBLEM_OF[status];
    const kind = Object.values(s.problems).find(Boolean) ?? null;
    if (s.problem === kind) return;
    s.problem = kind;
    emit({ type: "problem", kind });
  }
  // ---- skipped moments: things D1 or the answer model passed on, one tap from being asked ----
  const emitSkipped = (s) =>
    emit({ type: "skipped", items: s.skipped.map(({ id, line, why }) => ({ id, line, why })) });
  function addSkipped(s, line, why) {
    if (session !== s) return;
    const text = clip(oneLine(line ?? ""), 200);
    const key = norm(text);
    const t = now();
    s.skipped = s.skipped.filter((i) => t - i.at < SKIPPED_TTL_MS);
    if (
      text.split(/\s+/).length < 4 ||
      s.asked.has(key) ||
      s.skipped.some((i) => norm(i.line) === key)
    )
      return;
    s.skipped.unshift({ id: `k${++s.skipSeq}`, line: text, why, at: t });
    s.skipped = s.skipped.slice(0, MAX_SKIPPED);
    emitSkipped(s);
  }
  const dropSkipped = (s, id) => {
    if (!s.skipped.some((i) => i.id === id)) return false;
    s.skipped = s.skipped.filter((i) => i.id !== id);
    emitSkipped(s);
    return true;
  };
  // Keeps a Set from growing for the whole meeting: oldest entries go first.
  const capSet = (set, max) => {
    while (set.size > max) set.delete(set.values().next().value);
  };

  // The call is ending (a closing phrase, or the calendar says so): one card with lines to say aloud.
  function maybeClose(s, text) {
    if (
      !s.runner ||
      liveSettings().closingCard === false ||
      s.transcript.length < CLOSING_MIN_SEGMENTS
    )
      return;
    const t = now();
    const byCue = CLOSING_CUE.test(text);
    const byClock = s.endsAt != null && t >= s.endsAt - CLOSING_BEFORE_END_MS;
    if (!byCue && !byClock) return;
    if (s.closingCount >= 2 || t - s.closingAt < CLOSING_GAP_MS) return;
    s.closingAt = t;
    s.closingCount++;
    const st = liveSettings();
    launchAsked(
      s,
      { id: nextJobId(), topic: "Wrapping up", real: true, threadId: MAIN },
      {
        deliverable: "closing",
        tier: "fast",
        web: false,
        proactive: false,
        label: "Wrapping up",
        focus: st.closingPrompt?.trim() || DEFAULT_CLOSING,
        contextSeconds: 0,
      }
    );
    log({ type: "closing", by: byCue ? "cue" : "clock" });
  }

  function startSession() {
    build();
    // Every meeting gets its own trace file, never a continuation of the last one.
    traceFile = null;
    sessionNo++;
    const s = {
      startedAt: now(),
      transcript: [],
      nextId: 0,
      lastDecidedId: 0,
      lastTriggerAt: null,
      lastRunAt: null,
      userSpeaking: false,
      systemPartial: null,
      cards: [],
      title: "Live meeting",
      threads: new Map([[MAIN, { id: MAIN, title: "Main", answers: [] }]]), // answers: finished cards, the history the main model sees
      side: [], // running jobs of custom threads
      queue: [], // typed questions waiting for a free slot
      nextThread: 0,
      runner,
      model,
      decisions: { run: 0, wait: 0, skip: 0, recheck: 0 },
      d1Calls: 0,
      tokens: 0,
      callMs: [],
      reactionMs: [],
      decisionCount: 0,
      jobs: [], // running jobs of the main thread (simulated ones without a main model): lets D1's replace/skip logic act
      holdSince: null,
      skipped: [], // { id, line, why, at }: moments passed on, offered in the "Skipped" box
      skipSeq: 0,
      asked: new Set(), // normalised lines already turned into cards or shown, never offered again
      quietStreak: 0, // decisions in a row that found nothing to act on
      specs: new Map(), // job id -> how it was asked, so "Rerun with high effort" can ask it again
      closingAt: -Infinity,
      closingCount: 0,
      endsAt: null, // when the meeting should end (calendar), for the closing card
      answerTokens: 0,
      summaryTokens: 0,
      busy: 0,
      problem: null,
      problems: {},
      partials: {}, // words still being spoken, per source: { label, text }
    };
    s.summary = createRollingSummary({
      llm: summaryLlm,
      label: speakerLabel,
      cfg: summaryCfg,
      now,
    });
    s.scheduler = createScheduler({
      run: (ctx) => runDecision(s, ctx),
      cfg: triggerCfg,
      now,
      setTimer,
      clearTimer,
      getQuiet: () => s.quietStreak >= QUIET_AFTER,
    });
    s.d1 = d1;
    session = s;
    log({ type: "session_start", model: getDecisionEnv(env).model });
    emit({ type: "session", state: "start", active, canAnswer: !!runner });
    panel?.open?.();
    // Notes the user wrote for this meeting: remind them of the plan right away.
    const st = liveSettings();
    if (runner && (st.plan ?? "").trim())
      launchAsked(
        s,
        { id: nextJobId(), topic: "Before the meeting", real: true, threadId: MAIN },
        {
          deliverable: "quick_answer",
          tier: "fast",
          web: false,
          proactive: false,
          label: "Before the meeting",
          focus: st.startPrompt?.trim() || DEFAULT_START,
          contextSeconds: decisionCfg.contextSeconds.fast,
        }
      );
    return s;
  }

  function stats(s = session) {
    if (!s) return null;
    return {
      segments: s.transcript.length,
      decisions: s.decisionCount,
      d1Calls: s.d1Calls,
      inputTokens: s.tokens, // D1 (decisions)
      answerTokens: s.answerTokens, // main model (cards), as reported by the provider
      avgTokensPerDecision: s.decisionCount ? Math.round(s.tokens / s.decisionCount) : null,
      callMsMedian: pctile(s.callMs, 0.5),
      callMsP90: pctile(s.callMs, 0.9),
      reactionMsMedian: pctile(s.reactionMs, 0.5),
      byKind: s.decisions,
      scheduler: { ...s.scheduler.stats, skipped: { ...s.scheduler.stats.skipped } },
      summary: { ...s.summary.stats, chars: s.summary.text.length },
      minutes: Math.round(((now() - s.startedAt) / 60000) * 10) / 10,
    };
  }
  const pushStats = (s) => emit({ type: "stats", stats: stats(s) });

  function deferred(s, reason, retryAfterMs) {
    trace({ type: "defer", reason, retryAfterMs: Math.round(retryAfterMs) });
    emit({ type: "defer", reason, retryAfterMs: Math.round(retryAfterMs) });
    pushStats(s);
    return { kind: "defer", retryAfterMs };
  }

  // The harness has no main model, so a "run" decision stands in for one: it occupies a simulated job
  // for a while, which makes D1 judge new text against a running analysis (replace it, or leave it).
  const SIM_JOB_MS = {
    fast: Number(env.COPILOT_SIM_JOB_MS) || 5000,
    reasoning: (Number(env.COPILOT_SIM_JOB_MS) || 5000) * 2.5,
  };
  function runningJobs(s) {
    const t = now();
    s.jobs = s.jobs.filter((j) => {
      if (j.real ? !j.finished : j.endsAt > t) return true;
      trace({ type: "job_done", id: j.id });
      return false;
    });
    return s.jobs;
  }

  async function runDecision(s, ctx) {
    const fresh = s.transcript.filter((seg) => seg.id > s.lastDecidedId);
    if (!fresh.length) return null;
    const lastId = s.transcript[s.transcript.length - 1].id;
    const newText = fresh.map((seg) => `${speakerLabel(seg)}: ${seg.text}`).join(" ");
    // Not the time yet: nothing is judged and the text stays pending (the scheduler retries).
    // Asking D1 first and then dropping the answer would throw the moment away for good.
    const running = runningJobs(s);
    const cooldownMs = decisionCfg.cooldownMs;
    {
      const sinceCard = s.lastRunAt == null ? Infinity : now() - s.lastRunAt;
      // With an analysis running, new words may have to replace it, so the cooldown does not apply.
      if (sinceCard < cooldownMs && !running.length)
        return deferred(s, "cooldown", cooldownMs - sinceCard + 50);
      // Holding is for someone else's words while the user talks; the user's own lines are the point.
      // Capped, or a long talker would starve everything the others say.
      const othersOnly = fresh.every((seg) => seg.source !== "mic");
      if (s.userSpeaking && othersOnly && decisionCfg.holdWhileUserSpeaking) {
        s.holdSince ??= now();
        if (now() - s.holdSince < decisionCfg.holdMaxMs) return deferred(s, "user_speaking", 800);
      }
    }
    s.holdSince = null;
    const input = {
      now: now(),
      meeting: { title: s.title },
      summary: s.summary.text,
      transcript: s.transcript,
      newFromId: fresh[0].id,
      partial: s.systemPartial,
      recentCards: s.cards.filter(
        (c) =>
          now() - c.shownAt < (c.weak ? decisionCfg.weakCardMemoryMs : decisionCfg.cardMemoryMs)
      ),
      running,
      settings: decisionSettings(),
      projectFiles: hasIndex() ? (rag.catalogLines?.() ?? []) : [],
      signals: {
        endpoint: true,
        userSpeaking: s.userSpeaking,
        sinceLastCardMs: s.lastRunAt == null ? null : now() - s.lastRunAt,
        waitedMs: ctx.waitedMs,
      },
    };

    // Warm the project search while the decider thinks (about a second): its embedding is then ready when it says "needs the files".
    if (hasIndex()) rag.prefetch(newText);
    const started = now();
    setBusy(s, 1);
    const decision = await decide({ input, client: s.d1, cfg: decisionCfg }).finally(() =>
      setBusy(s, -1)
    );
    const finished = now();
    // The meeting ended while D1 was thinking: its answer belongs to nobody.
    if (session !== s) return null;
    if (decision.error) reportProblem(s, "d1", decision.error.status);
    else if (decision.latency.gateMs != null) reportProblem(s, "d1", 0);

    // An update check that found nothing to replace judged nothing else: the text stays pending
    // for when the cooldown ends.
    const unjudged = decision.updateCheck && decision.kind === "wait";
    if (decision.kind !== "recheck" && !unjudged) s.lastDecidedId = lastId;
    s.decisionCount++;
    s.d1Calls += decision.latency.fullMs != null ? 2 : 1;
    s.tokens += decision.inputTokens;
    s.callMs.push(finished - started);
    if (s.lastTriggerAt != null) s.reactionMs.push(finished - s.lastTriggerAt);
    if (s.callMs.length > MAX_TIMINGS) s.callMs.shift();
    if (s.reactionMs.length > MAX_TIMINGS) s.reactionMs.shift();
    s.decisions[decision.kind] = (s.decisions[decision.kind] ?? 0) + 1;
    s.quietStreak =
      decision.kind === "wait" && (decision.raw?.act ?? 0) < 0.25 ? s.quietStreak + 1 : 0;
    // What the moment is about: the substantive words, not the "yeah"s that rode along. Same-voice lines are one
    // utterance (the recogniser cuts a sentence mid-word); a question wins, else the longest utterance.
    const utterances = toUtterances(
      fresh.filter((x) => !x.noise),
      speakerLabel
    );
    const pick =
      utterances.filter((u) => u.text.includes("?")).at(-1) ??
      utterances.reduce((a, b) => (b.text.length > (a?.text.length ?? 0) ? b : a), null);
    // A moment D1 judged worth a look but not worth a card right now: the user may still want it.
    if (
      (!decision.error || realQuestion(pick.text)) && // a failed decision still leaves a real question for the box
      !unjudged &&
      (decision.kind === "wait" || decision.kind === "skip") &&
      pick &&
      ((decision.reasons?.some((r) => SKIP_REASON.test(r)) &&
        (realQuestion(pick.text) || (decision.raw?.act ?? 0) >= 0.25)) ||
        (decision.reasons?.some((r) => UNJUDGED.test(r)) && realQuestion(pick.text)))
    )
      addSkipped(
        s,
        pick.text,
        decision.reasons.find((r) => SKIP_REASON.test(r) || UNJUDGED.test(r))
      );
    if (decision.kind === "run") {
      s.lastRunAt = finished;
      // A replaced analysis is cancelled and its card dropped; the new one stands in its place.
      const jobsBefore = s.jobs;
      if (decision.cancelJobId) {
        s.jobs.find((j) => j.id === decision.cancelJobId)?.handle?.cancel();
        s.jobs = s.jobs.filter((j) => j.id !== decision.cancelJobId);
        s.cards = s.cards.filter((c) => c.jobId !== decision.cancelJobId);
        trace({ type: "job_cancel", id: decision.cancelJobId });
      }
      let gist = pick?.text ?? newText;
      // A replacement that only continues the old ask keeps the old words ("…compute-limited?" + "Idea-limited?").
      const old = decision.cancelJobId && jobsBefore.find((j) => j.id === decision.cancelJobId);
      if (old && gist.length < 40) gist = `${old.topic} ${gist}`;
      const job = {
        id: nextJobId(),
        topic: clip(gist, 70),
        status: "running",
        threadId: MAIN,
        ...(s.model ? { real: true } : { endsAt: finished + SIM_JOB_MS[decision.tier] }),
      };
      s.jobs.push(job);
      trace({ type: "job_start", id: job.id, topic: job.topic, tier: decision.tier });
      if (s.model)
        startAnswer(s, job, {
          deliverable: decision.deliverable,
          tier: decision.tier,
          web: webOn() && !["summary", "talking_points"].includes(decision.deliverable),
          project: !!decision.needs?.project,
          projectAuto: !decision.needs?.project, // the files are still looked at when something matches closely (no model call)
          proactive: decision.trigger !== "explicit",
          gist,
          focus: newText,
          contextSeconds: decision.contextSeconds,
        });
      s.cards = [
        ...s.cards,
        {
          kind: decision.deliverable,
          gist: clip(gist, 90),
          shownAt: finished,
          reaction: "none",
          jobId: job.id,
          weak: decision.trigger !== "explicit" && decision.confidence < decisionCfg.weakCardBelow,
        },
      ].slice(-2);
    }

    const record = {
      type: "decision",
      newText: clip(newText, 300),
      newSegments: fresh.length,
      ids: [fresh[0].id, lastId],
      decision: {
        kind: decision.kind,
        trigger: decision.trigger,
        deliverable: decision.deliverable,
        tier: decision.tier,
        needs: decision.needs,
        thread: decision.thread,
        offers: decision.offers,
        cancelJobId: decision.cancelJobId,
        contextSeconds: decision.contextSeconds,
        confidence: decision.confidence,
        reasons: decision.reasons,
        raw: decision.raw,
      },
      latency: decision.latency,
      inputTokens: decision.inputTokens,
      callMs: finished - started,
      reactionMs: s.lastTriggerAt != null ? finished - s.lastTriggerAt : null,
      summaryChars: s.summary.text.length,
      attempt: ctx.waitedMs ? "recheck" : "first",
    };
    log(record);
    emit({ type: "decision", ...record });
    pushStats(s);
    if (unjudged) {
      const left = decisionCfg.cooldownMs - (now() - s.lastRunAt);
      return { kind: "defer", retryAfterMs: Math.max(left, 0) + 50 };
    }
    return decision;
  }

  const api = {
    stats: () => stats(),
    // What the app knows about this meeting (calendar title, when it should end); set at the start or later.
    setMeeting({ title, endsAt } = {}) {
      const s = session;
      if (!s) return;
      if (typeof title === "string" && title.trim()) s.title = clip(oneLine(title), 80);
      if (Number.isFinite(endsAt)) s.endsAt = endsAt;
      emit({ type: "meeting", title: s.title, endsAt: s.endsAt });
    },
    // Sizes of everything that can grow, for the memory probe.
    // 👎 on a card (or its undo): a signal for the global behaviour guide, nothing is kept here.
    noteFeedback(id, value) {
      const spec = session?.specs.get(id)?.spec;
      if (!spec) return;
      onSignal(
        value === "down" ? "down" : "undo",
        clip(oneLine(spec.gist ?? spec.focus ?? ""), 160)
      );
    },
    memory() {
      const s = session;
      if (!s) return null;
      return {
        transcript: s.transcript.length,
        cards: s.cards.length,
        jobs: s.jobs.length,
        side: s.side.length,
        queue: s.queue.length,
        specs: s.specs.size,
        asked: s.asked.size,
        skipped: s.skipped.length,
        callMs: s.callMs.length,
        threads: [...s.threads.values()].map((t) => t.answers.length),
        jobThread: jobThread.size,
      };
    },
    // Meeting note taking started: open the panel now. D1 is still only called after the first segment.
    begin() {
      if (!session) startSession();
    },
    // One FINAL segment, only those actually sent to the renderer.
    onFinal({ text, source, timestamp, speaker }) {
      const clean = String(text ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (!clean || justEnded()) return;
      const s = session ?? startSession();
      const seg = {
        id: ++s.nextId,
        source,
        speaker,
        text: clean,
        at: timestamp ?? now(),
        final: true,
      };
      s.transcript.push(seg);
      if (s.transcript.length > MAX_TRANSCRIPT) s.transcript.shift();
      s.partials[source] = null;
      if (source === "mic") s.userSpeaking = false;
      else s.systemPartial = null;
      const verdict = active ? s.scheduler.noteFinal(seg) : { trigger: false, reason: "no_key" };
      seg.noise = !verdict.trigger; // filler and fragments stay in the transcript but not in what D1 judges
      if (verdict.trigger) s.lastTriggerAt = now();
      trace({
        type: "segment",
        id: seg.id,
        source,
        speaker,
        text: clean,
        trigger: verdict.trigger,
        reason: verdict.reason ?? null,
      });
      emit({
        type: "segment",
        id: seg.id,
        source,
        at: seg.at,
        label: speakerLabel(seg),
        text: clean,
        trigger: verdict.trigger,
        reason: verdict.reason ?? "candidate",
      });
      const update = active && summaryLlm ? s.summary.maybeUpdate(s.transcript) : null;
      update?.then((r) => {
        if (!r) return;
        log({
          type: "summary",
          chars: r.text.length,
          covered: r.covered,
          skipped: r.skipped,
          calls: r.calls,
          ms: s.summary.stats.lastMs,
          text: r.text,
        });
        emit({ type: "summary", text: r.text, stats: s.summary.stats });
        pushStats(s);
      });
      if (active) maybeClose(s, clean);
      pushStats(s);
    },
    onPartial({ source, text }) {
      if (justEnded()) return;
      const s = session ?? startSession();
      if (active) s.scheduler.notePartial(source);
      const lastOf = s.transcript.findLast((g) => g.source === source);
      const who = source === "mic" ? "USER" : lastOf ? speakerLabel(lastOf) : "OTHER";
      s.partials[source] = text ? { label: who, text } : null;
      if (source === "mic") {
        if (s.userSpeaking !== !!text) trace({ type: "user_speaking", on: !!text });
        s.userSpeaking = !!text;
      } else s.systemPartial = text ? { source, text } : null;
      sendPartial({ type: "partial", label: who, text: text ?? "" });
    },
    // The user typed a question: straight to the main model, no decision (brief section 3).
    // `quote` = meeting lines the user picked in the transcript to talk about.
    ask({ text, web = false, threadId = MAIN, quote = "", skippedId = "" }) {
      const clean = String(text ?? "").trim();
      if (!clean) return false;
      const s = session ?? startSession();
      if (!s.runner) return false;
      const th = s.threads.has(threadId) ? threadId : MAIN;
      s.asked.add(norm(clean));
      capSet(s.asked, MAX_ASKED);
      if (skippedId) {
        const item = s.skipped.find((i) => i.id === skippedId);
        if (item) onSignal("wanted", item.line); // the user wanted a moment the copilot had passed on
        dropSkipped(s, skippedId);
      }
      const focus = quote ? `${clean}\n(Regarding: "${clip(oneLine(quote), 400)}")` : clean;
      const job = {
        id: nextJobId(),
        topic: clip(clean, 70),
        status: "running",
        real: true,
        threadId: th,
      };
      if (th === MAIN) {
        s.lastRunAt = now();
        s.cards = [
          ...s.cards,
          {
            kind: "quick_answer",
            gist: clip(clean, 90),
            shownAt: now(),
            reaction: "none",
            jobId: job.id,
            weak: false,
          },
        ].slice(-2);
      }
      launchAsked(s, job, {
        deliverable: "quick_answer",
        tier: "fast",
        web: web || webOn(),
        project: true, // a typed question may be about the project's files; the search skips itself when there are none
        proactive: false,
        focus,
        contextSeconds: decisionCfg.contextSeconds.fast,
      });
      return job.id;
    },
    // "Rerun with high effort": ask the same thing again on the deep model (web search and any other tool), as a new card below.
    rerun(id) {
      const s = session;
      const prev = s?.specs.get(id);
      if (!s || !prev || !s.runner) return false;
      const job = {
        id: nextJobId(),
        topic: prev.topic,
        status: "running",
        real: true,
        threadId: prev.threadId,
        of: id,
        deep: true,
      };
      launchAsked(s, job, {
        ...prev.spec,
        tier: "deep",
        web: true,
        proactive: false,
        auto: false,
        project: true, // high effort always looks in the project files
        deep: true,
        of: id,
        model: deepModelId,
        label: "High-effort answer",
      });
      return job.id;
    },
    cancel(id) {
      if (!session) return;
      // a dismissed skipped moment shares this call: its ids start with "k"
      if (!dropSkipped(session, id)) cancelJob(session, id);
    },
    createThread({ title, auto = false } = {}) {
      const s = session ?? startSession();
      const id = `t${++s.nextThread}`;
      const thread = {
        id,
        title: clip(String(title ?? "").trim(), 40) || `Thread ${s.nextThread}`,
        answers: [],
      };
      s.threads.set(id, thread);
      emit({
        type: "thread",
        action: "create",
        thread: { id, title: thread.title, ...(auto ? { auto: true } : {}) },
      });
      return id;
    },
    renameThread(id, title) {
      const th = session?.threads.get(id);
      const t = clip(String(title ?? "").trim(), 40);
      if (!th || id === MAIN || !t) return false;
      th.title = t;
      emit({ type: "thread", action: "rename", thread: { id, title: t } });
      return true;
    },
    closeThread(id) {
      const s = session;
      if (!s || id === MAIN || !s.threads.has(id)) return false;
      for (const j of [...s.side, ...s.queue.map((q) => q.job)].filter((j) => j.threadId === id))
        cancelJob(s, j.id);
      s.threads.delete(id);
      emit({ type: "thread", action: "close", thread: { id } });
      return true;
    },
    // Meeting over: stop everything, then (once) a recap card in Main if the user wants one.
    endSession() {
      if (!session) return;
      const s = session;
      for (const j of [...s.jobs, ...s.side]) j.handle?.cancel();
      s.queue = [];
      session = null;
      endedAt = now();
      clearTimer(partialTimer);
      partialTimer = null;
      partialPending = null;
      s.scheduler.stop();
      log({ type: "session_end", stats: stats(s) });
      emit({ type: "session", state: "end", stats: stats(s), summary: s.summary.text });
      const st = liveSettings();
      if (s.runner && st.endRecap !== false && s.transcript.length >= 6)
        startRecap(s, st.endPrompt?.trim() || DEFAULT_END);
    },
  };
  panel?.onAsk?.((q) => api.ask(q));
  return api;
}

module.exports = { createEngine };
