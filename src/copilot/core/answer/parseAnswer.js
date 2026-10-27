// Splits the model's reply (TITLE / body / CONFIDENCE, see prompts/main.js) into card parts.
// Tolerant: works on a half-streamed reply, and a reply that ignored the format becomes a plain body.
function parseAnswer(text) {
  const skip = /^\s*SKIP\b:?[ \t]*(.*)/i.exec(String(text ?? ""));
  if (skip) return { skip: true, reason: skip[1].trim(), title: "", body: "", confidence: null };
  let rest = String(text ?? "").replace(/^\s+/, "");
  // A model that searched the web first often narrates ("Let me search…") before the card: the card starts at TITLE.
  // The narration can also run straight into it on the same line ("…for context.TITLE: …").
  const start = /(?:^|\n)[ \t]*TITLE:/i.exec(rest) ?? /[.!?…][ \t]*TITLE:/.exec(rest);
  if (start) rest = rest.slice(start.index + start[0].search(/title:/i)).replace(/^\s+/, "");
  let title = "";
  const t = /^TITLE:[ \t]*(.*)(?:\r?\n|$)/i.exec(rest);
  if (t) {
    title = t[1]
      .split(/TITLE:/i)
      .pop()
      .trim(); // narration glued before a second TITLE:
    rest = rest.slice(t[0].length);
  }
  let confidence = null;
  // Confidence comes right after the title (so a low one can stop the card early); an older trailing line still parses.
  const head = /^[ \t]*\**CONFIDENCE:?\**[ \t]*(high|medium|low)\b[^\n]*(?:\r?\n|$)/i.exec(rest);
  if (head) {
    confidence = head[1].toLowerCase();
    rest = rest.slice(head[0].length);
  }
  // "CONFIDENCE: hi" still streaming: not body text.
  if (!confidence && /^[ \t]*\**CONFIDENCE:?\**[ \t]*[a-z]*$/i.test(rest)) rest = "";
  const c = confidence
    ? null
    : /(?:^|\n)[ \t]*\**CONFIDENCE:?\**[ \t]*(high|medium|low)\b[^\n]*\s*$/i.exec(rest);
  if (!confidence && c) {
    confidence = c[1].toLowerCase();
    rest = rest.slice(0, c.index);
  } else if (!confidence) {
    // A streamed reply may end mid-way through the CONFIDENCE line: do not flash it in the body.
    rest = rest.replace(
      /(?:^|\n)[ \t]*\**C(?:O(?:N(?:F(?:I(?:D(?:E(?:N(?:C(?:E:?)?)?)?)?)?)?)?)?)?\**[ \t]*$/i,
      ""
    );
  }
  // FOLLOWUPS: a | b  (a partial one still streaming is hidden, never shown in the body)
  let followups = [];
  const f = /(?:^|\n)[ \t]*\**FOLLOW-?UPS?:\**[ \t]*([^\n]*)/i.exec(rest);
  if (f) {
    followups = f[1]
      .split("|")
      .map((q) => q.trim().replace(/^[-•]\s*/, ""))
      .filter((q) => q.length > 3)
      .slice(0, 2);
    rest = rest.replace(f[0], "");
  }
  rest = rest.replace(
    /(?:^|\n)[ \t]*\**F(?:O(?:L(?:L(?:O(?:W(?:-?(?:U(?:P(?:S?)?)?)?)?)?)?)?)?)?\**[ \t]*$/i,
    ""
  );
  return { title, body: rest.trim(), confidence, followups };
}

module.exports = { parseAnswer };
