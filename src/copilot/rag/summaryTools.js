// Tier 2 On-Demand Lookup Tools (V2 Spec §4.2):
// feature(id), find(term), symbol(name), endpoint(path), file(path, lineStart, lineEnd), doc(path, section)
const { countTokens } = require("./tokenizer");

function createSummaryTools({
  features = [],
  tier1Cards = [],
  symbols = [],
  contracts = [],
  mismatches = [],
  events = [],
  docFacts = [],
  glossary = [],
  files = [],
  readFileSlices = null,
} = {}) {
  const cardByFid = new Map();
  const cardBySlug = new Map();
  for (const c of tier1Cards) {
    cardByFid.set(String(c.fid || "").toUpperCase(), c);
    cardBySlug.set(String(c.slug || "").toLowerCase(), c);
    cardBySlug.set(String(c.name || "").toLowerCase(), c);
  }

  function feature(idOrSlug) {
    const q = String(idOrSlug || "").trim();
    if (!q) return { found: false, error: "Feature id required" };
    const hit = cardByFid.get(q.toUpperCase()) || cardBySlug.get(q.toLowerCase());
    if (!hit) {
      return {
        found: false,
        available: tier1Cards.slice(0, 20).map((c) => ({ fid: c.fid, name: c.name, slug: c.slug })),
      };
    }
    const rawFeat = features.find((f) => f.fid === hit.fid);
    return {
      found: true,
      fid: hit.fid,
      name: hit.name,
      status: hit.status,
      tokens: hit.tokens,
      markdown: hit.markdown,
      primaryFiles: (rawFeat?.primary || []).map((p) => p.relPath),
    };
  }

  function find(term, { limit = 12 } = {}) {
    const q = String(term || "").trim().toLowerCase();
    if (!q) return { term, featureIds: [], glossary: [], symbols: [], files: [] };

    const glossaryMatches = glossary.filter(
      (g) =>
        g.spoken.toLowerCase().includes(q) ||
        (g.mishearings || []).some((m) => m.toLowerCase().includes(q)) ||
        String(g.target || "").toLowerCase().includes(q)
    );
    const featureMatches = features.filter(
      (f) =>
        f.fid.toLowerCase() === q ||
        f.name.toLowerCase().includes(q) ||
        String(f.slug || f.id).toLowerCase().includes(q) ||
        String(f.description || "").toLowerCase().includes(q)
    );
    const symbolMatches = symbols.filter((s) => s.symbol.toLowerCase().includes(q)).slice(0, limit);
    const fileMatches = files
      .filter((f) => f.relPath.toLowerCase().includes(q))
      .slice(0, limit)
      .map((f) => f.relPath);

    const featureIds = [
      ...new Set([
        ...featureMatches.map((f) => f.fid),
        ...glossaryMatches.map((g) => g.fid || g.featureId).filter(Boolean),
      ]),
    ];

    return {
      term,
      featureIds,
      glossary: glossaryMatches.slice(0, limit),
      symbols: symbolMatches,
      files: [...new Set([...fileMatches, ...symbolMatches.map((s) => s.relPath)])].slice(0, limit),
    };
  }

  function symbol(name, { limit = 15 } = {}) {
    const q = String(name || "").trim().toLowerCase();
    if (!q) return { name, total: 0, matches: [] };
    const exact = [];
    const partial = [];
    for (const s of symbols) {
      const low = s.symbol.toLowerCase();
      if (low === q) exact.push(s);
      else if (low.includes(q)) partial.push(s);
    }
    const all = [...exact, ...partial];
    return {
      name,
      total: all.length,
      matches: all.slice(0, limit),
    };
  }

  function endpoint(pathQuery, { limit = 15 } = {}) {
    const q = String(pathQuery || "").trim().toLowerCase();
    if (!q) return { query: pathQuery, contracts: [], mismatches: [], events: [] };
    return {
      query: pathQuery,
      contracts: contracts
        .filter((c) => c.path.toLowerCase().includes(q) || c.normPath.toLowerCase().includes(q))
        .slice(0, limit),
      mismatches: mismatches.filter((m) => String(m.path || "").toLowerCase().includes(q)).slice(0, limit),
      events: events.filter((e) => String(e.channel || "").toLowerCase().includes(q)).slice(0, limit),
    };
  }

  function file(relPath, lineStart = 1, lineEnd = null) {
    if (typeof readFileSlices !== "function") {
      return { found: false, error: "Slice reader unavailable" };
    }
    const end = lineEnd || Number(lineStart || 1) + 90;
    const res = readFileSlices([{ relPath, lineStart: Number(lineStart) || 1, lineEnd: end }], { maxTokens: 4000 });
    if (!res || res.length === 0) return { found: false, relPath };
    const sl = res[0];
    const estTokens = countTokens(sl.text);
    return {
      found: true,
      relPath: sl.relPath,
      lineStart: sl.lineStart,
      lineEnd: sl.lineEnd,
      tokens: estTokens,
      redactedCount: sl.redactedCount || 0,
      header: `${sl.relPath}:L${sl.lineStart}-L${sl.lineEnd} (~${estTokens} tokens)`,
      text: sl.text,
    };
  }

  function doc(docPath, sectionQuery = "") {
    const pq = String(docPath || "").trim().toLowerCase();
    const sq = String(sectionQuery || "").trim().toLowerCase();
    const matchedDoc = docFacts.find(
      (d) => d.relPath.toLowerCase() === pq || d.relPath.toLowerCase().endsWith(pq) || d.relPath.toLowerCase().includes(pq)
    );
    if (!matchedDoc) return { found: false, docPath };
    const headings = sq
      ? (matchedDoc.headings || []).filter((h) => h.text.toLowerCase().includes(sq))
      : matchedDoc.headings || [];
    const rules = sq
      ? (matchedDoc.rules || []).filter((r) => r.text.toLowerCase().includes(sq))
      : matchedDoc.rules || [];
    return {
      found: true,
      relPath: matchedDoc.relPath,
      title: matchedDoc.title,
      summary: matchedDoc.summary,
      headings: headings.slice(0, 30),
      rules: rules.slice(0, 20),
    };
  }

  return {
    feature,
    find,
    symbol,
    endpoint,
    file,
    doc,
  };
}

module.exports = { createSummaryTools };
