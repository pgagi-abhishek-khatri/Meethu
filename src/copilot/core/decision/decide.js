// One decision = one D1 call, then pure policy. Never throws: any failure becomes a quiet "wait".
const { DEFAULT_DECISION_CONFIG } = require("./config");
const { buildDecisionState } = require("./buildState");
const { buildQuestions } = require("./questions");
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

async function decide({ input, client, cfg = DEFAULT_DECISION_CONFIG }) {
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
      ...fallbackDecision(false, error.code ?? "error"),
      error: { code: error.code, status: error.status ?? null },
      latency,
      inputTokens: 0,
    };
  }
}

module.exports = { decide, DEFAULT_SETTINGS };
