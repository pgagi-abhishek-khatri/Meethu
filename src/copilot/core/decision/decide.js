// One decision = one D1 call, then pure policy. Never throws: any failure becomes a quiet "wait".
const { DEFAULT_DECISION_CONFIG } = require("./config");
const { buildDecisionState } = require("./buildState");
const { buildQuestions, PROJECT_QUESTION } = require("./questions");
const { interpret, fallbackDecision } = require("./interpret");

const DEFAULT_SETTINGS = {
  quiet: "normal", // quiet | normal | chatty
  web: true,
  projectFiles: false,
  pastMeetings: false,
  screenshot: false,
  diagrams: true,
  documents: true,
};

async function decide({ input: given, client, cfg = DEFAULT_DECISION_CONFIG }) {
  // Two calls (cfg.ragTrigger "twoCall"): this one judges the card alone; whether the files are needed is
  // asked by checkProjectNeed() once a card runs. So it carries neither the question nor the file list.
  const twoCall = cfg.ragTrigger === "twoCall";
  const input = twoCall
    ? { ...given, projectFiles: [], settings: { ...given.settings, projectFiles: false } }
    : given;
  const settings = { ...DEFAULT_SETTINGS, ...input.settings };
  const ctx = {
    settings,
    running: input.running ?? [],
    signals: input.signals ?? {},
    userInNew: (input.transcript ?? []).some((s) => s.id >= input.newFromId && s.source === "mic"),
    hasCards: !!input.recentCards?.length,
  };
  // Inside the card cooldown only a change to a running analysis, or an outright request, can still matter.
  const since = ctx.signals.sinceLastCardMs;
  ctx.updateCheck = ctx.running.length > 0 && since != null && since < cfg.cooldownMs;
  const latency = { gateMs: null, fullMs: null };
  const { questions, plan } = buildQuestions(ctx);
  try {
    const call = await client.systemOne({ state: buildDecisionState(input, cfg), questions });
    latency.gateMs = call.ms;
    return {
      ...interpret(call.answers, plan, ctx, cfg),
      latency,
      inputTokens: call.inputTokens ?? 0,
    };
  } catch (error) {
    return {
      ...fallbackDecision(false, error.code ?? "error", ctx, error.status ?? null),
      error: { code: error.code, status: error.status ?? null },
      latency,
      inputTokens: 0,
    };
  }
}

// The second call of "twoCall": the same state with the file list, one question: are the files needed?
// -> { need, p, ms, inputTokens, error }. Never throws: a failed call means no search.
async function checkProjectNeed({ input, client, cfg = DEFAULT_DECISION_CONFIG }) {
  try {
    const call = await client.systemOne({
      state: buildDecisionState(input, cfg),
      questions: { needs_project: { type: "noul", instructions: PROJECT_QUESTION } },
    });
    const a = call.answers?.needs_project;
    const p = a?.type === "noul" && typeof a.noul === "number" ? a.noul : null;
    return {
      need: p != null && p >= cfg.needThreshold.project,
      p,
      ms: call.ms,
      inputTokens: call.inputTokens ?? 0,
      error: p == null ? "invalid_answer" : null,
    };
  } catch (error) {
    return { need: false, p: null, ms: null, inputTokens: 0, error: error.code ?? "error" };
  }
}

module.exports = { decide, checkProjectNeed, DEFAULT_SETTINGS };
