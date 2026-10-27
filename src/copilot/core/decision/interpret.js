// Turns D1's answers into a decision. Pure and deterministic: all policy (quiet level, cooldown,
// thresholds, fallbacks) lives here so it can be tuned and unit tested without calling the model.
// Anything missing or malformed means "wait": proactive calls fail quietly, never guess.
const isProb = (v) => typeof v === "number" && v >= 0 && v <= 1;
const noulOf = (answers, name) => {
  const a = answers?.[name];
  return a?.type === "noul" && isProb(a.noul) ? a.noul : null;
};
// Returns the chosen option only if it is one we offered.
const choiceOf = (answers, name, offered) => {
  const a = answers?.[name];
  if (a?.type !== "choice" || !a.probabilities || !(a.choice in offered)) return null;
  return {
    key: a.choice,
    entry: offered[a.choice],
    p: a.probabilities[a.choice] ?? 0,
    confidence: isProb(a.confidence) ? a.confidence : 0,
    probabilities: a.probabilities,
  };
};
const pct = (v) => Math.round(v * 100);
const RICH = new Set(["diagram", "document"]);
const PLAIN = ["quick_answer", "explanation", "talking_points"];
const top = (probabilities, keys) =>
  keys.filter((k) => k in probabilities).sort((a, b) => probabilities[b] - probabilities[a])[0];

const NO_NEEDS = { web: false, project: false, pastMeetings: false, screenshot: false };

function runDecision({ cfg, plan, answers, explicit, act, kind, cancelJobId, reasons, raw }) {
  const kinds = answers.kind;
  const offers = [];
  if (RICH.has(kind) && !explicit) {
    const p = kinds?.probabilities?.[kind] ?? 0;
    if (p < cfg.proactiveRichMin) {
      if (p >= cfg.offerMin) offers.push(kind); // a button, not a call
      reasons.push(
        `${kind} ${pct(p)}% < ${pct(cfg.proactiveRichMin)}%: ${p >= cfg.offerMin ? "offered" : "dropped"}`
      );
      kind = top(kinds.probabilities, PLAIN) ?? "quick_answer";
    }
  }
  const needs = { ...NO_NEEDS };
  for (const { name, key } of plan.needs) {
    const p = noulOf(answers.raw, name);
    if (p != null && p >= cfg.needThreshold[key]) {
      needs[key] = true;
      reasons.push(`${key} ${pct(p)}%`);
    }
  }
  const tier = RICH.has(kind) ? "reasoning" : "fast";
  reasons.push(`${kind}, ${tier}`);
  return {
    kind: "run",
    trigger: explicit ? "explicit" : "proactive",
    timing: cancelJobId ? "supersede" : "now",
    cancelJobId,
    deliverable: kind,
    offers,
    tier,
    needs,
    thread: { kind: "main" },
    contextSeconds: cfg.contextSeconds[tier],
    confidence: explicit ? 1 : act,
    reasons,
    raw,
  };
}

function interpret(rawAnswers, plan, ctx, cfg) {
  const asked = noulOf(rawAnswers, "asked_of_assistant");
  const relation = plan.askedRelation ? choiceOf(rawAnswers, "relation", plan.relation) : null;
  const relEntry =
    relation && relation.confidence >= cfg.choiceMinConfidence ? relation.entry : null;
  // "Explicit" bypasses every quiet rule, so the model's word is not enough: the USER must have
  // spoken in new_text (an earlier request in the context can fool D1).
  const explicit = (asked ?? 0) >= cfg.explicitThreshold && !!ctx.userInNew;
  const raw = {
    asked_of_assistant: asked,
    act: noulOf(rawAnswers, "act"),
    relation: relation && [relation.key, relation.p],
  };
  const reasons = [];
  const supersede =
    relEntry?.kind === "supersede" && relation.p >= cfg.replaceMin ? relEntry.jobId : undefined;
  if (supersede) reasons.push(`replaces running ${supersede}`);
  if (explicit) reasons.push(`user asked the assistant (${pct(asked)}%)`);

  // Inside the cooldown with a running analysis: only an outright request or a change to it counts.
  if (ctx.updateCheck) {
    if (asked == null && !relation)
      return { kind: "wait", reasons: ["invalid_answer:update_check"], raw };
    const u = {
      cfg,
      plan,
      answers: { kind: null, raw: rawAnswers },
      explicit,
      act: 1,
      kind: "quick_answer",
      cancelJobId: supersede,
      reasons,
      raw,
    };
    if (explicit || supersede) return { ...runDecision(u), updateCheck: true };
    return {
      kind: "wait",
      updateCheck: true,
      reasons: [`cooldown: no change to the running analysis, asked ${pct(asked ?? 0)}%`],
      raw,
    };
  }

  const substance = noulOf(rawAnswers, "act");
  const chatter = noulOf(rawAnswers, "chatter");
  const help = noulOf(rawAnswers, "help");
  const act =
    substance == null || chatter == null || help == null ? null : substance * (1 - chatter) * help;
  raw.act = act;
  const complete = noulOf(rawAnswers, "complete");
  const kind = choiceOf(rawAnswers, "kind", Object.fromEntries(plan.kinds.map((k) => [k, k])));
  if (act == null || complete == null || asked == null || !kind)
    return {
      kind: "wait",
      reasons: [
        "invalid_answer:" +
          (act == null
            ? "act/chatter/help"
            : complete == null
              ? "complete"
              : asked == null
                ? "asked_of_assistant"
                : "kind"),
      ],
      raw,
    };

  const unfinished = !(ctx.signals.endpoint || complete >= cfg.textCompleteThreshold);
  const canWait = unfinished && (ctx.signals.waitedMs ?? 0) < cfg.maxWaitForCompleteMs;
  const recheck = (why) => ({
    kind: "recheck",
    recheckAfterMs: cfg.recheckAfterMs,
    reasons: [...reasons, `act ${pct(act)}%`, why],
    raw,
  });
  reasons.unshift(`act ${pct(act)}%`);
  const chosen =
    kind.confidence >= cfg.choiceMinConfidence ? kind.key : top(kind.probabilities, plan.kinds);
  const go = (extra = {}) =>
    runDecision({
      cfg,
      plan,
      answers: { kind, raw: rawAnswers },
      explicit,
      act,
      kind: chosen,
      cancelJobId: supersede,
      reasons,
      raw,
      ...extra,
    });

  if (explicit) return canWait ? recheck(`unfinished (complete ${pct(complete)}%)`) : go();

  // Holding is for other people's words while the user talks; the user's own lines are judged.
  if (ctx.signals.userSpeaking && cfg.holdWhileUserSpeaking && !ctx.userInNew)
    return { kind: "wait", reasons: [...reasons, "user_speaking"], raw };
  // New words that change a running analysis redo it, whatever else they are worth.
  if (supersede) return go();
  if (ctx.signals.sinceLastCardMs != null && ctx.signals.sinceLastCardMs < cfg.cooldownMs)
    return { kind: "wait", reasons: [...reasons, "cooldown"], raw };
  if (act < cfg.actThreshold[ctx.settings.quiet]) {
    // Half a sentence scores low only because it is half a sentence: look again when it ends.
    if (canWait && act >= cfg.actThreshold[ctx.settings.quiet] * cfg.recheckBarFactor)
      return recheck(`unfinished (complete ${pct(complete)}%)`);
    return { kind: "wait", reasons: [...reasons, `below_bar_${ctx.settings.quiet}`], raw };
  }
  if (relEntry?.kind === "covered" && relation.p >= cfg.alreadyHandledThreshold)
    return { kind: "skip", reasons: [...reasons, `already_handled ${pct(relation.p)}%`], raw };
  if (canWait) return recheck(`unfinished (complete ${pct(complete)}%)`);
  return go();
}

// D1 unreachable. A proactive decision stays quiet; an explicit request cannot be known without D1.
function fallbackDecision(explicit, errorCode) {
  const reasons = [`decision_unavailable:${errorCode}`];
  if (!explicit) return { kind: "wait", reasons };
  return {
    kind: "run",
    trigger: "explicit",
    timing: "now",
    deliverable: "quick_answer",
    offers: [],
    tier: "fast",
    needs: { ...NO_NEEDS },
    thread: { kind: "main" },
    contextSeconds: 120,
    confidence: 1,
    reasons: [...reasons, "explicit request: default settings"],
  };
}

module.exports = { interpret, fallbackDecision };
