// Turns the live meeting situation into the compact JSON `state` D1 evaluates.
// Pure. D1 bills every question for the whole state, so tokens here are multiplied
// by the number of questions: only what a judgement needs goes in, and the old
// transcript is replaced by a short rolling summary (see ../summary).
const clip = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
const oneLine = (text) =>
  String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();

// mic = the user (wearing the copilot). system = everyone else; "system:2" -> OTHER-2.
function speakerLabel(segment) {
  if (segment.source === "mic") {
    // The mic also hears people next to the user; the first voice on it is taken to be the user.
    const m = /:(\d+)$/.exec(segment.speaker ?? "")?.[1];
    return m && m !== "1" ? `NEARBY-${m}` : "USER";
  }
  const n = /:(\d+)$/.exec(segment.speaker ?? "")?.[1];
  return n ? `OTHER-${n}` : "OTHER";
}

const line = (segment, max) =>
  `${segment.label ?? speakerLabel(segment)}: ${clip(oneLine(segment.text), max)}`;

// Keeps the newest lines that fit the character budget.
function fitNewest(lines, budget) {
  const kept = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (used + lines[i].length > budget && kept.length) break;
    kept.unshift(lines[i]);
    used += lines[i].length;
  }
  return kept;
}

function splitNewAndContext(transcript, newFromId) {
  const index = transcript.findIndex((s) => s.id === newFromId);
  return index < 0
    ? { context: [], fresh: transcript }
    : { context: transcript.slice(0, index), fresh: transcript.slice(index) };
}

const { toUtterances } = require("../transcript/utterances");

function buildDecisionState(input, cfg) {
  const { meeting = {}, summary = "", transcript = [], newFromId, partial = null } = input;
  const b = cfg.budget;
  const split = splitNewAndContext(
    transcript.filter((s) => s.final !== false),
    newFromId
  );
  // Models read utterances: backchannel dropped, cut-up segments of one voice glued together.
  const context = toUtterances(split.context, speakerLabel);
  // Filler ("Yeah.", "Hmm.") that rode along in a batch must not push the real words out of the window.
  // A trailing "Yes." or "Right." must not become the thing the moment is judged by.
  const weak = (s) => s.noise || (s.text.split(/\s+/).length <= 3 && !s.text.includes("?"));
  const merged = toUtterances(split.fresh, speakerLabel);
  const freshAll = merged.length ? merged : split.fresh; // only backchannel: judge it as it is
  const fresh = freshAll.some((s) => !weak(s)) ? freshAll.filter((s) => !weak(s)) : freshAll;

  const state = {
    about:
      "USER wears a silent meeting assistant; OTHER-n are other people on the call and NEARBY-n people next to the USER. Judge new_text; summary and context are background.",
    title: meeting.title ? clip(oneLine(meeting.title), 60) : undefined,
    summary: summary && b.summary > 0 ? clip(oneLine(summary), b.summary) : undefined,
    context:
      b.context > 0
        ? fitNewest(
            context.slice(-cfg.maxContextTurns).map((s) => line(s, 400)),
            b.context
          )
        : undefined,
    new_text: fitNewest(
      fresh.slice(-cfg.maxNewTurns).map((s) => line(s, 600)),
      b.newText
    ),
    // What the USER's project files hold (one short line each): lets the judge tell whether they could answer this moment.
    project_files: input.projectFiles?.length
      ? input.projectFiles.slice(0, 8).map((l) => clip(oneLine(l), 110))
      : undefined,
    unfinished: partial?.text ? line(partial, 120) : undefined,
    running: input.running?.length
      ? input.running.slice(-2).map((j) => `${j.id}: ${clip(oneLine(j.topic), 60)} (${j.status})`)
      : undefined,
    cards: input.recentCards?.length
      ? input.recentCards
          .slice(-2)
          .map(
            (c) =>
              `${c.kind}: ${clip(oneLine(c.gist), 70)}${c.reaction && c.reaction !== "none" ? ` [${c.reaction}]` : ""}`
          )
      : undefined,
    // Only non-default signals: absent means "not speaking, sentence ended".
    user_speaking: input.signals?.userSpeaking ? true : undefined,
    sentence_unfinished: input.signals && input.signals.endpoint === false ? true : undefined,
  };
  return JSON.parse(JSON.stringify(state)); // drop undefined keys
}

module.exports = { buildDecisionState, speakerLabel, clip, oneLine };
