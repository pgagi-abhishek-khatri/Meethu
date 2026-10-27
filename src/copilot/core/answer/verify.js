// Second look at a finished proactive card, by the fast classifier (D1) instead of the answer model: the answer
// model, run without thinking, restates what was just said or pads with background even when told not to.
// Measured on 41 real-meeting cards and 55 written ones (graded by two judges): "does the card add something new"
// >= 0.85 kept 53 of 57 good cards and removed 19 of 32 weak ones (AUC 0.82; 0.80 on the real cards alone).
const { speakerLabel, clip, oneLine } = require("../decision/buildState");
const { toUtterances } = require("../transcript/utterances");

const VERIFY_CONFIG = { addsMin: 0.8, contextLines: 6, cardChars: 900, newTextChars: 500 };

const ADDS = {
  type: "noul",
  instructions:
    "Does the card tell the USER something that is not already said in new_text or context: a fact, number, definition, check or answer?",
};

function buildVerifyState({ transcript, focus, card }, cfg = VERIFY_CONFIG) {
  return {
    about: "A silent meeting assistant wrote a card for the USER about new_text. Judge the card.",
    context: toUtterances(transcript.slice(-cfg.contextLines * 2 - 1, -1), speakerLabel)
      .slice(-cfg.contextLines)
      .map((s) => `${s.label}: ${clip(oneLine(s.text), 300)}`),
    new_text: clip(oneLine(focus), cfg.newTextChars),
    card: clip(oneLine(`${card.title}: ${card.body}`), cfg.cardChars),
  };
}

// -> async ({transcript, focus, card}) => { ok, adds }. A failure of the verifier never blocks a card.
function createCardVerifier({ client, cfg = VERIFY_CONFIG }) {
  return async function verify(input) {
    try {
      const r = await client.systemOne({
        state: buildVerifyState(input, cfg),
        questions: { adds: ADDS },
      });
      const adds = r.answers?.adds?.noul;
      if (typeof adds !== "number") return { ok: true, adds: null };
      return { ok: adds >= cfg.addsMin, adds };
    } catch {
      return { ok: true, adds: null };
    }
  };
}

module.exports = { createCardVerifier, buildVerifyState, VERIFY_CONFIG };
