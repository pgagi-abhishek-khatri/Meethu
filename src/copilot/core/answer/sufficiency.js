// Did the project search find enough to answer from? Pure; the thresholds come from the decision config
// (DEFAULT_DECISION_CONFIG.sufficiency). "none": nothing matched closely enough, so a factual answer would be
// invented; "thin": something matched but the passages are too short to be sure; "enough": answer as usual.
// A search that did not run (project false) is "enough": nothing changes.
const THIN_CHARS = 200;

function judgeSufficiency({
  project = false,
  passages = "",
  hits = [],
  minScore = 0,
  minHits = 1,
} = {}) {
  if (!project) return "enough";
  const close = (Array.isArray(hits) ? hits : []).filter(
    (h) => h && Number.isFinite(h.score) && h.score >= minScore
  );
  if (close.length < Math.max(1, minHits)) return "none";
  return String(passages ?? "").trim().length < THIN_CHARS ? "thin" : "enough";
}

module.exports = { judgeSufficiency, THIN_CHARS };
