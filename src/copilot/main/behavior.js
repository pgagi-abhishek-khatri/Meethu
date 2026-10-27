// The copilot's learned behaviour: ONE short, general guide ("what to make cards about, what to leave alone, how to
// word them"), global for every project and meeting. It is not a list of examples: signals (a card marked "not
// helpful", a skipped moment the user tapped) are buffered briefly and, rarely, folded into a rewrite of the guide
// by a cheap model; the signals are then thrown away. The user can read and edit the guide in the Prompts tab.
// Electron-free: the settings, the model call and the clock are injected.
const fs = require("fs");
const path = require("path");

const MIN_SIGNALS = 5; // fewer than this is noise
const MIN_GAP_MS = 12 * 3600 * 1000; // at most about twice a day ...
const FORCE_SIGNALS = 12; // ... unless a lot has piled up
const MAX_PENDING = 20;
const MAX_WORDS = 110;

const SYSTEM = `You maintain a short behaviour guide for a silent meeting copilot that shows quick help cards to its user during calls. The guide is GLOBAL: it applies to every project and every meeting, so it must be general. Rewrite it using the new signals.
Signals: "not helpful" = a card the user judged unnecessary or irrelevant; "wanted" = a skipped moment the user asked for anyway.
Rules:
- Describe KINDS of moments and the style wanted, in general terms (for example: what is worth a card, what to leave alone, how to word it). Never quote or list the signals, never use names of people, projects, products or companies, no example sentences.
- Keep every line of the current guide that the signals do not contradict. Change only what they show. Add a line only for a pattern that more than one signal supports.
- At most ${MAX_WORDS} words, as short lines starting with "- ". Output only the guide.`;

function createBehavior({ dir, settings, llm = () => null, now = Date.now }) {
  const file = path.join(dir, "copilot-behavior.json");
  let state = { pending: [], updatedAt: 0 };
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {}
  const save = () => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state));
    } catch {}
  };
  let updating = false;

  return {
    text: () => String(settings.view().behavior ?? "").trim(),
    // kind: "down" (not helpful) | "wanted" (a skipped moment the user tapped). Undo removes the matching signal.
    note(kind, line) {
      const l = String(line ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160);
      if (!l) return;
      state.pending = state.pending.filter((p) => !(p.line === l));
      if (kind === "down" || kind === "wanted") state.pending.push({ kind, line: l });
      state.pending = state.pending.slice(-MAX_PENDING);
      save();
    },
    pending: () => state.pending.length,
    // Called after a meeting (and after a signal). Rewrites the guide only when enough has built up. -> true when it did.
    async maybeUpdate({ force = false } = {}) {
      const n = state.pending.length;
      const due = n >= FORCE_SIGNALS || (n >= MIN_SIGNALS && now() - state.updatedAt >= MIN_GAP_MS);
      if (updating || !(force ? n > 0 : due)) return false;
      const call = llm();
      if (!call) return false;
      updating = true;
      try {
        const lines = state.pending.map(
          (p) => `${p.kind === "down" ? "not helpful" : "wanted"}: ${p.line}`
        );
        const reply = await call({
          messages: [
            { role: "system", content: SYSTEM },
            {
              role: "user",
              content: `Current guide:\n${this.text() || "(none yet)"}\n\nNew signals:\n${lines.join("\n")}\n\nNew guide:`,
            },
          ],
        });
        const next = String(reply?.text ?? "").trim();
        if (!next || next.split(/\s+/).length > MAX_WORDS * 2) return false; // an empty or runaway answer changes nothing
        settings.update({ behavior: next });
        state = { pending: [], updatedAt: now() };
        save();
        return true;
      } catch {
        return false;
      } finally {
        updating = false;
      }
    },
  };
}

module.exports = { createBehavior, MIN_SIGNALS, FORCE_SIGNALS };
