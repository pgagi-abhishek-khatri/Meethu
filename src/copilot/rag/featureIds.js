// Stable deterministic feature ID manager (F01..Fnn) persisted across runs
// with rename-map support and per-feature content hashes for incremental Tier 1 regeneration.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

function repoSlugKey(absRoot) {
  return crypto.createHash("sha256").update(path.resolve(String(absRoot || ""))).digest("hex").slice(0, 16);
}

function loadFeatureIdState(cacheDir, absRoot) {
  const dir = cacheDir || path.join(os.tmpdir(), "meethu-code-cache");
  const file = path.join(dir, `feature-ids-${repoSlugKey(absRoot)}.json`);
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object") return { file, state: parsed };
    }
  } catch {}
  return { file, state: { nextNum: 1, bySlug: {}, hashes: {}, renameMap: {} } };
}

function saveFeatureIdState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, file);
  } catch {}
}

function formatFid(num) {
  return `F${String(num).padStart(2, "0")}`;
}

function computeFeatureInputHash(feature) {
  const payload = JSON.stringify({
    id: feature.id,
    name: feature.name,
    status: feature.status,
    desc: feature.description,
    files: (feature.files || []).map((f) => `${f.relPath}:${f.role}:${f.estTokens}:${f.dirty}`),
    contracts: (feature.contracts || []).map((c) => `${c.method}:${c.normPath}:${c.callers?.length || 0}`),
    docs: (feature.docs || []).map((d) => `${d.relPath}:${d.rules?.length || 0}`),
  });
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function assignStableFeatureIds({
  features = [],
  absRoot = "",
  cacheDir = null,
  renameMap = {},
  persist = true,
} = {}) {
  const { file, state } = absRoot
    ? loadFeatureIdState(cacheDir, absRoot)
    : { file: null, state: { nextNum: 1, bySlug: {}, hashes: {}, renameMap: {} } };

  const bySlug = { ...(state.bySlug || {}) };
  let nextNum = Number(state.nextNum) || 1;
  const usedFids = new Set(Object.values(bySlug));

  // Honor explicit slug renameMap (oldSlug -> newSlug) preserving prior Fid
  const mergedRename = { ...(state.renameMap || {}), ...(renameMap || {}) };
  for (const [oldSlug, newSlug] of Object.entries(mergedRename)) {
    if (bySlug[oldSlug] && !bySlug[newSlug]) {
      bySlug[newSlug] = bySlug[oldSlug];
      delete bySlug[oldSlug];
    }
  }

  const assigned = features.map((f) => {
    const slug = String(f.id || f.name || "core").toLowerCase();
    let fid = bySlug[slug];
    if (!fid) {
      while (usedFids.has(formatFid(nextNum))) nextNum += 1;
      fid = formatFid(nextNum);
      nextNum += 1;
      bySlug[slug] = fid;
      usedFids.add(fid);
    }
    const contentHash = computeFeatureInputHash(f);
    const unchanged = state.hashes?.[fid] === contentHash;
    return {
      ...f,
      slug,
      fid,
      contentHash,
      unchanged,
    };
  });

  if (persist && file) {
    const nextHashes = {};
    for (const f of assigned) nextHashes[f.fid] = f.contentHash;
    saveFeatureIdState(file, {
      nextNum,
      bySlug,
      hashes: nextHashes,
      renameMap: mergedRename,
    });
  }

  return assigned;
}

module.exports = {
  assignStableFeatureIds,
  computeFeatureInputHash,
  formatFid,
};
