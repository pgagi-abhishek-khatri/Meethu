// Builds the main model's messages: stable parts first (system, meeting, summary), then the moving parts.
// Pure. Each part is cut to its budget; the old transcript is the summary's job.
const { buildSystemPrompt, PROACTIVE_CHECK } = require("../../prompts/main");
const { ANSWER_BUDGET } = require("../../config/budgets");
const { speakerLabel, clip, oneLine } = require("../decision/buildState");
const { toUtterances } = require("../transcript/utterances");

const MAX_LINES = 15; // the last 15 messages; the summary covers older ones
const newest = (lines, budget) => {
  const kept = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (used + lines[i].length > budget && kept.length) break;
    kept.unshift(lines[i]);
    used += lines[i].length;
  }
  return kept;
};

// contextSeconds 0 = no limit (the summary covers the past).
function transcriptLines(transcript, { now, contextSeconds }, budget) {
  const from = contextSeconds > 0 ? now - contextSeconds * 1000 : -Infinity;
  const lines = toUtterances(
    transcript.filter((s) => s.final !== false && (s.at ?? now) >= from),
    speakerLabel
  ).map((s) => `${s.label}: ${clip(oneLine(s.text), 600)}`);
  return newest(lines.slice(-MAX_LINES), budget);
}

function buildAnswerMessages({
  deliverable,
  web = false,
  proactive = true,
  deep = false,
  meeting = {},
  summary = "",
  transcript = [],
  now = Date.now(),
  contextSeconds = 120,
  thread = [],
  focus,
  instructions = "", // the USER's own standing instructions for this copilot
  plan = "", // what the USER wrote about this meeting (agenda, to-dos, goals)
  reference = "", // project files that are not indexed (small ones, inlined)
  behavior = "", // learned guide on how the copilot should behave (global)
  catalog = "", // one line per indexed project file: what it holds
  passages = "", // the matching pieces of those files for this moment, already worded
  budget = ANSWER_BUDGET,
}) {
  const parts = [];
  if (instructions)
    parts.push(
      `The USER's standing instructions (follow them unless they conflict with the reply format):\n${clip(instructions, budget.instructions)}`
    );
  if (behavior)
    parts.push(
      `How the USER wants this copilot to behave (learned from their feedback; applies to every project and meeting):\n${clip(behavior, budget.behavior)}`
    );
  if (meeting.title) parts.push(`Meeting: ${clip(oneLine(meeting.title), budget.meeting)}`);
  if (plan)
    parts.push(
      `The USER's notes for this meeting (agenda, to-dos, goals):\n${clip(plan, budget.plan)}`
    );
  if (reference)
    parts.push(
      `Reference files the USER attached (use when relevant, name the file when you rely on it):\n${clip(reference, budget.reference)}`
    );
  if (catalog) parts.push(clip(catalog, budget.catalog));
  if (passages) parts.push(clip(passages, budget.passages));
  if (summary)
    parts.push(`Summary of the meeting so far:\n${clip(oneLine(summary), budget.summary)}`);
  const lines = transcriptLines(transcript, { now, contextSeconds }, budget.transcript);
  if (lines.length) parts.push(`Recent transcript, oldest first:\n${lines.join("\n")}`);
  const cards = newest(
    thread.map(
      (c) => `- ${c.title ? c.title + ": " : ""}${clip(oneLine(c.body ?? c.gist ?? ""), 300)}`
    ),
    budget.thread
  );
  if (cards.length)
    parts.push(`Earlier cards in this thread (do not repeat them):\n${cards.join("\n")}`);
  parts.push(
    `${proactive ? "Help with" : "The USER asks"}:\n${clip(oneLine(focus), budget.focus)}`
  );
  // Last line wins: the model skips the search tool unless told right where it answers.
  if (web) parts.push("Run a web search for this before you answer.");
  if (proactive) parts.push(PROACTIVE_CHECK);
  return [
    { role: "system", content: buildSystemPrompt({ deliverable, web, proactive, deep }) },
    { role: "user", content: parts.join("\n\n") },
  ];
}

module.exports = { buildAnswerMessages };
