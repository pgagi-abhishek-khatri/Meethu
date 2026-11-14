// A file's profile: what it holds, in parts each reader can take a slice of. Written once when the file is
// indexed (profileBuilder.js), from the whole file, sized to the file: a 60-page proposal gets more topics and
// facts than a 9-page note. Pure: sizing, the map/reduce prompts, parsing, the grounding check, and rendering
// for the decider (D1), the answer model and the query writer within a character budget.
//   { v, brief, abstract, topics: [{ name, pages, covers }], facts: [{ text, page }], terms: [], useWhen }
const PROFILE_VERSION = 2;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
const oneLine = (s) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
const clip = (s, n) => (s.length > n ? s.slice(0, Math.max(0, n - 1)).trimEnd() + "…" : s);

// How much a file's profile holds grows with its size, levelling off (square root of the chunk count):
// 43 chunks -> 26 facts, 58 -> 30, 258 -> 60.
function profileTargets(chunkCount) {
  const r = Math.sqrt(Math.max(1, chunkCount));
  return {
    facts: clamp(4 * r, 8, 60),
    topics: clamp(1.5 * r, 4, 25),
    abstractWords: clamp(60 + 18 * r, 120, 400),
    terms: clamp(2 * r, 10, 40),
  };
}

// The file cut into the parts the map step reads: PDF chunks by page range (the same 12 pages the PDF was read
// in), everything else by size. One part means one call writes the profile directly.
function profileParts(chunks, { pagesPerPart = 12, partChars = 50000 } = {}) {
  const paged = chunks.length > 0 && chunks.every((c) => Number.isFinite(c.meta?.page));
  const parts = [];
  let cur = null;
  for (const c of chunks) {
    const page = paged ? c.meta.page : null;
    const key = paged ? Math.floor((page - 1) / pagesPerPart) : null;
    const full = cur && (paged ? cur.key !== key : cur.chars + c.text.length > partChars);
    if (!cur || full) {
      cur = { key, texts: [], chars: 0, from: page, to: page };
      parts.push(cur);
    }
    cur.texts.push(paged ? `[[page ${page}]]\n${c.text}` : c.text);
    cur.chars += c.text.length;
    if (paged) cur.to = Math.max(cur.to, page);
  }
  return parts.map((p) => ({
    text: p.texts.join("\n\n"),
    chars: p.chars,
    from: p.from,
    to: p.to,
  }));
}

const SHAPE = `Return one JSON object, nothing else:
{
  "brief": "one sentence, at most 25 words: what this file is (type, for whom, subject, date if stated)",
  "abstract": "plain prose of about ABSTRACT words: what it covers and its most important specifics",
  "topics": [{ "name": "a section or subject, 2-6 words", "pages": "e.g. 12-15, or empty", "covers": "the specifics it holds, at most 20 words" }],
  "facts": [{ "text": "one checkable fact, at most 20 words, with its exact numbers, amounts, names and units", "page": 12 }],
  "terms": ["names, product and feature names, jargon and identifiers a reader would search for"],
  "useWhen": "one sentence: what kinds of meeting questions this file can answer"
}`;

const RULES = `Rules:
- Use only what the text says. Never guess, round or convert a number; copy it as written (amounts with their currency, percentages with %).
- A fact names what its number belongs to ("Bid increment is AED 500", not "AED 500").
- Spread topics and facts over the whole text, start to end, not just the first pages.
- Prefer facts people ask about in meetings: prices, fees, limits, dates, deadlines, counts, rules, responsibilities, names, versions, scope.
- Order facts most useful first (readers with little room keep only the first ones); the document's own title, author and date are the least useful.
- "page" is the number from the nearest [[page N]] marker before the fact, or null when there are no markers.`;

// One call over the whole file (it fits in one part), or the map step over one part of it.
function mapPrompt({ name, kind, text, targets, part = null }) {
  const scope = part
    ? `This is part ${part.index + 1} of ${part.count} of the file${part.from != null ? ` (pages ${part.from}-${part.to})` : ""}. Profile only this part.`
    : "This is the whole file.";
  return `File: ${name} (${kind})
${scope}

Write a profile of it for a meeting assistant that must know, without opening the file, which questions it can answer.
Sizes: about ${targets.topics} topics, about ${targets.facts} facts, about ${targets.terms} terms.

${SHAPE.replace("ABSTRACT", String(targets.abstractWords))}

${RULES}

Text:
${text}`;
}

// The reduce step: the parts' profiles merged into one for the whole file.
function reducePrompt({ name, kind, partials, targets }) {
  return `File: ${name} (${kind})
Below are profiles of the file's ${partials.length} parts, in order. Merge them into ONE profile of the whole file.
- Combine topics that are the same subject (join their page ranges); keep about ${targets.topics} topics covering the whole file.
- Keep about ${targets.facts} facts: the most useful ones, spread over all parts, no duplicates, most useful first; keep each fact's wording, numbers and page exactly.
- Keep about ${targets.terms} terms.
- Write the brief and an abstract of about ${targets.abstractWords} words about the whole file.

${SHAPE.replace("ABSTRACT", String(targets.abstractWords))}

Part profiles:
${partials.map((p, i) => `--- part ${i + 1}${p.from != null ? ` (pages ${p.from}-${p.to})` : ""}\n${JSON.stringify(p.profile)}`).join("\n")}`;
}

// The model's reply -> a clean profile, or null. Tolerates a ```json fence and stray text around the object.
function parseProfile(text) {
  const s = String(text ?? "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  let o;
  try {
    o = JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const str = (v, n) => clip(oneLine(v), n);
  const page = (v) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const p = {
    v: PROFILE_VERSION,
    brief: str(o.brief, 240),
    abstract: str(o.abstract, 3200),
    topics: (Array.isArray(o.topics) ? o.topics : [])
      .map((t) => ({
        name: str(t?.name, 80),
        pages: str(t?.pages, 20),
        covers: str(t?.covers, 200),
      }))
      .filter((t) => t.name),
    facts: (Array.isArray(o.facts) ? o.facts : [])
      .map((f) => ({ text: str(typeof f === "string" ? f : f?.text, 200), page: page(f?.page) }))
      .filter((f) => f.text),
    terms: [
      ...new Set((Array.isArray(o.terms) ? o.terms : []).map((t) => str(t, 60)).filter(Boolean)),
    ],
    useWhen: str(o.useWhen, 300),
  };
  return p.brief || p.abstract || p.facts.length ? p : null;
}

// Numbers as written in a fact ("AED 5,000", "3%", "1.5") reduced to their digits, for the grounding check.
const NUMBER = /\d[\d,.]*\d|\d/g;
const digits = (s) => s.replace(/[,]/g, "").replace(/\.$/, "");

// Drops facts whose numbers the file does not contain, and pages the file does not have. Catches invented
// numbers, not a real number put on the wrong subject: that is what the passage check at answer time is for.
function groundProfile(profile, docText, pages = null) {
  const doc = digits(String(docText ?? ""));
  const have = new Set(doc.match(NUMBER) ?? []);
  const dropped = [];
  const facts = [];
  for (const f of profile.facts) {
    const nums = (f.text.match(NUMBER) ?? []).map(digits);
    const missing = nums.filter((n) => !have.has(n));
    if (missing.length) {
      dropped.push({ text: f.text, missing });
      continue;
    }
    facts.push(pages && f.page != null && !pages.has(f.page) ? { ...f, page: null } : f);
  }
  return { profile: { ...profile, facts }, dropped };
}

// ---- rendering: each reader gets the slice it uses, inside its budget.

// Splits `total` characters over the files in proportion to the square root of their size, with a floor.
// files: [{ chunks }] -> [chars]
function allocate(files, total, floor = 300) {
  if (!files.length) return [];
  const w = files.map((f) => Math.sqrt(Math.max(1, f.chunks ?? 1)));
  const sum = w.reduce((a, b) => a + b, 0);
  const base = Math.max(0, total - floor * files.length);
  return w.map((x) => Math.floor(floor + (base * x) / sum));
}

// `label` + pieces joined by `sep`, adding pieces while they fit in `chars` (a piece that does not fit is
// skipped, a later shorter one may still fit). Nothing fits -> "".
function fill(label, pieces, chars, sep) {
  let out = "";
  for (const p of pieces) {
    const next = out ? out + sep + p : label + p;
    if (next.length <= chars) out = next;
  }
  return out;
}

const topicLine = (t, withCovers) =>
  `${t.name}${t.pages ? ` (p.${t.pages})` : ""}${withCovers && t.covers ? `: ${t.covers}` : ""}`;
const factLine = (f) => `${f.text}${f.page ? ` (p.${f.page})` : ""}`;

// For D1: what the file is and what it covers (topic names first, then the facts that fit).
function renderForDecider(name, p, chars) {
  let out = clip(`${name}: ${p.brief}`, chars);
  out += fill(
    "\n covers: ",
    p.topics.map((t) => topicLine(t, false)),
    chars - out.length,
    "; "
  );
  out += fill("\n facts: ", p.facts.map(factLine), chars - out.length, "; ");
  return out;
}

// For the answer model: brief, abstract, key facts with pages, topics with what they cover.
function renderForAnswer(name, p, chars) {
  let out = clip(`- ${name}: ${p.brief}`, chars);
  if (p.abstract && out.length + p.abstract.length + 3 <= chars) out += `\n  ${p.abstract}`;
  out += fill("\n  Key facts:\n   - ", p.facts.map(factLine), chars - out.length, "\n   - ");
  out += fill(
    "\n  Topics:\n   - ",
    p.topics.map((t) => topicLine(t, true)),
    chars - out.length,
    "\n   - "
  );
  return out;
}

// For the query writer: the document's own vocabulary (topic names and terms).
function renderForWriter(name, p, chars) {
  const out = clip(`${name}: ${p.brief}`, chars);
  const words = [...p.topics.map((t) => t.name), ...p.terms];
  return out + fill("\n words: ", words, chars - out.length, ", ");
}

module.exports = {
  PROFILE_VERSION,
  profileTargets,
  profileParts,
  mapPrompt,
  reducePrompt,
  parseProfile,
  groundProfile,
  allocate,
  renderForDecider,
  renderForAnswer,
  renderForWriter,
};
