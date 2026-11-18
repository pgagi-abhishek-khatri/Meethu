// src/copilot/core/okf/featureRegistry.js
// In-memory canonical feature registry store for OKF.
// Pure, Electron-free. Caches feature identities, version lineages,
// and source provenance for sub-millisecond deterministic lookup.

const defaultFs = require("fs");
const defaultPath = require("path");
const defaultYaml = require("js-yaml");
const { validateFeatureRegistry } = require("./featureRegistryValidator");

// Normalizes strings for exact canonical name and alias matching
function normalizeTitle(s) {
  if (typeof s !== "string") return "";
  return s
    .trim()
    .toLowerCase()
    .replace(/[\u2014\u2013]/g, "-") // em-dash, en-dash to hyphen
    .replace(/["'“”‘’]/g, "") // strip quotes
    .replace(/[.:;,-]+$/g, "") // strip trailing punctuation
    .replace(/\s+/g, " "); // collapse whitespace
}

// Tokenizes keyword for exact keyword indexing
function normalizeKeyword(k) {
  if (typeof k !== "string") return "";
  return k.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "");
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripSectionPrefix(s) {
  return String(s || "")
    .replace(/^\s*(?:[IVXLCDM]+\.|[0-9]+(?:\.[0-9]+)*\.?)\s+/i, "")
    .trim();
}

function createFeatureRegistry({
  registryPath = null,
  okfDir = null,
  fs = defaultFs,
  path = defaultPath,
  yaml = defaultYaml,
} = {}) {
  const resolvedOkfDir = okfDir || path.resolve(__dirname, "../../../../OKF");
  const resolvedRegistryDir = path.join(resolvedOkfDir, "registry");
  const resolvedRegistryPath = registryPath || path.join(resolvedRegistryDir, "feature_registry.yaml");

  let rawData = null;
  let validationResult = { valid: false, errors: [], warnings: [] };
  let featuresById = new Map();
  let featuresByName = new Map();
  let featuresByAlias = new Map();
  let featuresByKeyword = new Map();
  let featuresByKeywordPhrase = new Map();
  let loaded = false;

  function resolveRegistryFiles() {
    if (registryPath) {
      return fs.existsSync(resolvedRegistryPath) ? [resolvedRegistryPath] : [];
    }
    if (typeof fs.readdirSync === "function" && fs.existsSync(resolvedRegistryDir)) {
      try {
        const files = fs
          .readdirSync(resolvedRegistryDir)
          .filter((f) => /\.ya?ml$/i.test(f))
          .sort((a, b) => {
            if (a === "feature_registry.yaml") return -1;
            if (b === "feature_registry.yaml") return 1;
            return a.localeCompare(b);
          })
          .map((f) => path.join(resolvedRegistryDir, f));
        if (files.length > 0) return files;
      } catch {
        // Fall through to single-file path for mocked fs objects
      }
    }
    return fs.existsSync(resolvedRegistryPath) ? [resolvedRegistryPath] : [];
  }

  function load() {
    loaded = true;
    featuresById.clear();
    featuresByName.clear();
    featuresByAlias.clear();
    featuresByKeyword.clear();
    featuresByKeywordPhrase.clear();

    const files = resolveRegistryFiles();
    if (files.length === 0) {
      validationResult = {
        valid: false,
        errors: [`Registry file does not exist at '${resolvedRegistryPath}'`],
        warnings: [],
      };
      rawData = null;
      return false;
    }

    const mergedFeatures = [];
    const allErrors = [];
    const allWarnings = [];
    let primaryMeta = null;

    let lastParsed = null;
    for (const filePath of files) {
      let parsed = null;
      try {
        const content = fs.readFileSync(filePath, "utf8");
        parsed = yaml.load(content);
        lastParsed = parsed;
      } catch (err) {
        allErrors.push(`Failed to parse YAML registry '${filePath}': ${err.message}`);
        continue;
      }

      const fileValidation = validateFeatureRegistry(parsed);
      if (!fileValidation.valid) {
        for (const err of fileValidation.errors) {
          allErrors.push(err);
        }
        continue;
      }
      for (const warn of fileValidation.warnings || []) {
        allWarnings.push(warn);
      }

      if (!primaryMeta) {
        primaryMeta = {
          schema_version: parsed.schema_version,
          bundle_id: parsed.bundle_id,
        };
      }
      for (const feat of parsed.features || []) {
        mergedFeatures.push(feat);
      }
    }

    if (allErrors.length > 0) {
      validationResult = { valid: false, errors: allErrors, warnings: allWarnings };
      rawData = files.length === 1 ? lastParsed : null;
      return false;
    }

    rawData = {
      ...(primaryMeta || { schema_version: "1.0.0", bundle_id: "merged" }),
      features: mergedFeatures,
    };
    validationResult = { valid: true, errors: [], warnings: allWarnings };

    // Build in-memory deterministic indexes
    for (const feat of rawData.features) {
      const idUpper = feat.feature_id.toUpperCase();
      const idLower = feat.feature_id.toLowerCase();

      // 1. By ID (case-insensitive keying)
      featuresById.set(idUpper, feat);
      featuresById.set(idLower, feat);

      // 2. By Canonical Name (normalized)
      if (feat.canonical_name) {
        const normName = normalizeTitle(feat.canonical_name);
        if (!featuresByName.has(normName)) featuresByName.set(normName, []);
        featuresByName.get(normName).push(feat);
      }

      // 3. By Registered Aliases (normalized)
      if (Array.isArray(feat.aliases)) {
        for (const alias of feat.aliases) {
          const normAlias = normalizeTitle(alias);
          if (!normAlias) continue;
          if (!featuresByAlias.has(normAlias)) featuresByAlias.set(normAlias, []);
          featuresByAlias.get(normAlias).push(feat);
        }
      }

      // 4. By Registered Keywords (compact + phrase-preserved normalized)
      if (Array.isArray(feat.keywords)) {
        for (const kw of feat.keywords) {
          const normKw = normalizeKeyword(kw);
          if (normKw) {
            if (!featuresByKeyword.has(normKw)) featuresByKeyword.set(normKw, new Set());
            featuresByKeyword.get(normKw).add(feat);
          }
          const normPhrase = normalizeTitle(kw);
          if (normPhrase) {
            if (!featuresByKeywordPhrase.has(normPhrase)) {
              featuresByKeywordPhrase.set(normPhrase, new Set());
            }
            featuresByKeywordPhrase.get(normPhrase).add(feat);
          }
        }
      }
    }

    return true;
  }

  function ensureLoaded() {
    if (!loaded) load();
  }

  function filterByProject(candidates, projectId) {
    if (projectId == null) return candidates;
    return candidates.filter(
      (f) => f.project_id == null || String(f.project_id) === String(projectId)
    );
  }

  // A. Lookup by feature ID: getFeatureById(featureId, projectId)
  function getFeatureById(featureId, projectId = null) {
    ensureLoaded();
    if (!featureId) return null;
    const key = String(featureId).trim().toLowerCase();
    const feat = featuresById.get(key) || null;
    if (!feat) return null;
    if (projectId != null && feat.project_id != null && String(feat.project_id) !== String(projectId)) {
      return null;
    }
    return feat;
  }

  // B. Lookup by canonical name: getFeatureByName(name, projectId)
  function getFeatureByName(name, projectId = null) {
    ensureLoaded();
    const norm = normalizeTitle(name);
    if (!norm) return null;

    let candidates = featuresByName.get(norm) || [];
    candidates = filterByProject(candidates, projectId);

    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    // Ambiguity detection
    const distinctIds = Array.from(new Set(candidates.map((c) => c.feature_id)));
    if (distinctIds.length > 1) {
      return {
        matched: false,
        ambiguous: true,
        candidates: distinctIds,
        resolution: "requires_disambiguation",
        reason: `Multiple distinct features share canonical name '${name}'`,
      };
    }
    return candidates[0];
  }

  // C. Lookup by alias: getFeatureByAlias(alias, projectId)
  function getFeatureByAlias(alias, projectId = null) {
    ensureLoaded();
    const norm = normalizeTitle(alias);
    if (!norm) return null;

    let candidates = featuresByAlias.get(norm) || [];
    candidates = filterByProject(candidates, projectId);

    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    const distinctIds = Array.from(new Set(candidates.map((c) => c.feature_id)));
    if (distinctIds.length > 1) {
      return {
        matched: false,
        ambiguous: true,
        candidates: distinctIds,
        resolution: "requires_disambiguation",
        reason: `Multiple distinct features share alias '${alias}'`,
      };
    }
    return candidates[0];
  }

  // D. Lookup by keyword: findFeaturesByKeyword(keyword, projectId)
  function findFeaturesByKeyword(keyword, projectId = null) {
    ensureLoaded();
    const kw = normalizeKeyword(keyword);
    if (!kw) return [];

    const set = featuresByKeyword.get(kw);
    if (!set || set.size === 0) return [];

    let candidates = Array.from(set);
    candidates = filterByProject(candidates, projectId);

    // Deterministic ranking by feature_id
    return candidates.sort((a, b) => a.feature_id.localeCompare(b.feature_id));
  }

  // E. Retrieve current approved version: getCurrentApprovedVersion(featureId, projectId)
  function getCurrentApprovedVersion(featureId, projectId = null) {
    const feat = getFeatureById(featureId, projectId);
    if (!feat) {
      return {
        status: "not_found",
        resolvedVersion: null,
        reason: `Feature '${featureId}' not found`,
      };
    }

    if (feat.lifecycle_status === "deprecated") {
      return {
        status: "deprecated",
        feature_id: feat.feature_id,
        resolvedVersion: null,
        reason: `Feature '${featureId}' is deprecated`,
      };
    }

    const appVerStr = feat.current_approved_version;
    if (!appVerStr) {
      return {
        status: "no_authoritative_version",
        feature_id: feat.feature_id,
        resolvedVersion: null,
        reason: `Feature '${featureId}' has no approved active version`,
      };
    }

    const versions = Array.isArray(feat.versions) ? feat.versions : [];
    const verEntry = versions.find((v) => v.version === appVerStr);

    if (!verEntry || verEntry.approval_status !== "approved" || verEntry.lifecycle_status !== "active") {
      return {
        status: "no_authoritative_version",
        feature_id: feat.feature_id,
        resolvedVersion: null,
        reason: `Current approved version '${appVerStr}' is not active and approved in version records`,
      };
    }

    return {
      status: "resolved",
      feature_id: feat.feature_id,
      canonical_name: feat.canonical_name,
      domain: feat.domain,
      version: verEntry.version,
      approval_status: verEntry.approval_status,
      lifecycle_status: verEntry.lifecycle_status,
      created_at: verEntry.created_at || null,
      approved_at: verEntry.approved_at || null,
      sources: verEntry.sources || feat.sources || [],
      supersession: verEntry.supersession || feat.supersession || { supersedes: [], superseded_by: [] },
      spec: verEntry.spec || null,
    };
  }

  // F. Retrieve feature lineage: getFeatureLineage(featureId, projectId)
  function getFeatureLineage(featureId, projectId = null) {
    const feat = getFeatureById(featureId, projectId);
    if (!feat) {
      return {
        status: "not_found",
        feature_id: featureId,
        lineage: [],
        reason: `Feature '${featureId}' not found`,
      };
    }

    return {
      status: "resolved",
      feature_id: feat.feature_id,
      canonical_name: feat.canonical_name,
      current_approved_version: feat.current_approved_version,
      approval_status: feat.approval_status,
      lifecycle_status: feat.lifecycle_status,
      supersession: feat.supersession || { supersedes: [], superseded_by: [] },
      versions: feat.versions || [],
    };
  }

  function scoreTextMatches(text, projectId, { isTitle = false } = {}) {
    const scores = new Map(); // feature_id -> { feature, score }
    const norm = normalizeTitle(text);
    if (!norm) return scores;

    const addScore = (feat, pts) => {
      if (!feat) return;
      const cur = scores.get(feat.feature_id) || { feature: feat, score: 0 };
      cur.score += pts;
      scores.set(feat.feature_id, cur);
    };

    const weight = isTitle ? 3 : 1;

    // Canonical name substring match (word-bounded)
    for (const [normName, feats] of featuresByName.entries()) {
      if (normName.length >= 5 && new RegExp(`\\b${escapeRegex(normName)}\\b`, "i").test(norm)) {
        for (const f of filterByProject(feats, projectId)) {
          addScore(f, 12 * weight);
        }
      }
    }

    // Registered alias substring match (word-bounded, multi-word aliases score higher)
    for (const [normAlias, feats] of featuresByAlias.entries()) {
      if (normAlias.length >= 4 && new RegExp(`\\b${escapeRegex(normAlias)}\\b`, "i").test(norm)) {
        const multiWordBonus = normAlias.includes(" ") ? 4 : 0;
        for (const f of filterByProject(feats, projectId)) {
          addScore(f, (8 + multiWordBonus) * weight);
        }
      }
    }

    // Registered keyword phrase match (word-bounded, multi-word keywords score higher)
    for (const [normPhrase, featSet] of featuresByKeywordPhrase.entries()) {
      if (normPhrase.length >= 3 && new RegExp(`\\b${escapeRegex(normPhrase)}\\b`, "i").test(norm)) {
        const multiWordBonus = normPhrase.includes(" ") ? 4 : 0;
        const allowed = filterByProject([...featSet], projectId);
        // Penalize shared keywords inversely by how many features share them
        const specificity = allowed.length > 1 ? 0.5 : 1;
        for (const f of allowed) {
          addScore(f, (3 + multiWordBonus) * weight * specificity);
        }
      }
    }

    return scores;
  }

  // Precedence Resolution: Exact feature_id -> Exact name -> Exact alias -> Exact keyword -> Title-First Weighted Scoring -> Body Weighted Scoring -> Fallback
  function resolveFeature(queryOrTitle, textOrProjectId = null, maybeProjectId = null) {
    ensureLoaded();
    const isMultiArg = typeof textOrProjectId === "string";
    const q = String(queryOrTitle || "").trim();
    const qStripped = stripSectionPrefix(q);
    const bodyText = isMultiArg ? String(textOrProjectId || "").trim() : "";
    const projectId = isMultiArg ? maybeProjectId : textOrProjectId;

    if (!q && !bodyText) {
      return {
        matched: false,
        ambiguous: false,
        reason: "Empty query or section content",
      };
    }

    // 1. Exact feature_id match (or explicit feat: identifier in title/query)
    const idPatternMatch = q.match(/\bfeat:[a-z0-9_:-]+\b/i);
    if (idPatternMatch) {
      const feat = getFeatureById(idPatternMatch[0], projectId);
      if (feat) {
        return {
          matched: true,
          ambiguous: false,
          matchTier: "exact_feature_id",
          feature: feat,
          currentApproved: getCurrentApprovedVersion(feat.feature_id, projectId),
        };
      }
    }

    // Direct ID lookup if q itself is an ID without feat: prefix
    const directIdFeat = getFeatureById(q, projectId);
    if (directIdFeat) {
      return {
        matched: true,
        ambiguous: false,
        matchTier: "exact_feature_id",
        feature: directIdFeat,
        currentApproved: getCurrentApprovedVersion(directIdFeat.feature_id, projectId),
      };
    }

    // 2. Exact normalized canonical name (against title or section-number-stripped title)
    for (const candidateQ of [q, qStripped]) {
      if (!candidateQ) continue;
      const byName = getFeatureByName(candidateQ, projectId);
      if (byName) {
        if (byName.ambiguous) return byName;
        return {
          matched: true,
          ambiguous: false,
          matchTier: "canonical_name",
          feature: byName,
          currentApproved: getCurrentApprovedVersion(byName.feature_id, projectId),
        };
      }
    }

    // 3. Exact normalized alias (against title or section-number-stripped title)
    for (const candidateQ of [q, qStripped]) {
      if (!candidateQ) continue;
      const byAlias = getFeatureByAlias(candidateQ, projectId);
      if (byAlias) {
        if (byAlias.ambiguous) return byAlias;
        return {
          matched: true,
          ambiguous: false,
          matchTier: "alias",
          feature: byAlias,
          currentApproved: getCurrentApprovedVersion(byAlias.feature_id, projectId),
        };
      }
    }

    // 4. Exact registered keyword (against title or section-number-stripped title)
    for (const candidateQ of [q, qStripped]) {
      if (!candidateQ) continue;
      const byKw = findFeaturesByKeyword(candidateQ, projectId);
      if (byKw.length === 1) {
        const feat = byKw[0];
        return {
          matched: true,
          ambiguous: false,
          matchTier: "keyword",
          feature: feat,
          currentApproved: getCurrentApprovedVersion(feat.feature_id, projectId),
        };
      } else if (byKw.length > 1) {
        return {
          matched: false,
          ambiguous: true,
          candidates: byKw.map((f) => f.feature_id),
          resolution: "requires_disambiguation",
          reason: `Keyword '${candidateQ}' matches multiple registered features: ${byKw.map((f) => f.feature_id).join(", ")}`,
        };
      }
    }

    // 4b. Title-First Weighted Specificity Scoring (handles natural section headings like "3.4 Live Bidding Engine and Real Time Updates")
    const titleScores = q ? scoreTextMatches(qStripped || q, projectId, { isTitle: true }) : new Map();
    if (titleScores.size > 0) {
      const rankedTitle = [...titleScores.values()].sort(
        (a, b) => b.score - a.score || a.feature.feature_id.localeCompare(b.feature.feature_id)
      );
      if (rankedTitle.length === 1 || rankedTitle[0].score >= 1.5 * rankedTitle[1].score) {
        const feat = rankedTitle[0].feature;
        return {
          matched: true,
          ambiguous: false,
          matchTier: "title_scored",
          feature: feat,
          currentApproved: getCurrentApprovedVersion(feat.feature_id, projectId),
        };
      }
    }

    // 5. If bodyText is provided, check explicit feature tag or combined Title (3x) + Body (1x) weighted score
    if (bodyText) {
      const bodyIdMatch = bodyText.match(/\bfeat:[a-z0-9_:-]+\b/i);
      if (bodyIdMatch) {
        const feat = getFeatureById(bodyIdMatch[0], projectId);
        if (feat) {
          return {
            matched: true,
            ambiguous: false,
            matchTier: "exact_feature_id",
            feature: feat,
            currentApproved: getCurrentApprovedVersion(feat.feature_id, projectId),
          };
        }
      }

      const bodyScores = scoreTextMatches(bodyText, projectId, { isTitle: false });
      const combined = new Map();
      for (const [id, entry] of titleScores.entries()) {
        combined.set(id, { feature: entry.feature, score: entry.score });
      }
      for (const [id, entry] of bodyScores.entries()) {
        const cur = combined.get(id) || { feature: entry.feature, score: 0 };
        cur.score += entry.score;
        combined.set(id, cur);
      }

      const ranked = [...combined.values()].sort(
        (a, b) => b.score - a.score || a.feature.feature_id.localeCompare(b.feature.feature_id)
      );

      if (ranked.length === 1) {
        const feat = ranked[0].feature;
        return {
          matched: true,
          ambiguous: false,
          matchTier: "keyword_body",
          feature: feat,
          currentApproved: getCurrentApprovedVersion(feat.feature_id, projectId),
        };
      } else if (ranked.length > 1) {
        if (ranked[0].score >= 1.5 * ranked[1].score && ranked[0].score >= 6) {
          const feat = ranked[0].feature;
          return {
            matched: true,
            ambiguous: false,
            matchTier: "keyword_body",
            feature: feat,
            currentApproved: getCurrentApprovedVersion(feat.feature_id, projectId),
          };
        }
        return {
          matched: false,
          ambiguous: true,
          candidates: ranked.map((r) => r.feature.feature_id),
          resolution: "requires_disambiguation",
          reason: `Body content matches multiple registered features: ${ranked.map((r) => r.feature.feature_id).join(", ")}`,
        };
      }
    }

    // 6. Fallback to existing semantic matching
    return {
      matched: false,
      ambiguous: false,
      reason: `No deterministic feature match found for query '${q}'; fallback to semantic retrieval`,
    };
  }

  return {
    load,
    hasRegistry: () => {
      ensureLoaded();
      return validationResult.valid && featuresById.size > 0;
    },
    getValidationState: () => {
      ensureLoaded();
      return validationResult;
    },
    getFeatures: (projectId = null) => {
      ensureLoaded();
      const all = rawData?.features || [];
      return filterByProject(all, projectId);
    },
    getFeatureById,
    getFeatureByName,
    getFeatureByAlias,
    findFeaturesByKeyword,
    getCurrentApprovedVersion,
    getFeatureLineage,
    resolveFeature,
  };
}

module.exports = {
  createFeatureRegistry,
  normalizeTitle,
  normalizeKeyword,
};
