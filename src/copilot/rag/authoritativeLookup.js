// src/copilot/rag/authoritativeLookup.js
// Authoritative Lookup Service (ALS) for Meethu Copilot.
// Resolves canonical requirements, feature identities, approved versions,
// lifecycle states, and source precedence deterministically BEFORE vector retrieval.
// Zero-model, pure, sub-millisecond source-of-truth lookup engine.

const { normalizeTitle, normalizeKeyword } = require("../core/okf/featureRegistry");

// ---------------------------------------------------------------------------
// Source Precedence Policy
// ---------------------------------------------------------------------------

const SOURCE_PRECEDENCE_TIERS = {
  CANONICAL_OKF: {
    score: 100,
    name: "Canonical OKF Specification",
    description: "Approved foundational system specification in OKF/documents/",
  },
  AUTHORITATIVE_REQUIREMENT: {
    score: 80,
    name: "Authoritative Client Requirement",
    description: "Approved primary client requirements document",
  },
  PROJECT_REQUIREMENT_UPDATE: {
    score: 60,
    name: "Project Requirement Addendum",
    description: "Approved project-level requirement delta or RFC update",
  },
  SUPPORTING_DOCUMENT: {
    score: 40,
    name: "Supporting Documentation",
    description: "Approved technical guide, diagram, or supporting document",
  },
  UNAPPROVED_OR_DRAFT: {
    score: 20,
    name: "Draft / Pending Requirement",
    description: "Unapproved or pending requirement change",
  },
  DEPRECATED_OR_REJECTED: {
    score: 0,
    name: "Deprecated / Rejected Source",
    description: "Archived, deprecated, or rejected specification",
  },
};

/**
 * Classifies a document source into an authority tier.
 */
function classifySourceAuthority(source, { approvalStatus = "approved", lifecycleStatus = "active" } = {}) {
  if (approvalStatus === "rejected" || lifecycleStatus === "deprecated") {
    return SOURCE_PRECEDENCE_TIERS.DEPRECATED_OR_REJECTED;
  }
  if (approvalStatus === "draft" || approvalStatus === "pending") {
    return SOURCE_PRECEDENCE_TIERS.UNAPPROVED_OR_DRAFT;
  }

  const srcStr = String(source?.source_name || source?.document_name || source || "").toLowerCase();

  if (srcStr.includes("okf-") || srcStr.includes("canonical") || source?.source_type === "canonical_okf") {
    return SOURCE_PRECEDENCE_TIERS.CANONICAL_OKF;
  }
  if (srcStr.includes("client_requirements") || srcStr.includes("prd") || source?.source_type === "authoritative_requirement") {
    return SOURCE_PRECEDENCE_TIERS.AUTHORITATIVE_REQUIREMENT;
  }
  if (srcStr.includes("addendum") || srcStr.includes("rfc") || srcStr.includes("update") || source?.source_type === "project_update") {
    return SOURCE_PRECEDENCE_TIERS.PROJECT_REQUIREMENT_UPDATE;
  }
  return SOURCE_PRECEDENCE_TIERS.SUPPORTING_DOCUMENT;
}

// ---------------------------------------------------------------------------
// Matching Hierarchy (Levels 1 - 6)
// ---------------------------------------------------------------------------

const FEATURE_ID_PATTERN = /\bfeat:[a-z0-9_:-]+\b/i;
const SEMVER_PATTERN = /\bv?([0-9]+\.[0-9]+\.[0-9]+)\b/i;

/**
 * Resolves a query against the Feature Registry using strict deterministic precedence.
 */
function matchDeterministicPrecedence({ query, featureId = null, featureRegistry, projectId = null }) {
  if (!featureRegistry) {
    return { status: "NOT_FOUND", reason: "Feature registry unavailable", level: 6 };
  }

  const q = String(query || "").trim();

  // LEVEL 1 — Exact Feature ID
  let targetId = featureId ? String(featureId).trim() : null;
  if (!targetId && q) {
    const idMatch = q.match(FEATURE_ID_PATTERN);
    if (idMatch) targetId = idMatch[0];
  }

  if (targetId) {
    const feat = featureRegistry.getFeatureById(targetId, projectId);
    if (feat) {
      return {
        status: "RESOLVED",
        level: 1,
        matched_by: "exact_feature_id",
        confidence: 1.0,
        feature: feat,
        candidates: [feat.feature_id],
      };
    }
  }

  if (!q) {
    return { status: "NOT_FOUND", reason: "Empty query", level: 6 };
  }

  const allFeatures = typeof featureRegistry.getFeatures === "function" ? featureRegistry.getFeatures(projectId) : [];

  // LEVEL 2 — Exact Canonical Title
  let byName = featureRegistry.getFeatureByName(q, projectId);
  if (!byName && allFeatures.length) {
    const qLower = q.toLowerCase();
    const matched = allFeatures.filter(
      (f) => f.canonical_name && qLower.includes(f.canonical_name.toLowerCase())
    );
    if (matched.length === 1) {
      byName = matched[0];
    } else if (matched.length > 1) {
      return {
        status: "AMBIGUOUS",
        level: 2,
        matched_by: "canonical_name",
        confidence: 0.5,
        candidates: matched.map((f) => f.feature_id),
        reason: `Query matches multiple canonical names: ${matched.map((f) => f.feature_id).join(", ")}`,
      };
    }
  }
  if (byName) {
    if (byName.ambiguous) {
      return {
        status: "AMBIGUOUS",
        level: 2,
        matched_by: "canonical_name",
        confidence: 0.5,
        candidates: byName.candidates || [],
        reason: byName.reason,
      };
    }
    return {
      status: "RESOLVED",
      level: 2,
      matched_by: "canonical_name",
      confidence: 0.95,
      feature: byName,
      candidates: [byName.feature_id],
    };
  }

  // LEVEL 3 — Exact Registered Alias
  let byAlias = featureRegistry.getFeatureByAlias(q, projectId);
  if (!byAlias && allFeatures.length) {
    const qLower = q.toLowerCase();
    const matched = [];
    for (const feat of allFeatures) {
      const aliases = Array.isArray(feat.aliases) ? feat.aliases : [];
      for (const a of aliases) {
        if (a && a.length >= 3 && qLower.includes(a.toLowerCase())) {
          if (!matched.some((m) => m.feature_id === feat.feature_id)) {
            matched.push(feat);
          }
          break;
        }
      }
    }
    if (matched.length === 1) {
      byAlias = matched[0];
    } else if (matched.length > 1) {
      return {
        status: "AMBIGUOUS",
        level: 3,
        matched_by: "alias",
        confidence: 0.5,
        candidates: matched.map((f) => f.feature_id),
        reason: `Query matches multiple feature aliases: ${matched.map((f) => f.feature_id).join(", ")}`,
      };
    }
  }
  if (byAlias) {
    if (byAlias.ambiguous) {
      return {
        status: "AMBIGUOUS",
        level: 3,
        matched_by: "alias",
        confidence: 0.5,
        candidates: byAlias.candidates || [],
        reason: byAlias.reason,
      };
    }
    return {
      status: "RESOLVED",
      level: 3,
      matched_by: "alias",
      confidence: 0.9,
      feature: byAlias,
      candidates: [byAlias.feature_id],
    };
  }

  // LEVEL 4 — Exact Registered Keyword (with specificity scoring for multi-word natural queries)
  let byKw = featureRegistry.findFeaturesByKeyword(q, projectId);
  if ((!byKw || byKw.length === 0) && allFeatures.length) {
    const scored = [];
    for (const feat of allFeatures) {
      const kws = Array.isArray(feat.keywords) ? feat.keywords : [];
      let score = 0;
      let hitCount = 0;
      for (const kw of kws) {
        if (kw && kw.length >= 3) {
          const re = new RegExp(`\\b${kw.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i");
          if (re.test(q)) {
            hitCount++;
            score += kw.includes(" ") ? 6 : 3;
          }
        }
      }
      if (hitCount > 0) {
        scored.push({ feat, score, hitCount });
      }
    }
    scored.sort((a, b) => b.score - a.score || a.feat.feature_id.localeCompare(b.feat.feature_id));
    if (scored.length === 1) {
      byKw = [scored[0].feat];
    } else if (scored.length > 1) {
      if (scored[0].score >= 1.5 * scored[1].score) {
        byKw = [scored[0].feat];
      } else {
        byKw = scored.map((s) => s.feat).sort((a, b) => a.feature_id.localeCompare(b.feature_id));
      }
    }
  }
  if (byKw.length === 1) {
    return {
      status: "RESOLVED",
      level: 4,
      matched_by: "keyword",
      confidence: 0.85,
      feature: byKw[0],
      candidates: [byKw[0].feature_id],
    };
  } else if (byKw.length > 1) {
    return {
      status: "AMBIGUOUS",
      level: 4,
      matched_by: "keyword",
      confidence: 0.5,
      candidates: byKw.map((f) => f.feature_id),
      reason: `Keyword in query matches multiple registered features: ${byKw.map((f) => f.feature_id).join(", ")}`,
    };
  }

  // LEVEL 5 — Deterministic Metadata Match (e.g. document_id or tag)
  if (typeof featureRegistry.getFeatureByMetadata === "function") {
    const byMeta = featureRegistry.getFeatureByMetadata(q, projectId);
    if (byMeta) {
      return {
        status: "RESOLVED",
        level: 5,
        matched_by: "metadata",
        confidence: 0.8,
        feature: byMeta,
        candidates: [byMeta.feature_id],
      };
    }
  }

  // LEVEL 6 — Unresolved
  return {
    status: "NOT_FOUND",
    level: 6,
    matched_by: null,
    confidence: 0,
    candidates: [],
    reason: `No deterministic feature match found for '${q}'`,
  };
}

// ---------------------------------------------------------------------------
// Authoritative Lookup Service Factory
// ---------------------------------------------------------------------------

function createAuthoritativeLookup({
  db,
  ragStore,
  temporalStore,
  featureRegistry,
  options = {},
  now = Date.now,
  log = () => {},
} = {}) {
  const resolvedTemporal = temporalStore || ragStore?.temporal;
  const cache = new Map(); // key -> cached result
  const maxCacheSize = options.maxCacheSize || 256;

  function clearCache() {
    cache.clear();
  }

  /**
   * Main ALS Lookup Method.
   * Resolves canonical feature facts before vector retrieval.
   */
  async function lookup({
    projectId,
    query = "",
    featureId = null,
    version = null,
    asOf = null,
    asOfStart = null,
    asOfEnd = null,
    includeDeprecated = false,
    includeDrafts = false,
    limit = 10,
    bypassCache = false,
  }) {
    if (!projectId) {
      return {
        status: "ERROR",
        error: "Missing required 'projectId'",
        conflicts: [],
        warnings: [],
      };
    }

    const q = String(query || "").trim();

    // Cache key construction
    // Spacing and end punctuation never change what is asked; case can (ids match exactly), so it stays in the key.
    const qKey = q.replace(/\s+/g, " ").replace(/[\s.?!,;:]+$/g, "");
    const cacheKey = `${projectId}:${featureId || ""}:${version || ""}:${asOf || ""}:${asOfStart || ""}:${asOfEnd || ""}:${includeDeprecated}:${includeDrafts}:${qKey}`;
    if (!bypassCache && cache.has(cacheKey)) {
      const hit = cache.get(cacheKey);
      cache.delete(cacheKey); // least recently used goes first
      cache.set(cacheKey, hit);
      return hit;
    }

    // 1. Match canonical feature deterministically
    const match = matchDeterministicPrecedence({
      query: q,
      featureId,
      featureRegistry,
      projectId,
    });

    if (match.status === "AMBIGUOUS") {
      const res = {
        status: "AMBIGUOUS",
        query: q,
        match: {
          matched_by: match.matched_by,
          confidence: match.confidence,
          candidates: match.candidates,
        },
        reason: match.reason,
        candidates: match.candidates,
        conflicts: [],
        warnings: [match.reason],
      };
      return res;
    }

    if (match.status !== "RESOLVED" || !match.feature) {
      const res = {
        status: "NOT_FOUND",
        query: q,
        match: {
          matched_by: null,
          confidence: 0,
          candidates: [],
        },
        reason: match.reason || "No deterministic canonical match",
        conflicts: [],
        warnings: [],
      };
      return res;
    }

    const feat = match.feature;
    const featId = feat.feature_id;

    // 2. Version Resolution
    // Check if query or parameter specifies an explicit version
    let requestedVersion = version;
    if (!requestedVersion && q) {
      const verMatch = q.match(SEMVER_PATTERN);
      if (verMatch) requestedVersion = verMatch[1];
    }

    let chunks = [];
    let resolvedVersionStr = null;
    let approvalStatus = "approved";
    let lifecycleStatus = "active";
    let isHistorical = false;
    let isPointInTime = false;
    const warnings = [];
    const conflicts = [];

    // Branch A: Point-in-Time / Range Resolution (asOf / asOfStart..asOfEnd)
    if ((asOf != null || (asOfStart != null && asOfEnd != null)) && resolvedTemporal) {
      isPointInTime = true;
      if (asOfStart != null && asOfEnd != null && typeof resolvedTemporal.getFeatureInRange === "function") {
        chunks = resolvedTemporal.getFeatureInRange(projectId, featId, Number(asOfStart), Number(asOfEnd));
      } else if (asOf != null) {
        chunks = resolvedTemporal.getFeatureAt(projectId, featId, Number(asOf));
      }
      if (chunks.length > 0) {
        resolvedVersionStr = chunks[0].version;
        lifecycleStatus = chunks[0].lifecycle_status;
        approvalStatus = "approved";
        isHistorical = chunks[0].lifecycle_status === "superseded";
      }
    }
    // Branch B: Explicit Version Resolution
    else if (requestedVersion && db) {
      resolvedVersionStr = requestedVersion;
      const rows = db
        .prepare(
          `SELECT * FROM copilot_chunks 
           WHERE project_id = ? AND feature_id = ? AND version = ? 
           ORDER BY ord ASC`
        )
        .all(projectId, featId, requestedVersion);

      chunks = rows;
      if (chunks.length > 0) {
        lifecycleStatus = chunks[0].lifecycle_status;
        isHistorical = chunks[0].lifecycle_status === "superseded";
      }
    }
    // Branch C: Current Approved Version (Default)
    else if (resolvedTemporal) {
      chunks = resolvedTemporal.getActiveFeatureChunks(projectId, featId);
      if (chunks.length > 0) {
        resolvedVersionStr = chunks[0].version;
        lifecycleStatus = chunks[0].lifecycle_status;
        approvalStatus = "approved";
      } else {
        // Check if feature registry has an approved version record
        const appVer = featureRegistry.getCurrentApprovedVersion(featId, projectId);
        if (appVer && appVer.status === "resolved") {
          resolvedVersionStr = appVer.version;
          lifecycleStatus = appVer.lifecycle_status;
        }
      }
    }

    // 3. Approval and Lifecycle Filtering
    // Check for draft / pending records in database if chunks is still empty or includeDrafts is requested
    if ((chunks.length === 0 || includeDrafts) && db) {
      const drafts = db
        .prepare(
          `SELECT * FROM copilot_chunks 
           WHERE project_id = ? AND feature_id = ? AND lifecycle_status IN ('draft', 'pending')
           ORDER BY id DESC`
        )
        .all(projectId, featId);

      if (drafts.length > 0) {
        if (includeDrafts) {
          chunks = drafts;
          resolvedVersionStr = drafts[0].version;
          lifecycleStatus = drafts[0].lifecycle_status;
          approvalStatus = "draft";
        } else if (chunks.length === 0) {
          warnings.push(`Feature '${featId}' has pending draft records, but draft records are excluded by default.`);
        }
      }
    }

    // Check for deprecated records in database if chunks is still empty or includeDeprecated is requested
    if (db && (chunks.length === 0 || includeDeprecated)) {
      const depRows = db
        .prepare(
          `SELECT * FROM copilot_chunks 
           WHERE project_id = ? AND feature_id = ? AND lifecycle_status = 'deprecated'
           ORDER BY id DESC`
        )
        .all(projectId, featId);

      if (depRows.length > 0) {
        lifecycleStatus = "deprecated";
        resolvedVersionStr = depRows[0].version || resolvedVersionStr;
        if (includeDeprecated) {
          chunks = depRows;
        }
      }
    }

    // Deprecation check
    if (feat.lifecycle_status === "deprecated" || lifecycleStatus === "deprecated") {
      if (!includeDeprecated && !isHistorical && !isPointInTime) {
        const res = {
          status: "RESOLVED",
          query: q,
          feature: {
            feature_id: feat.feature_id,
            canonical_name: feat.canonical_name,
            domain: feat.domain,
          },
          version: {
            version: resolvedVersionStr || feat.current_approved_version,
            approval_status: approvalStatus,
            lifecycle_status: "deprecated",
          },
          facts: [],
          match: {
            matched_by: match.matched_by,
            confidence: match.confidence,
            candidates: match.candidates,
          },
          authority: {
            status: "DEPRECATED",
            explanation: `Feature '${featId}' is deprecated and excluded from current authoritative results. Use includeDeprecated to retrieve.`,
          },
          conflicts: [],
          warnings: [`Feature '${featId}' is deprecated.`],
        };
        return res;
      }
    }

    // Consistency Check: Registry vs Database records
    if (chunks.length === 0) {
      // If feature registry says version is approved, but database holds zero chunks for this project
      const regVer = feat.current_approved_version;
      const res = {
        status: "RESOLVED",
        query: q,
        feature: {
          feature_id: feat.feature_id,
          canonical_name: feat.canonical_name,
          domain: feat.domain,
        },
        version: {
          version: resolvedVersionStr || regVer,
          approval_status: approvalStatus,
          lifecycle_status: lifecycleStatus,
        },
        facts: [],
        match: {
          matched_by: match.matched_by,
          confidence: match.confidence,
          candidates: match.candidates,
        },
        authority: {
          status: "INCONSISTENT",
          explanation: `Feature '${featId}' registered with approved version '${regVer}', but no chunks exist in project '${projectId}'.`,
        },
        conflicts: [],
        warnings: [`No physical chunks found for feature '${featId}' in project '${projectId}'.`],
      };
      return res;
    }

    // 4. Source Precedence Evaluation
    // Classify source authority for each chunk
    const rankedFacts = [];
    const seenHashes = new Set();
    const sourceAuthorityMap = new Map(); // source_id -> authority tier

    for (const c of chunks) {
      let meta = {};
      try {
        meta = typeof c.meta === "string" ? JSON.parse(c.meta || "{}") : c.meta || {};
      } catch (error) {
        log({ event: "corrupt_meta", chunk_id: c.id, error: error.message });
      }

      const sourceName = meta.source || c.source || `doc_${c.file_id}`;
      const sourceId = String(c.file_id || meta.section_id || sourceName);
      const tier = classifySourceAuthority(
        { source_name: sourceName, source_id: sourceId, source_type: meta.source_type },
        { approvalStatus, lifecycleStatus: c.lifecycle_status || lifecycleStatus }
      );

      sourceAuthorityMap.set(sourceId, tier);

      // Check for conflicting distinct chunks at the same authority level
      const chunkKey = c.hash || `chunk_${c.id}`;
      if (seenHashes.has(chunkKey)) continue;
      seenHashes.add(chunkKey);

      rankedFacts.push({
        chunk_id: c.id,
        text: c.text,
        content_hash: c.hash,
        source_id: sourceId,
        source_name: sourceName,
        section_id: meta.section_id || null,
        page: meta.page != null ? meta.page : c.page != null ? c.page : null,
        authority_tier: tier.name,
        authority_score: tier.score,
        valid_from: c.valid_from,
        valid_to: c.valid_to,
      });
    }

    // Detect conflicting approved sources: different text/hash with equal top score
    if (rankedFacts.length > 1) {
      const topScore = Math.max(...rankedFacts.map((f) => f.authority_score));
      const topFacts = rankedFacts.filter((f) => f.authority_score === topScore);
      if (topFacts.length > 1) {
        // If content differs between top tier facts, surface explicit conflict
        const uniqueTexts = new Set(topFacts.map((f) => f.text.trim()));
        if (uniqueTexts.size > 1) {
          conflicts.push({
            type: "CONFLICTING_APPROVED_SOURCES",
            severity: "warning",
            sources: topFacts.map((f) => ({ source_id: f.source_id, source_name: f.source_name, chunk_id: f.chunk_id })),
            message: `Multiple approved sources at authority tier '${topFacts[0].authority_tier}' provide differing requirements for '${featId}'.`,
          });
        }
      }
    }

    // Sort facts deterministically by authority score descending, then chunk_id ascending
    rankedFacts.sort((a, b) => b.authority_score - a.authority_score || a.chunk_id - b.chunk_id);
    const selectedFacts = rankedFacts.slice(0, limit);

    // Authority status determination
    let authorityStatus = "AUTHORITATIVE";
    if (lifecycleStatus === "rejected" || approvalStatus === "rejected") {
      authorityStatus = "REJECTED";
      warnings.push(`Content for '${featId}' version '${resolvedVersionStr}' is marked rejected.`);
    } else if (approvalStatus === "draft" || approvalStatus === "pending") {
      authorityStatus = "NON_AUTHORITATIVE";
    } else if (isHistorical || lifecycleStatus === "superseded") {
      authorityStatus = "HISTORICAL";
    } else if (lifecycleStatus === "deprecated") {
      authorityStatus = "DEPRECATED";
    }

    const primaryTier = selectedFacts[0]?.authority_tier || "Standard Requirement";

    const result = {
      status: "RESOLVED",
      query: q,
      feature: {
        feature_id: feat.feature_id,
        canonical_name: feat.canonical_name,
        domain: feat.domain,
      },
      version: {
        version: resolvedVersionStr || feat.current_approved_version,
        approval_status: approvalStatus,
        lifecycle_status: lifecycleStatus,
        valid_from: chunks[0]?.valid_from ?? null,
        valid_to: chunks[0]?.valid_to ?? null,
      },
      facts: selectedFacts,
      match: {
        matched_by: match.matched_by,
        confidence: match.confidence,
        candidates: match.candidates,
      },
      authority: {
        status: authorityStatus,
        source_precedence: primaryTier,
        explanation: `Resolved via ${match.matched_by} with authority ${primaryTier}.`,
      },
      conflicts,
      warnings,
    };

    // Store in deterministic cache
    if (cache.size >= maxCacheSize) {
      const firstKey = cache.keys().next().value;
      cache.delete(firstKey);
    }
    cache.set(cacheKey, result);

    return result;
  }

  return {
    lookup,
    clearCache,
    classifySourceAuthority,
    matchDeterministicPrecedence: (params) =>
      matchDeterministicPrecedence({ ...params, featureRegistry }),
  };
}

module.exports = {
  createAuthoritativeLookup,
  classifySourceAuthority,
  matchDeterministicPrecedence,
  SOURCE_PRECEDENCE_TIERS,
};
