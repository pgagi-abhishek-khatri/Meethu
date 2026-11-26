// The OKF manifest's precedence rules, implemented once (OKF/manifest.yaml `precedence_rules`):
//   1. canonical OKF documents override informal meeting notes and old proposals
//   2. approved status overrides draft, deprecated or unverified documents
//   3. newer semantic versions override older versions
//   4. as-built specifications override exploratory proposals
// Order of comparison: status, then kind (rules 1 and 4), then version (rule 3), then date, then id so the result is
// stable. Status comes first because an approved proposal still beats a draft of anything. Pure, Electron-free.
const { compareSemVerLenient } = require("./versionResolver");

// Higher wins. docPrecedence.js classifies project files into the same kinds and takes its ranks from here.
const KIND_RANK = { canonical: 4, built: 3, change: 2, requirement: 1, proposal: 0, notes: -1 };
const STATUS_RANK = { approved: 3, draft: 1, deprecated: 0, superseded: 0, unverified: 0 };
const MAX_SUPERSEDE_HOPS = 16;

const statusRank = (d) => STATUS_RANK[d?.status] ?? 0;
const kindRank = (d) => KIND_RANK[d?.kind ?? "canonical"] ?? KIND_RANK.notes; // an OKF manifest entry is canonical
const timeOf = (d) => {
  const t = Date.parse(d?.updated_at ?? "");
  return Number.isFinite(t) ? t : 0;
};

// > 0 when `a` outranks `b`
function compareAuthority(a, b) {
  return (
    statusRank(a) - statusRank(b) ||
    kindRank(a) - kindRank(b) ||
    compareSemVerLenient(a?.version, b?.version) || // an invalid version ranks below any valid one, never throws
    timeOf(a) - timeOf(b) ||
    String(b?.id ?? "").localeCompare(String(a?.id ?? "")) // lower id first
  );
}

const outranks = (a, b) => compareAuthority(a, b) > 0;
const rankDocuments = (docs) => [...(docs ?? [])].sort((a, b) => compareAuthority(b, a));

// A superseded document points at its replacement (`superseded_by`). Follow the chain to the current approved one, so
// a question that names an old id still reaches the document that governs now. -> { doc, chain, redirected }
function resolveSuperseded(doc, getById) {
  if (!doc) return { doc: null, chain: [], redirected: false };
  if (doc.status === "approved") return { doc, chain: [doc.id], redirected: false };
  const chain = [doc.id];
  const seen = new Set(chain);
  let cur = doc;
  for (let hop = 0; hop < MAX_SUPERSEDE_HOPS; hop++) {
    const next = cur.superseded_by ? getById(cur.superseded_by) : null;
    if (!next || seen.has(next.id)) return { doc: null, chain, redirected: false };
    chain.push(next.id);
    seen.add(next.id);
    if (next.status === "approved") return { doc: next, chain, redirected: true };
    cur = next;
  }
  return { doc: null, chain, redirected: false };
}

module.exports = {
  KIND_RANK,
  STATUS_RANK,
  compareAuthority,
  outranks,
  rankDocuments,
  resolveSuperseded,
};
