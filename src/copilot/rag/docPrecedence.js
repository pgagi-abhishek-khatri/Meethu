// Which of the project's documents wins when they disagree. A proposal says what was planned; a completion or
// as-built document says what was delivered; a later document of the same kind replaces an earlier one. Each
// file's kind, date and phase come from its name and the summary written when it was indexed, so nothing has to
// be tagged by hand. Pure, Electron-free.

const { KIND_RANK } = require("../core/okf/precedence");

// Most trusted kind first. A file matching none of them (a pricing sheet, meeting notes) is "other" and is never
// ranked against the rest: it neither overrides nor is overridden.
const KINDS = [
  {
    kind: "built",
    rank: KIND_RANK.built,
    label: "what was built",
    re: /\b(as[- ]?built|completion|completed|hand-?over|delivery report|release notes|implementation report)\b/i,
  },
  {
    kind: "change",
    rank: KIND_RANK.change,
    label: "agreed change",
    re: /\b(change request|change order|addendum|amendment|revised|revision)\b/i,
  },
  {
    kind: "requirement",
    rank: KIND_RANK.requirement,
    label: "requirements",
    re: /\b(requirements?|specification|statement of work|sow|prd|brd)\b/i,
  },
  {
    kind: "proposal",
    rank: KIND_RANK.proposal,
    label: "original plan",
    re: /\b(proposal|quotation|quote|pitch|estimate|rfp)\b/i,
  },
];

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const MONTH_RE = MONTHS.join("|") + "|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec";
const monthIndex = (m) => MONTHS.findIndex((x) => x.startsWith(m.toLowerCase().slice(0, 3)));

// The first date a text names: "14 October 2026", "October 14, 2026", "August 2026", "2026-09-28".
function findDate(text) {
  const s = String(text ?? "");
  const iso = /\b(20\d\d)-(\d\d)-(\d\d)\b/.exec(s);
  const dmy = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_RE})[a-z]*\\.?,?\\s+(20\\d\\d)\\b`, "i").exec(
    s
  );
  const mdy = new RegExp(`\\b(${MONTH_RE})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d\\d)\\b`, "i").exec(
    s
  );
  const my = new RegExp(`\\b(${MONTH_RE})[a-z]*\\.?,?\\s+(20\\d\\d)\\b`, "i").exec(s);
  const found = [
    iso && { at: iso.index, t: Date.UTC(+iso[1], +iso[2] - 1, +iso[3]), day: true },
    dmy && { at: dmy.index, t: Date.UTC(+dmy[3], monthIndex(dmy[2]), +dmy[1]), day: true },
    mdy && { at: mdy.index, t: Date.UTC(+mdy[3], monthIndex(mdy[1]), +mdy[2]), day: true },
    my && { at: my.index, t: Date.UTC(+my[2], monthIndex(my[1]), 1), day: false },
  ].filter((d) => d && Number.isFinite(d.t));
  if (!found.length) return null;
  // the earliest mention; a full date beats a month-only match at the same place
  found.sort((a, b) => a.at - b.at || b.day - a.day);
  return found[0];
}

const fmtDate = (d) => {
  if (!d) return "";
  const x = new Date(d.t);
  const month = MONTHS[x.getUTCMonth()];
  const m = month[0].toUpperCase() + month.slice(1, 3);
  return d.day ? `${x.getUTCDate()} ${m} ${x.getUTCFullYear()}` : `${m} ${x.getUTCFullYear()}`;
};

function profileOf(row) {
  if (!row?.profile) return null;
  if (typeof row.profile === "object") return row.profile;
  try {
    return JSON.parse(row.profile);
  } catch {
    return null;
  }
}

// row: a file row ({ name, summary, profile }) -> { kind, rank, label, date, dateText, phase }
function docStanding(row) {
  const name = String(row?.name ?? "").replace(/[_]+/g, " ");
  const brief = profileOf(row)?.brief ?? "";
  const summary = String(row?.summary ?? "").slice(0, 400);
  // the file's own name and its one-line brief say what it is; the longer summary is only a fallback, since
  // a proposal's summary may well mention "completion" of the work it plans
  const kindOf = (text) => KINDS.find((k) => k.re.test(text));
  const k = kindOf(name) ?? kindOf(brief) ?? kindOf(summary) ?? null;
  const date = findDate(brief) ?? findDate(summary) ?? findDate(name);
  const phase = Number(/\bphase\s*-?\s*(\d+)/i.exec(`${name} ${brief}`)?.[1]) || null;
  return {
    kind: k?.kind ?? "other",
    rank: k ? k.rank : null,
    label: k?.label ?? null,
    date: date?.t ?? null,
    dateText: fmtDate(date),
    phase,
  };
}

// Ranked files, most trusted first: kind, then date, then phase. Files of kind "other" are left out.
function precedenceOrder(rows) {
  return rows
    .map((row) => ({ name: row.name, ...docStanding(row) }))
    .filter((s) => s.rank != null)
    .sort(
      (a, b) =>
        b.rank - a.rank || (b.date ?? 0) - (a.date ?? 0) || (b.phase ?? 0) - (a.phase ?? 0)
    );
}

// name -> { ...standing, order }: a higher order wins. Only ranked files are in it.
function standingMap(rows) {
  const ordered = precedenceOrder(rows);
  return new Map(ordered.map((s, i) => [s.name, { ...s, order: ordered.length - i }]));
}

const describe = (s) =>
  [
    s.phase ? `phase ${s.phase}` : null,
    s.label,
    s.dateText || null,
  ]
    .filter(Boolean)
    .join(", ");

// The short tag that follows a passage's file name: "what was built, 28 Sep 2026".
const passageTag = (s) => (s ? describe(s) : "");

// The rule the answer model gets when its passages (or the catalog) span ranked files of different standing.
function precedenceNote(standings) {
  const list = [...standings].sort((a, b) => b.order - a.order);
  if (list.length < 2) return "";
  const items = list.map((s, i) => `${i + 1}. ${s.name} (${describe(s)})`).join("; ");
  return (
    `These documents were written at different times and can disagree. Most trusted first: ${items}. ` +
    "When they say different things about the same point, state what the most trusted one says as the current " +
    "fact, and if it helps, add briefly that the earlier document had planned something else. A later document " +
    "only replaces the points it covers: a point only the older one mentions still stands."
  );
}

module.exports = { KINDS, docStanding, precedenceOrder, standingMap, precedenceNote, passageTag, findDate };
