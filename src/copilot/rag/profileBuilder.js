// Writes a file's profile (profile.js) from its chunks: one call when the file is one part, else one call per
// part side by side (map) and one call that merges them (reduce). Each map call reads a small part with full
// attention, so the middle of a long file is covered as well as its start, and each part knows its own pages.
// The numbers in the facts are then checked against the file's text. Electron-free; `ask` is the analyzer's.
const {
  profileTargets,
  profileParts,
  mapPrompt,
  reducePrompt,
  parseProfile,
  groundProfile,
} = require("./profile");

// ask(parts, opts) -> { text, finish, tokens, cost } (analyzeClient's ask)
async function buildProfile({ ask, name, kind, chunks, log = () => {}, now = Date.now }) {
  const t0 = now();
  const targets = profileTargets(chunks.length);
  const parts = profileParts(chunks);
  let tokens = 0;
  let cost = 0;
  let calls = 0;
  const call = async (text, maxTokens) => {
    const r = await ask([{ type: "text", text }], { maxTokens, json: true });
    tokens += r.tokens;
    cost += r.cost;
    calls++;
    const p = parseProfile(r.text);
    if (!p)
      throw Object.assign(new Error(`profile reply was not JSON (${r.finish})`), {
        code: "bad_profile",
      });
    return p;
  };
  // Room for the JSON: ~25 tokens per fact or topic, the abstract, the terms, and some slack.
  const room = (t) =>
    Math.min(16000, 1500 + 30 * (t.facts + t.topics) + 2 * t.abstractWords + 6 * t.terms);

  let profile;
  if (parts.length <= 1) {
    profile = await call(
      mapPrompt({ name, kind, text: parts[0]?.text ?? "", targets }),
      room(targets)
    );
  } else {
    // Each part is asked for its share of the whole, with some extra so the merge can choose.
    const total = parts.reduce((a, p) => a + p.chars, 0);
    const partials = await Promise.all(
      parts.map(async (part, index) => {
        const share = part.chars / total;
        const t = {
          facts: Math.max(4, Math.ceil(targets.facts * share * 1.5)),
          topics: Math.max(2, Math.ceil(targets.topics * share * 1.5)),
          abstractWords: Math.max(60, Math.round(targets.abstractWords * share * 1.5)),
          terms: Math.max(5, Math.ceil(targets.terms * share * 1.5)),
        };
        const p = await call(
          mapPrompt({
            name,
            kind,
            text: part.text,
            targets: t,
            part: { index, count: parts.length, from: part.from, to: part.to },
          }),
          room(t)
        );
        return { from: part.from, to: part.to, profile: p };
      })
    );
    log({ event: "profile_map", parts: parts.length, ms: now() - t0, tokens, cost });
    profile = await call(reducePrompt({ name, kind, partials, targets }), room(targets));
  }

  const docText = chunks.map((c) => c.text).join("\n");
  const pages = new Set(chunks.map((c) => c.meta?.page).filter(Number.isFinite));
  const grounded = groundProfile(profile, docText, pages.size ? pages : null);
  log({
    event: "profile_done",
    parts: parts.length,
    calls,
    targets,
    got: {
      topics: grounded.profile.topics.length,
      facts: grounded.profile.facts.length,
      terms: grounded.profile.terms.length,
      abstractWords: grounded.profile.abstract.split(/\s+/).filter(Boolean).length,
    },
    dropped: grounded.dropped,
    tokens,
    cost,
    ms: now() - t0,
  });
  return {
    profile: grounded.profile,
    dropped: grounded.dropped,
    tokens,
    cost,
    calls,
    parts: parts.length,
  };
}

// The short text the UI shows and old code reads (copilot_project_files.summary).
const summaryOf = (p) => [p.brief, p.abstract].filter(Boolean).join(" ").slice(0, 2000);

module.exports = { buildProfile, summaryOf };
