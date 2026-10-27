// What the models read of the transcript. The provider cuts segments at a size limit, not at the end of a
// thought (a 15 s speech becomes four "segments", sometimes cut mid-word), and every "Yeah." from the
// listener is a segment of its own. Models are billed per token and read cut-up text worse, so before any
// LLM call: drop backchannel, then glue consecutive segments of one speaker into one utterance.
// The raw segments stay untouched for the transcript view and the database. Pure.
const BACKCHANNEL =
  /^(yeah|yes|yep|yup|okay|ok|right|sure|mm+|mhm|mm-hmm|uh-huh|uh+|um+|hmm+|huh|you|thanks|thank you|got it|alright|cool|great|exactly|correct|i see|no|nope|fine|good|nice|perfect|wow|oh|ah)([\s,.!?—-]+(yeah|yes|yep|right|okay|ok|sure|uh-huh|mm-hmm|mhm|cool|great|exactly|got it))*[\s.,!?—-]*$/i;
const TERMINAL = /[.?!…]["')\]]*$/;

const isBackchannel = (text) => {
  const t = String(text ?? "").trim();
  return !t || (!t.includes("?") && t.length <= 40 && BACKCHANNEL.test(t));
};

// `label(seg)` names the speaker; two segments of one label are one voice.
// A merged utterance stops growing at MAX_MERGED chars, so one long speech stays a few readable pieces and the
// newest words never fall off the end of a clipped line.
const MAX_MERGED = 600;

function toUtterances(segments, label) {
  const out = [];
  for (const seg of segments) {
    if (isBackchannel(seg.text)) continue;
    const who = label(seg);
    const last = out.at(-1);
    // Same voice, and the last piece did not end a sentence (or it did not end at all): one utterance.
    if (
      last &&
      last.label === who &&
      !TERMINAL.test(last.text) &&
      last.text.length + seg.text.length < MAX_MERGED
    ) {
      last.text = `${last.text} ${seg.text}`.replace(/\s+/g, " ");
      last.id = seg.id;
      last.at = seg.at ?? last.at;
      last.noise = last.noise && seg.noise;
      continue;
    }
    out.push({ ...seg, label: who });
  }
  return out;
}

// "…right?", "okay?", "you know?" end half the sentences of a talker and ask nothing. A real question is a sentence that
// ends in "?", is not a tag on a statement, and has four words or more.
const TAG =
  /[,;:—-]?\s*(?:right|okay|ok|yeah|yes|no|you know|correct|isn't it|doesn't it|aren't they|haan|na|hai na|yeah)\s*\?$/i;
function realQuestion(text) {
  return String(text ?? "")
    .split(/(?<=[.!?…])\s+/)
    .some(
      (s) => s.trim().endsWith("?") && !TAG.test(s.trim()) && s.trim().split(/\s+/).length >= 4
    );
}

// Lenient: any question except a tag on a statement ("…, right?"). Short ones ("Why?") count.
const questionish = (text) => {
  const t = String(text ?? "").trim();
  return t.includes("?") && !(t.endsWith("?") && TAG.test(t) && t.split(/\s+/).length > 2);
};

module.exports = { questionish, realQuestion, isBackchannel, toUtterances, BACKCHANNEL, TERMINAL };
