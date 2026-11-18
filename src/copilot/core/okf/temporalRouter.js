// src/copilot/core/okf/temporalRouter.js
// Temporal OKF Router Gate for Meethu Copilot.
// Classifies queries into CURRENT_STATE, HISTORICAL_STATE, or DIFF_EVOLUTION,
// extracts temporal parameters (dates, quarters, versions), resolves canonical feature identities,
// and coordinates deterministic retrieval with ALS and temporalStore before vector search.

const { matchDeterministicPrecedence } = require("../../rag/authoritativeLookup");

// ---------------------------------------------------------------------------
// Intent Classification Rules & Precedence
// ---------------------------------------------------------------------------

const DIFF_PATTERNS = [
  /\b(?:compare|comparison|diff|difference|differences|versus|vs\.?)\b/i,
  /\b(?:evolve|evolved|evolution|how has .* evolved)\b/i,
  /\b(?:what changed|changes between|changed between|what was updated)\b/i,
  /\b(?:transition|transitioned|upgraded from|migration from|changed since)\b/i,
  /\b(?:difference between|contrast)\b/i,
];

const HISTORICAL_PATTERNS = [
  /\bin\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}\b/i,
  /\b(?:as\s+of|as\s+at)\s+[a-z0-9, -]+\b/i,
  /\b(?:originally|historical|previously|prior to|back in|on\s+\d{4}-\d{2}-\d{2})\b/i,
  /\bbefore\s+(?:the\s+upgrade|the\s+change|phase\s+\d+|v\d+|version\s+\d+)\b/i,
  /\b(?:q[1-4]\s+\d{4}|fy\d{4})\b/i,
  /\b(?:version\s+1(?:\.0(?:\.0)?)?|v1(?:\.0(?:\.0)?)?)\b/i,
  /\b(?:old\s+version|initial\s+version|first\s+version)\b/i,
];

// Patterns that indicate focus remains on the current state despite words like "change" or "upgrade"
const CURRENT_OVERRIDE_PATTERNS = [
  /\bwhat\s+is\s+the\s+current\s+.*after\s+the\s+change\b/i,
  /\bwhat\s+is\s+(?:our|the)\s+current\b/i,
  /\bcurrently\b/i,
  /\bactive\s+(?:requirement|architecture|pipeline|feature|specification)\b/i,
  /\bexisting\s+(?:architecture|requirement|system)\b/i,
];

/**
 * Classifies query into CURRENT_STATE, HISTORICAL_STATE, or DIFF_EVOLUTION.
 * Precedence:
 * 1. DIFF_EVOLUTION (comparison / change language)
 * 2. HISTORICAL_STATE (dates, previous versions, point-in-time)
 * 3. CURRENT_STATE (default)
 */
function classifyTemporalIntent(query) {
  const q = String(query || "").trim();
  if (!q) {
    return {
      intent: "CURRENT_STATE",
      confidence: 1.0,
      reason: "Empty query defaults to CURRENT_STATE",
    };
  }

  // Check explicit current override first
  for (const pattern of CURRENT_OVERRIDE_PATTERNS) {
    if (pattern.test(q)) {
      // If it also explicitly asks to compare, diff wins
      if (/\b(?:compare|versus|vs\.?|difference between)\b/i.test(q)) {
        return {
          intent: "DIFF_EVOLUTION",
          confidence: 0.95,
          reason: "Explicit comparison between current and prior state",
        };
      }
      return {
        intent: "CURRENT_STATE",
        confidence: 0.95,
        reason: "Explicit current state request overrides change keywords",
      };
    }
  }

  // 1. DIFF_EVOLUTION check
  for (const pattern of DIFF_PATTERNS) {
    if (pattern.test(q)) {
      return {
        intent: "DIFF_EVOLUTION",
        confidence: 0.95,
        reason: `Matched evolution/comparison pattern: ${pattern}`,
      };
    }
  }

  // 2. HISTORICAL_STATE check
  for (const pattern of HISTORICAL_PATTERNS) {
    if (pattern.test(q)) {
      return {
        intent: "HISTORICAL_STATE",
        confidence: 0.9,
        reason: `Matched historical/point-in-time pattern: ${pattern}`,
      };
    }
  }

  // 3. CURRENT_STATE (default)
  return {
    intent: "CURRENT_STATE",
    confidence: 0.85,
    reason: "No historical or evolution qualifiers; default to CURRENT_STATE",
  };
}

// ---------------------------------------------------------------------------
// Temporal Parameter Extraction
// ---------------------------------------------------------------------------

const MONTHS = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

/**
 * Extracts temporal parameters (asOf, version, from, to) from query text.
 */
function extractTemporalParameters(query, { now = Date.now } = {}) {
  const q = String(query || "").trim();
  const ambiguity = [];
  const temporal = {
    asOf: null,
    version: null,
    from: null,
    to: null,
  };

  const currentTime = now();
  const currentYear = new Date(currentTime).getUTCFullYear();

  // A. Month & Year: "January 2026", "March 1, 2026", "March 1st, 2026"
  const dateMatch = q.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})?(?:st|nd|rd|th)?,?\s*(\d{4})\b/i);
  if (dateMatch) {
    const monthIndex = MONTHS[dateMatch[1].toLowerCase()];
    const hasDay = Boolean(dateMatch[2]);
    const day = hasDay ? Number(dateMatch[2]) : 1;
    const year = Number(dateMatch[3]);
    const ts = Date.UTC(year, monthIndex, day, 0, 0, 0, 0);
    temporal.asOf = ts;
    temporal.from = ts;
    if (!hasDay) {
      // Month-only historical query (e.g., "in August 2026"): span the full calendar month
      // so documents effective mid-month (e.g., 21 August 2026) match via range overlap.
      temporal.to = Date.UTC(year, monthIndex + 1, 0, 23, 59, 59, 999);
    }
  }

  // ISO Date: "2026-03-01"
  const isoMatch = q.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]) - 1;
    const day = Number(isoMatch[3]);
    const ts = Date.UTC(year, month, day, 0, 0, 0, 0);
    temporal.asOf = ts;
    temporal.from = ts;
  }

  // Quarters: "Q1 2026", "Q3 2025"
  const quarterMatch = q.match(/\bq([1-4])\s+(\d{4})\b/i);
  if (quarterMatch) {
    const qNum = Number(quarterMatch[1]);
    const year = Number(quarterMatch[2]);
    const startMonth = (qNum - 1) * 3;
    const endMonth = startMonth + 2;
    temporal.from = Date.UTC(year, startMonth, 1, 0, 0, 0, 0);
    temporal.to = Date.UTC(year, endMonth + 1, 0, 23, 59, 59, 999);
    temporal.asOf = temporal.from;
  }

  // Fiscal Years: "FY2026", "FY 2026"
  const fyMatch = q.match(/\bfy\s*(\d{4})\b/i);
  if (fyMatch) {
    const year = Number(fyMatch[1]);
    temporal.from = Date.UTC(year, 0, 1, 0, 0, 0, 0);
    temporal.to = Date.UTC(year, 11, 31, 23, 59, 59, 999);
    temporal.asOf = temporal.from;
  }

  // Relative references
  if (/\blast\s+month\b/i.test(q)) {
    const d = new Date(currentTime);
    d.setUTCMonth(d.getUTCMonth() - 1);
    temporal.from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    temporal.to = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59, 999);
    temporal.asOf = temporal.from;
  } else if (/\blast\s+quarter\b/i.test(q)) {
    const d = new Date(currentTime);
    const currQ = Math.floor(d.getUTCMonth() / 3);
    const prevQ = currQ === 0 ? 3 : currQ - 1;
    const year = currQ === 0 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
    temporal.from = Date.UTC(year, prevQ * 3, 1);
    temporal.to = Date.UTC(year, prevQ * 3 + 3, 0, 23, 59, 59, 999);
    temporal.asOf = temporal.from;
  } else if (/\bsince\s+january\b/i.test(q)) {
    temporal.from = Date.UTC(currentYear, 0, 1);
    temporal.to = currentTime;
  }

  // Version-based extraction
  // 1. Multiple versions for comparison: "v1 and v2", "version 1.0.0 and version 2.0.0"
  const verPairMatch = q.match(/\b(?:version|v)[\s:]*([0-9]+(?:\.[0-9]+)*)\s*(?:and|to|vs\.?|versus)\s*(?:version|v)?[\s:]*([0-9]+(?:\.[0-9]+)*)\b/i);
  if (verPairMatch) {
    temporal.from = normalizeSemver(verPairMatch[1]);
    temporal.to = normalizeSemver(verPairMatch[2]);
    temporal.version = temporal.to;
  } else {
    // 2. Single explicit version: "version 1.0.0", "v2.0.0", "version 1"
    const singleVerMatch = q.match(/\b(?:version|v)[\s:]*([0-9]+(?:\.[0-9]+)*(?:-[a-z0-9.]+)?)\b/i);
    if (singleVerMatch) {
      temporal.version = normalizeSemver(singleVerMatch[1]);
    }
  }

  // Check for ambiguous relative dates (e.g. "some time ago", "back then")
  if (/\b(?:some\s+time\s+ago|back\s+then|previously|formerly)\b/i.test(q) && temporal.asOf == null && temporal.version == null) {
    ambiguity.push("Unanchored relative temporal reference without a determinable timestamp");
  }

  return { temporal, ambiguity };
}

function normalizeSemver(verStr) {
  if (!verStr) return null;
  const parts = String(verStr).trim().split(".");
  if (parts.length === 1) return `${parts[0]}.0.0`;
  if (parts.length === 2) return `${parts[0]}.${parts[1]}.0`;
  return verStr;
}

// ---------------------------------------------------------------------------
// Temporal Router Factory
// ---------------------------------------------------------------------------

const QUERY_STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "what", "when", "where", "which",
  "how", "does", "are", "was", "were", "has", "have", "had", "can", "could",
  "would", "should", "our", "your", "from", "into", "about", "there", "their",
  "they", "them", "will", "just", "than", "then", "also", "been", "being",
]);

function rankEvidenceByQuery(items, query) {
  if (!Array.isArray(items) || items.length <= 1 || !query) return items;
  const tokens = String(query)
    .toLowerCase()
    .replace(/[^a-z0-9%.-]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !QUERY_STOPWORDS.has(t));
  if (tokens.length === 0) return items;

  const uniqueTokens = [...new Set(tokens)];
  const scored = items.map((item, idx) => {
    const body = String(item.text || item.content || "");
    const firstLine = body.split("\n")[0] || "";
    const hay = `${item.source || ""} ${body}`.toLowerCase();
    const headHay = firstLine.toLowerCase();
    let score = 0;
    for (const tok of uniqueTokens) {
      if (headHay.includes(tok)) score += 4;
      if (hay.includes(tok)) {
        score += tok.length >= 6 ? 3 : 2;
      }
    }
    // Prefer information-dense specification sections over short intro/overview paragraphs
    if (body.length >= 180) score += 1;
    if (
      /\b(?:aws infrastructure|fargate|t3\.large|db\.t3\.micro|runbook|backup|auction bro|delivery timeline|week 1|week 2|v5 demo|v5 design|faq|append-only|hash-chained|post sale|outcomes|workshop contact|settings)\b/i.test(
        body
      )
    ) {
      score += 3;
    }
    return { item, score, idx };
  });

  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return scored.map((s) => s.item);
}

function createTemporalRouter({
  featureRegistry,
  temporalStore,
  authoritativeLookup,
  now = Date.now,
  options = {},
} = {}) {
  const routerCache = new Map();
  const maxCacheSize = options.maxCacheSize || 256;

  function clearCache() {
    routerCache.clear();
  }

  /**
   * Routes a query based on its temporal intent and canonical features.
   */
  async function routeTemporalQuery({
    projectId = null,
    projectIds = null,
    query = "",
    featureId = null,
    asOf = null,
    version = null,
    includeDeprecated = false,
    bypassCache = false,
  }) {
    const q = String(query || "").trim();
    const resolvedProjectIds = Array.isArray(projectIds) && projectIds.length
      ? projectIds.filter(Boolean)
      : projectId != null
        ? [projectId]
        : [];
    const primaryProjectId = resolvedProjectIds[0] ?? projectId;

    // 1. Classify Intent
    const classification = classifyTemporalIntent(q);
    let intent = classification.intent;

    // 2. Extract Temporal Parameters
    const { temporal: extractedTemporal, ambiguity: dateAmbiguity } = extractTemporalParameters(q, { now });

    const finalAsOf = asOf != null ? Number(asOf) : extractedTemporal.asOf;
    const finalVersion = version != null ? String(version) : extractedTemporal.version;
    const finalFrom = extractedTemporal.from;
    const finalTo = extractedTemporal.to;

    // Numeric range bounds for month/quarter/FY historical queries (unless caller pinned an exact asOf)
    const rangeStart =
      asOf == null && typeof finalFrom === "number" && typeof finalTo === "number" ? finalFrom : null;
    const rangeEnd =
      asOf == null && typeof finalFrom === "number" && typeof finalTo === "number" ? finalTo : null;

    // If explicit asOf or version is provided and not DIFF_EVOLUTION, promote to HISTORICAL_STATE
    if (intent !== "DIFF_EVOLUTION" && (finalAsOf != null || finalVersion != null)) {
      intent = "HISTORICAL_STATE";
    }

    // Cache key construction
    const projKey = resolvedProjectIds.join(",");
    const cacheKey = `${projKey}:${featureId || ""}:${intent}:${finalAsOf || ""}:${finalVersion || ""}:${finalFrom || ""}:${finalTo || ""}:${includeDeprecated}:${q}`;
    if (!bypassCache && routerCache.has(cacheKey)) {
      return routerCache.get(cacheKey);
    }

    // 3. Resolve Canonical Feature
    const match = matchDeterministicPrecedence({
      query: q,
      featureId,
      featureRegistry,
      projectId: primaryProjectId,
    });

    const featureIds = match.status === "RESOLVED" && match.feature ? [match.feature.feature_id] : match.candidates || [];
    const ambiguity = [...dateAmbiguity];
    if (match.status === "AMBIGUOUS") {
      ambiguity.push(match.reason || "Ambiguous feature match");
    }

    const plan = {
      intent,
      featureIds,
      temporal: {
        asOf: finalAsOf,
        version: finalVersion,
        from: finalFrom,
        to: finalTo,
      },
      confidence: match.status === "RESOLVED" ? classification.confidence : 0.5,
      ambiguity,
      routingReason: classification.reason,
      featureMatch: match,
    };

    // 4. Execute Retrieval Plan
    let evidence = [];
    let conflicts = [];
    let passages = "";
    let status = match.status === "AMBIGUOUS" ? "AMBIGUOUS" : match.status === "RESOLVED" ? "RESOLVED" : "NOT_FOUND";

    if (status === "RESOLVED" && match.feature && authoritativeLookup) {
      const feat = match.feature;
      const targetFeatureId = feat.feature_id;

      // Helper to run ALS across all projectIds and merge facts
      const lookupAcrossProjects = async (params) => {
        const pids = resolvedProjectIds.length ? resolvedProjectIds : [primaryProjectId];
        let bestRes = null;
        const mergedFacts = [];
        const mergedConflicts = [];
        for (const pid of pids) {
          const r = await authoritativeLookup.lookup({ ...params, projectId: pid });
          if (r && r.facts?.length) {
            if (!bestRes) bestRes = r;
            mergedFacts.push(...r.facts);
          } else if (!bestRes && r) {
            bestRes = r;
          }
          if (r?.conflicts?.length) mergedConflicts.push(...r.conflicts);
        }
        if (!bestRes) return { facts: [], conflicts: [], version: null };
        return { ...bestRes, facts: mergedFacts, conflicts: mergedConflicts };
      };

      // ---- BRANCH A: CURRENT_STATE ----
      if (intent === "CURRENT_STATE") {
        const alsRes = await lookupAcrossProjects({
          query: q,
          featureId: targetFeatureId,
          includeDeprecated: false,
          includeDrafts: false,
          bypassCache,
        });

        conflicts = alsRes.conflicts || [];
        const rawEvidence = (alsRes.facts || []).map((f) => ({
          feature_id: targetFeatureId,
          featureId: targetFeatureId,
          feature_name: feat.canonical_name,
          version: alsRes.version?.version || feat.current_approved_version,
          lifecycle_status: alsRes.version?.lifecycle_status || "active",
          lifecycleStatus: alsRes.version?.lifecycle_status || "active",
          approval_status: alsRes.version?.approval_status || "approved",
          approvalStatus: alsRes.version?.approval_status || "approved",
          valid_from: alsRes.version?.valid_from || null,
          validFrom: alsRes.version?.valid_from || null,
          valid_to: alsRes.version?.valid_to || null,
          validTo: alsRes.version?.valid_to || null,
          source: f.source_name,
          role: "CURRENT",
          text: f.text,
          chunk_id: f.chunk_id,
        }));
        evidence = rankEvidenceByQuery(rawEvidence, q);

        const versionStr = alsRes.version?.version || feat.current_approved_version;
        const sourceName = evidence[0]?.source || "Canonical Registry";
        const perSectionCap = evidence.length > 1 ? 1800 : 3200;
        const factsText = evidence
          .slice(0, 4)
          .map((e) => (e.text.length > perSectionCap ? `${e.text.slice(0, perSectionCap - 1).trimEnd()}…` : e.text))
          .join("\n\n");

        passages = `[QUERY INTENT: CURRENT_STATE]\n[AUTHORITATIVE VERSION: ${versionStr}]\n[STATUS: APPROVED]\n[SOURCE: ${sourceName}]\n\n${factsText}`.trim();
      }

      // ---- BRANCH B: HISTORICAL_STATE ----
      else if (intent === "HISTORICAL_STATE") {
        const alsRes = await lookupAcrossProjects({
          query: q,
          featureId: targetFeatureId,
          asOf: finalAsOf,
          asOfStart: rangeStart,
          asOfEnd: rangeEnd,
          version: finalVersion,
          includeDeprecated: true,
          bypassCache,
        });

        conflicts = alsRes.conflicts || [];
        const rawEvidence = (alsRes.facts || []).map((f) => ({
          feature_id: targetFeatureId,
          featureId: targetFeatureId,
          feature_name: feat.canonical_name,
          version: alsRes.version?.version || "historical",
          lifecycle_status: alsRes.version?.lifecycle_status || "superseded",
          lifecycleStatus: alsRes.version?.lifecycle_status || "superseded",
          approval_status: alsRes.version?.approval_status || "approved",
          approvalStatus: alsRes.version?.approval_status || "approved",
          valid_from: alsRes.version?.valid_from || null,
          validFrom: alsRes.version?.valid_from || null,
          valid_to: alsRes.version?.valid_to || null,
          validTo: alsRes.version?.valid_to || null,
          source: f.source_name,
          role: "HISTORICAL",
          text: f.text,
          chunk_id: f.chunk_id,
        }));
        evidence = rankEvidenceByQuery(rawEvidence, q);

        const timeLabel = finalAsOf ? new Date(finalAsOf).toISOString().split("T")[0] : finalVersion || "historical";
        const versionStr = alsRes.version?.version || "1.0.0";
        const factsText = evidence
          .slice(0, 4)
          .map((e) => e.text)
          .join("\n\n");

        passages = `[QUERY INTENT: HISTORICAL_STATE]\n[REQUESTED TIME: ${timeLabel}]\n[RESOLVED VERSION: ${versionStr}]\n[STATUS: HISTORICAL]\n\n${factsText}`.trim();
      }

      // ---- BRANCH C: DIFF_EVOLUTION ----
      else if (intent === "DIFF_EVOLUTION") {
        let lineage = [];
        if (temporalStore && typeof temporalStore.getFeatureLineage === "function") {
          const pids = resolvedProjectIds.length ? resolvedProjectIds : [primaryProjectId];
          for (const pid of pids) {
            const rows = temporalStore.getFeatureLineage(pid, targetFeatureId);
            if (rows?.length) lineage.push(...rows);
          }
        }

        // Sort lineage chronologically ascending
        lineage.sort((a, b) => (a.valid_from || 0) - (b.valid_from || 0) || a.id - b.id);

        if (lineage.length >= 2) {
          // Group chunks by distinct version (chronologically) and pick query-most-relevant chunk per version
          const groupsByVer = [];
          const verMap = new Map();
          for (const row of lineage) {
            const verKey = row.version || `v_${row.valid_from || row.id}`;
            if (!verMap.has(verKey)) {
              const g = { version: row.version || "1.0.0", rows: [] };
              verMap.set(verKey, g);
              groupsByVer.push(g);
            }
            verMap.get(verKey).rows.push(row);
          }

          const stageChunks =
            groupsByVer.length >= 2
              ? groupsByVer.map((g) => rankEvidenceByQuery(g.rows, q)[0])
              : [lineage[0], lineage[lineage.length - 1]];

          const lastIdx = stageChunks.length - 1;
          evidence = stageChunks.map((chunk, idx) => {
            const role = idx === 0 ? "BEFORE" : idx === lastIdx ? "AFTER" : "INTERMEDIATE";
            let chunkMeta = {};
            try {
              chunkMeta = typeof chunk.meta === "string" ? JSON.parse(chunk.meta || "{}") : chunk.meta || {};
            } catch {}
            return {
              feature_id: targetFeatureId,
              featureId: targetFeatureId,
              feature_name: feat.canonical_name,
              version: chunk.version || (idx === 0 ? "1.0.0" : "2.0.0"),
              lifecycle_status: chunk.lifecycle_status,
              lifecycleStatus: chunk.lifecycle_status,
              approval_status: "approved",
              approvalStatus: "approved",
              valid_from: chunk.valid_from,
              validFrom: chunk.valid_from,
              valid_to: chunk.valid_to,
              validTo: chunk.valid_to,
              source: chunkMeta.source || chunk.file || chunk.source || (idx === 0 ? "Previous Version" : "Current Version"),
              role,
              text: chunk.text,
              chunk_id: chunk.id,
            };
          });

          const beforeChunk = stageChunks[0];
          const afterChunk = stageChunks[lastIdx];
          const reason =
            afterChunk.superseded_reason ||
            afterChunk.meta?.superseded_reason ||
            beforeChunk.superseded_reason ||
            beforeChunk.meta?.superseded_reason ||
            feat.supersession?.superseded_reason ||
            (feat.versions?.find((v) => v.version === beforeChunk.version)?.superseded_reason) ||
            (feat.versions?.find((v) => v.version === afterChunk.version)?.superseded_reason) ||
            "Requirements upgraded";

          const stageBlocks = evidence.map((ev) => {
            const statusTag = String(ev.lifecycle_status || "ACTIVE").toUpperCase();
            return `${ev.role}:\nVersion ${ev.version} (Status: ${statusTag})\nSource: ${ev.source}\n${ev.text}`;
          });
          passages = `[QUERY INTENT: DIFF_EVOLUTION]\n\n${stageBlocks.join("\n\n")}\n\nCHANGE:\n${reason}`.trim();
        } else if (lineage.length === 1) {
          // Single version exists (no prior evolution)
          const singleChunk = lineage[0];
          evidence = [
            {
              feature_id: targetFeatureId,
              featureId: targetFeatureId,
              feature_name: feat.canonical_name,
              version: singleChunk.version || "1.0.0",
              lifecycle_status: singleChunk.lifecycle_status,
              lifecycleStatus: singleChunk.lifecycle_status,
              approval_status: "approved",
              approvalStatus: "approved",
              valid_from: singleChunk.valid_from,
              validFrom: singleChunk.valid_from,
              valid_to: singleChunk.valid_to,
              validTo: singleChunk.valid_to,
              source: singleChunk.source || singleChunk.file || "Initial Baseline",
              role: "INITIAL",
              text: singleChunk.text,
              chunk_id: singleChunk.id,
            },
          ];
          passages = `[QUERY INTENT: DIFF_EVOLUTION]\n[INITIAL BASELINE: Version ${singleChunk.version || "1.0.0"}]\n${singleChunk.text}`.trim();
        }
      }
    }

    const result = {
      status,
      plan,
      evidence,
      passages,
      conflicts,
      ambiguity,
    };

    // Cache result
    if (routerCache.size >= maxCacheSize) {
      const firstKey = routerCache.keys().next().value;
      routerCache.delete(firstKey);
    }
    routerCache.set(cacheKey, result);

    return result;
  }

  return {
    classifyTemporalIntent,
    extractTemporalParameters,
    rankEvidenceByQuery,
    routeTemporalQuery,
    clearCache,
  };
}

module.exports = {
  createTemporalRouter,
  classifyTemporalIntent,
  extractTemporalParameters,
  DIFF_PATTERNS,
  HISTORICAL_PATTERNS,
  CURRENT_OVERRIDE_PATTERNS,
};
