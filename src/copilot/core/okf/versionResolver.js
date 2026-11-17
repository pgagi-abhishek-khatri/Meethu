// src/copilot/core/okf/versionResolver.js
// Evidence Precedence Resolver (EPR) for Meethu Copilot.
// Normalizes candidate evidence, detects conflicts at feature and fact levels,
// enforces deterministic bi-temporal precedence rules, tracks machine-readable
// provenance, and formats context blocks for answer generation.
// Preserves legacy SemVer parsing, comparison, and document precedence resolution.

const SEMVER_REGEX = /^[0-9]+\.[0-9]+\.[0-9]+$/;

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

const CONFLICT_TYPES = {
  VERSION_CONFLICT: "VERSION_CONFLICT",
  FACT_CONFLICT: "FACT_CONFLICT",
  APPROVAL_CONFLICT: "APPROVAL_CONFLICT",
  SOURCE_CONFLICT: "SOURCE_CONFLICT",
  TEMPORAL_CONFLICT: "TEMPORAL_CONFLICT",
  LINEAGE_CONFLICT: "LINEAGE_CONFLICT",
};

const RESOLUTION_STATES = {
  RESOLVED: "RESOLVED",
  CONFLICT_UNRESOLVED: "CONFLICT_UNRESOLVED",
  INSUFFICIENT_EVIDENCE: "INSUFFICIENT_EVIDENCE",
  HISTORICAL_ONLY: "HISTORICAL_ONLY",
  SUPERSEDED: "SUPERSEDED",
  DEPRECATED: "DEPRECATED",
};

// ---------------------------------------------------------------------------
// SemVer Helpers (Preserved Legacy API)
// ---------------------------------------------------------------------------

function parseSemVer(v) {
  if (typeof v !== "string" || !SEMVER_REGEX.test(v.trim())) {
    return null;
  }
  const [major, minor, patch] = v.trim().split(".").map(Number);
  return { major, minor, patch, raw: v.trim() };
}

function compareSemVer(v1, v2) {
  const p1 = typeof v1 === "string" ? parseSemVer(v1) : v1;
  const p2 = typeof v2 === "string" ? parseSemVer(v2) : v2;

  if (!p1 || !p2) {
    throw new Error(`Invalid SemVer comparison: '${v1}' vs '${v2}'`);
  }

  if (p1.major !== p2.major) return p1.major - p2.major;
  if (p1.minor !== p2.minor) return p1.minor - p2.minor;
  return p1.patch - p2.patch;
}

// ---------------------------------------------------------------------------
// 1. Evidence Normalization Layer
// ---------------------------------------------------------------------------

/**
 * Normalizes candidate evidence from ALS, temporalStore, vector chunks, or OKF
 * into a consistent, immutable internal representation.
 *
 * @param {Object} candidate - Raw evidence item
 * @param {Object} [context] - Contextual metadata (projectId, etc.)
 * @returns {Object|null} Normalized evidence object
 */
function normalizeEvidence(candidate, context = {}) {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const evidence_id = String(
    candidate.evidence_id ??
    candidate.chunk_id ??
    candidate.id ??
    `ev_${Math.random().toString(36).substring(2, 9)}`
  );

  const project_id = candidate.project_id ?? context.projectId ?? null;
  const sourceObj = candidate.source && typeof candidate.source === "object" ? candidate.source : {};
  const metaObj = candidate.meta && typeof candidate.meta === "object" ? candidate.meta : {};

  const feature_id = candidate.feature_id ?? candidate.featureId ?? candidate.meta?.feature_id ?? null;
  const feature_name =
    candidate.feature_name ??
    candidate.featureName ??
    candidate.canonical_name ??
    metaObj.feature_name ??
    null;
  const content = String(candidate.content ?? candidate.text ?? candidate.body ?? "").trim();
  const rawVersion = candidate.version ?? candidate.meta?.version ?? null;
  const version = rawVersion ? String(rawVersion).trim() : null;

  // Extract source information
  const document_id = sourceObj.document_id ?? candidate.document_id ?? metaObj.document_id ?? candidate.file_id ?? null;
  const document_name =
    sourceObj.document_name ??
    candidate.document_name ??
    candidate.source_doc ??
    candidate.source_name ??
    candidate.file ??
    sourceObj.name ??
    metaObj.source ??
    (typeof candidate.source === "string" ? candidate.source : null);
  const section = sourceObj.section ?? candidate.section ?? metaObj.section ?? metaObj.heading ?? null;
  const page = sourceObj.page ?? candidate.page ?? metaObj.page ?? null;

  // Extract authority information
  let rawApproval =
    candidate.approval_status ??
    candidate.approvalStatus ??
    candidate.authority?.approval_status ??
    candidate.authority?.approvalStatus ??
    metaObj.approval_status ??
    metaObj.approvalStatus;

  if (!rawApproval && candidate.status && ["approved", "draft", "pending", "rejected"].includes(candidate.status)) {
    rawApproval = candidate.status;
  }
  const approval_status = rawApproval ? String(rawApproval).toLowerCase() : (candidate.authoritative ? "approved" : "unknown");

  let rawLifecycle =
    candidate.lifecycle_status ??
    candidate.lifecycleStatus ??
    candidate.authority?.lifecycle_status ??
    candidate.authority?.lifecycleStatus ??
    metaObj.lifecycle_status ??
    metaObj.lifecycleStatus;
  if (!rawLifecycle && candidate.status && ["active", "superseded", "deprecated"].includes(candidate.status)) {
    rawLifecycle = candidate.status;
  }
  const lifecycle_status = rawLifecycle ? String(rawLifecycle).toLowerCase() : "active";

  const source_type = (
    candidate.source_type ??
    candidate.authority?.source_type ??
    metaObj.source_type ??
    (document_name?.includes("OKF-") || document_name?.includes("canonical") ? "canonical_specification" :
     document_name?.includes("Client_Requirements") || document_name?.includes("prd") ? "authoritative_requirement" :
     document_name?.includes("ADR") || document_name?.includes("addendum") ? "project_update" :
     "supporting_document")
  );

  // Compute source authority score
  let source_score = candidate.authority?.source_score ?? candidate.authority_score ?? candidate.authority_tier;
  if (source_score == null) {
    if (approval_status === "rejected" || lifecycle_status === "deprecated") {
      source_score = SOURCE_PRECEDENCE_TIERS.DEPRECATED_OR_REJECTED.score;
    } else if (approval_status === "draft" || approval_status === "pending") {
      source_score = SOURCE_PRECEDENCE_TIERS.UNAPPROVED_OR_DRAFT.score;
    } else if (source_type === "canonical_specification" || source_type === "canonical_okf") {
      source_score = SOURCE_PRECEDENCE_TIERS.CANONICAL_OKF.score;
    } else if (source_type === "authoritative_requirement") {
      source_score = SOURCE_PRECEDENCE_TIERS.AUTHORITATIVE_REQUIREMENT.score;
    } else if (source_type === "project_update" || source_type === "project_requirement_update") {
      source_score = SOURCE_PRECEDENCE_TIERS.PROJECT_REQUIREMENT_UPDATE.score;
    } else {
      source_score = SOURCE_PRECEDENCE_TIERS.SUPPORTING_DOCUMENT.score;
    }
  }

  // Extract temporal timestamps
  const temporalObj = candidate.temporal && typeof candidate.temporal === "object" ? candidate.temporal : {};
  const transaction_time = temporalObj.transaction_time ?? candidate.transaction_time ?? candidate.added_at ?? null;
  const valid_from = temporalObj.valid_from ?? candidate.valid_from ?? candidate.validFrom ?? null;
  const valid_to = temporalObj.valid_to ?? candidate.valid_to ?? candidate.validTo ?? null;

  const parseTimestamp = (ts) => {
    if (ts == null) return null;
    if (typeof ts === "number") return isNaN(ts) ? null : ts;
    const p = Date.parse(ts);
    return isNaN(p) ? (isNaN(Number(ts)) ? null : Number(ts)) : p;
  };

  // Extract lineage information
  const lineageObj = candidate.lineage && typeof candidate.lineage === "object" ? candidate.lineage : {};
  let supersedes = lineageObj.supersedes ?? candidate.supersedes ?? metaObj.supersedes ?? [];
  if (typeof supersedes === "string") supersedes = [supersedes];
  if (!Array.isArray(supersedes)) supersedes = [];

  const superseded_by =
    lineageObj.superseded_by ??
    candidate.superseded_by ??
    candidate.superseded_by_id ??
    metaObj.superseded_by ??
    null;

  const superseded_reason =
    lineageObj.superseded_reason ??
    candidate.superseded_reason ??
    metaObj.superseded_reason ??
    null;

  const predecessor_id =
    lineageObj.predecessor_id ??
    candidate.predecessor_id ??
    metaObj.predecessor_id ??
    null;

  const supersedes_feature_id =
    lineageObj.supersedes_feature_id ??
    candidate.supersedes_feature_id ??
    metaObj.supersedes_feature_id ??
    null;

  return {
    evidence_id,
    project_id,
    feature_id,
    feature_name,
    content,
    version,
    source: {
      document_id,
      document_name,
      section,
      page,
    },
    authority: {
      approval_status,
      lifecycle_status,
      source_type,
      source_score,
    },
    temporal: {
      transaction_time: parseTimestamp(transaction_time),
      valid_from: parseTimestamp(valid_from),
      valid_to: parseTimestamp(valid_to),
    },
    lineage: {
      predecessor_id,
      supersedes,
      superseded_by,
      superseded_reason,
      supersedes_feature_id,
    },
    role: candidate.role || null,
    raw: candidate,
  };
}

// ---------------------------------------------------------------------------
// 2. Conflict Detection
// ---------------------------------------------------------------------------

/**
 * Detects conflicts at feature, version, temporal, and fact levels across candidates.
 *
 * @param {Array<Object>} candidates - Normalized candidate evidence records
 * @param {Object} [options] - Options including intent and asOf
 * @returns {Array<Object>} List of classified conflict objects
 */
function detectConflicts(candidates = [], { intent = "CURRENT_STATE", asOf = null } = {}) {
  const conflicts = [];
  if (!Array.isArray(candidates) || candidates.length < 2) {
    return conflicts;
  }

  // Group by feature_id
  const byFeature = new Map();
  for (const c of candidates) {
    const fid = c.feature_id || "__no_feature__";
    if (!byFeature.has(fid)) byFeature.set(fid, []);
    byFeature.get(fid).push(c);
  }

  for (const [featId, featCandidates] of byFeature.entries()) {
    if (featCandidates.length < 2) continue;

    // A. Check LINEAGE_CONFLICT
    for (const c of featCandidates) {
      // 1. Cross-feature supersession
      if (c.lineage.supersedes_feature_id && c.lineage.supersedes_feature_id !== c.feature_id) {
        conflicts.push({
          type: CONFLICT_TYPES.LINEAGE_CONFLICT,
          feature_id: featId,
          evidence_id: c.evidence_id,
          reason: `Supersession pointer references a different feature: '${c.lineage.supersedes_feature_id}' vs '${c.feature_id}'`,
        });
      }

      // 2. Self-supersession
      if (c.version && c.lineage.supersedes.includes(c.version)) {
        conflicts.push({
          type: CONFLICT_TYPES.LINEAGE_CONFLICT,
          feature_id: featId,
          evidence_id: c.evidence_id,
          reason: `Record cannot supersede its own version '${c.version}'`,
        });
      }
    }

    // Circular supersession check
    for (let i = 0; i < featCandidates.length; i++) {
      for (let j = i + 1; j < featCandidates.length; j++) {
        const c1 = featCandidates[i];
        const c2 = featCandidates[j];
        if (c1.version && c2.version) {
          const c1SupersedesC2 = c1.lineage.supersedes.includes(c2.version) || c2.lineage.superseded_by === c1.version;
          const c2SupersedesC1 = c2.lineage.supersedes.includes(c1.version) || c1.lineage.superseded_by === c2.version;
          if (c1SupersedesC2 && c2SupersedesC1) {
            conflicts.push({
              type: CONFLICT_TYPES.LINEAGE_CONFLICT,
              feature_id: featId,
              evidence_ids: [c1.evidence_id, c2.evidence_id],
              reason: `Circular supersession detected between version '${c1.version}' and '${c2.version}'`,
            });
          }
        }
      }
    }

    // B. Check APPROVAL_CONFLICT
    const approved = featCandidates.filter((c) => c.authority.approval_status === "approved");
    const drafts = featCandidates.filter((c) => c.authority.approval_status === "draft" || c.authority.approval_status === "pending");
    if (approved.length > 0 && drafts.length > 0) {
      for (const d of drafts) {
        // If draft conflicts with an approved version on the same feature
        const matchingApproved = approved.find((a) => a.version === d.version && a.content !== d.content);
        if (matchingApproved) {
          conflicts.push({
            type: CONFLICT_TYPES.APPROVAL_CONFLICT,
            feature_id: featId,
            evidence_ids: [matchingApproved.evidence_id, d.evidence_id],
            reason: `Draft record contradicts approved specification for version '${d.version}'`,
          });
        }
      }
    }

    // C. Check TEMPORAL_CONFLICT and SOURCE_CONFLICT among approved records
    const approvedActive = featCandidates.filter(
      (c) => c.authority.approval_status === "approved" && c.authority.lifecycle_status === "active"
    );

    for (let i = 0; i < approvedActive.length; i++) {
      for (let j = i + 1; j < approvedActive.length; j++) {
        const c1 = approvedActive[i];
        const c2 = approvedActive[j];

        // Sibling sections within the same document and version are not conflicting
        const isSameSourceDoc =
          c1.source?.document_name &&
          c2.source?.document_name &&
          c1.source.document_name === c2.source.document_name &&
          c1.version === c2.version;

        if (isSameSourceDoc) {
          continue;
        }

        // If they have distinct content/values
        if (c1.content && c2.content && c1.content.trim() !== c2.content.trim()) {
          // Check if explicit supersession connects them
          const hasSupersession =
            (c1.version && c2.lineage.supersedes.includes(c1.version)) ||
            (c2.version && c1.lineage.supersedes.includes(c2.version)) ||
            (c1.lineage.superseded_by && c1.lineage.superseded_by === c2.version) ||
            (c2.lineage.superseded_by && c2.lineage.superseded_by === c1.version);

          if (!hasSupersession) {
            // Check temporal interval overlap: [vFrom1, vTo1] and [vFrom2, vTo2]
            const from1 = c1.temporal.valid_from ?? -Infinity;
            const to1 = c1.temporal.valid_to ?? Infinity;
            const from2 = c2.temporal.valid_from ?? -Infinity;
            const to2 = c2.temporal.valid_to ?? Infinity;

            const intervalsOverlap = from1 < to2 && from2 < to1;

            if (intervalsOverlap) {
              if (c1.authority.source_score === c2.authority.source_score) {
                conflicts.push({
                  type: CONFLICT_TYPES.SOURCE_CONFLICT,
                  feature_id: featId,
                  field: "content",
                  evidence_ids: [c1.evidence_id, c2.evidence_id],
                  candidates: [
                    { value: c1.content, version: c1.version, source: c1.source.document_name },
                    { value: c2.content, version: c2.version, source: c2.source.document_name },
                  ],
                  reason: `Conflicting approved sources at equal tier '${c1.authority.source_type}' without explicit supersession`,
                });
              } else {
                conflicts.push({
                  type: CONFLICT_TYPES.TEMPORAL_CONFLICT,
                  feature_id: featId,
                  evidence_ids: [c1.evidence_id, c2.evidence_id],
                  reason: `Overlapping temporal validity with contradictory requirements between '${c1.source.document_name}' and '${c2.source.document_name}'`,
                });
              }
            }
          }
        }
      }
    }
  }

  return conflicts;
}

// ---------------------------------------------------------------------------
// 3. Provenance Metadata Builder
// ---------------------------------------------------------------------------

/**
 * Builds a structured, machine-readable provenance record for an evidence item.
 */
function buildProvenance(evidence, resolution = {}) {
  if (!evidence) return null;
  return {
    evidence_id: evidence.evidence_id,
    feature_id: evidence.feature_id,
    version: evidence.version,
    authority_status: evidence.authority?.approval_status || "unknown",
    lifecycle_status: evidence.authority?.lifecycle_status || "unknown",
    source_document: evidence.source?.document_name || null,
    source_section: evidence.source?.section || null,
    page: evidence.source?.page ?? null,
    valid_from: evidence.temporal?.valid_from ?? null,
    valid_to: evidence.temporal?.valid_to ?? null,
    transaction_time: evidence.temporal?.transaction_time ?? null,
    resolution: {
      outcome: resolution.outcome || "SELECTED",
      rule: resolution.rule || "DETERMINISTIC_PRECEDENCE",
      supersedes_version: resolution.supersedes_version || (evidence.lineage?.supersedes?.[0] ?? null),
      reason: resolution.reason || evidence.lineage?.superseded_reason || null,
    },
  };
}

// ---------------------------------------------------------------------------
// 4. Legacy Precedence Resolver (Preserves backward compatibility for okfLookup)
// ---------------------------------------------------------------------------

function resolveLegacyPrecedence(
  candidates = [],
  { requestedVersion = null, allowDraft = false, allowDeprecated = false } = {}
) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return {
      status: "not_found",
      resolvedRecord: null,
      reason: "No candidate records provided",
    };
  }

  // 1. Explicit Version Requested (Pinning)
  if (requestedVersion) {
    const sem = parseSemVer(requestedVersion);
    if (!sem) {
      return {
        status: "invalid_query",
        resolvedRecord: null,
        reason: `Requested version '${requestedVersion}' is not valid SemVer`,
      };
    }

    const matches = candidates.filter((c) => c.version === requestedVersion);
    if (matches.length === 0) {
      return {
        status: "version_not_found",
        resolvedRecord: null,
        reason: `Requested version '${requestedVersion}' does not exist among candidates`,
      };
    }

    if (matches.length > 1) {
      const approvedCount = matches.filter((m) => m.status === "approved").length;
      if (approvedCount > 1) {
        return {
          status: "ambiguous",
          resolvedRecord: null,
          reason: `Multiple duplicate '${requestedVersion}' records with approved status`,
        };
      }
    }

    const winningMatch = matches.find((m) => m.status === "approved") || matches[0];
    return {
      status: "resolved",
      resolvedRecord: winningMatch,
      reason: `Explicit version pin '${requestedVersion}' resolved`,
    };
  }

  // 2. Default Resolution (No Version Specified)
  const allSuperseded = candidates.every((c) => c.status === "superseded");
  if (allSuperseded) {
    const newestSuperseded = [...candidates].sort((a, b) => compareSemVer(b.version, a.version))[0];
    return {
      status: "superseded",
      resolvedRecord: newestSuperseded,
      supersededTo: newestSuperseded.superseded_by || null,
      reason: `Document is superseded; redirects to ${newestSuperseded.superseded_by || "successor"}`,
    };
  }

  const approved = candidates.filter((c) => c.status === "approved");
  if (approved.length > 0) {
    const sorted = [...approved].sort((a, b) => compareSemVer(b.version, a.version));
    if (sorted.length > 1 && compareSemVer(sorted[0].version, sorted[1].version) === 0) {
      return {
        status: "ambiguous",
        resolvedRecord: null,
        reason: `Duplicate approved records share the highest version '${sorted[0].version}'`,
      };
    }

    return {
      status: "resolved",
      resolvedRecord: sorted[0],
      reason: `Highest approved version '${sorted[0].version}' resolved`,
    };
  }

  if (allowDraft) {
    const drafts = candidates.filter((c) => c.status === "draft");
    if (drafts.length > 0) {
      const sorted = [...drafts].sort((a, b) => compareSemVer(b.version, a.version));
      return {
        status: "resolved",
        resolvedRecord: sorted[0],
        reason: `Highest draft version '${sorted[0].version}' resolved (allowDraft=true)`,
      };
    }
  }

  if (allowDeprecated) {
    const deprecated = candidates.filter((c) => c.status === "deprecated");
    if (deprecated.length > 0) {
      const sorted = [...deprecated].sort((a, b) => compareSemVer(b.version, a.version));
      return {
        status: "resolved",
        resolvedRecord: sorted[0],
        reason: `Highest deprecated version '${sorted[0].version}' resolved (allowDeprecated=true)`,
      };
    }
  }

  return {
    status: "no_authoritative_version",
    resolvedRecord: null,
    reason: "Candidates exist but none have 'approved' status and draft/deprecated are disallowed",
  };
}

// ---------------------------------------------------------------------------
// 5. Deterministic Evidence Precedence Resolver (Phase 6 Core)
// ---------------------------------------------------------------------------

/**
 * Resolves candidate evidence items according to the 7-tier precedence hierarchy.
 * Automatically delegates to resolveLegacyPrecedence if legacy document records are passed.
 *
 * @param {Array<Object>} candidates - Candidate evidence or document records
 * @param {Object} [options] - Resolution options (intent, asOf, requestedVersion, etc.)
 * @returns {Object} Resolution result with selected evidence, provenance, and conflict state
 */
function resolvePrecedence(candidates = [], options = {}) {
  // Legacy document resolution detection (backward compatibility)
  const isLegacy =
    Array.isArray(candidates) &&
    candidates.length > 0 &&
    !candidates[0].authority &&
    !candidates[0].feature_id &&
    !options.intent &&
    options.asOf == null &&
    !options.featureRegistry;

  if (isLegacy) {
    return resolveLegacyPrecedence(candidates, options);
  }

  return resolveEvidence(candidates, options);
}

/**
 * Top-level Evidence Precedence Resolver execution pipeline.
 */
function resolveEvidence(candidates = [], options = {}) {
  const {
    intent = "CURRENT_STATE",
    asOf = null,
    requestedVersion = options.version ?? null,
    allowDraft = false,
    allowDeprecated = false,
    now = Date.now(),
    featureRegistry = null,
  } = options;

  if (!Array.isArray(candidates) || candidates.length === 0) {
    return {
      status: RESOLUTION_STATES.INSUFFICIENT_EVIDENCE,
      intent,
      selected: [],
      historical: [],
      evolution: [],
      supporting: [],
      conflicts: [],
      warnings: ["No candidate evidence records provided"],
      provenanceMap: {},
    };
  }

  // 1. Normalize candidates
  const normalized = candidates.map((c) => normalizeEvidence(c)).filter(Boolean);

  // 2. Deterministic Deduplication
  const deduplicated = [];
  const seenDedupKeys = new Set();
  for (const item of normalized) {
    const key = `${item.feature_id || ""}:${item.version || ""}:${item.authority.approval_status}:${item.authority.lifecycle_status}:${item.content}:${item.source.document_name || ""}`;
    if (!seenDedupKeys.has(key)) {
      seenDedupKeys.add(key);
      deduplicated.push(item);
    }
  }

  // 3. Detect conflicts
  const detectedConflicts = detectConflicts(deduplicated, { intent, asOf });

  // If severe LINEAGE_CONFLICT detected, fail closed
  const lineageConflict = detectedConflicts.find((c) => c.type === CONFLICT_TYPES.LINEAGE_CONFLICT);
  if (lineageConflict) {
    return {
      status: RESOLUTION_STATES.CONFLICT_UNRESOLVED,
      intent,
      feature_id: deduplicated[0]?.feature_id || null,
      selected: [],
      historical: [],
      evolution: [],
      supporting: [],
      conflicts: detectedConflicts,
      resolution_reason: lineageConflict.reason,
      warnings: ["Lineage validation failed; evidence blocked from authoritative claims"],
      provenanceMap: {},
    };
  }

  const provenanceMap = {};

  // -------------------------------------------------------------------------
  // Branch A: DIFF_EVOLUTION
  // -------------------------------------------------------------------------
  if (intent === "DIFF_EVOLUTION") {
    // Sort chronologically ascending
    const sorted = [...deduplicated].sort(
      (a, b) => (a.temporal.valid_from ?? 0) - (b.temporal.valid_from ?? 0) ||
                (a.version && b.version ? compareSemVer(a.version, b.version) : 0)
    );

    let evolutionItems = [];
    if (sorted.length >= 2) {
      const before = { ...sorted[0], role: "BEFORE" };
      const after = { ...sorted[sorted.length - 1], role: "AFTER" };

      const supersedesReason =
        after.lineage.superseded_reason ||
        before.lineage.superseded_reason ||
        "Requirements evolved across versions";

      before.provenance = buildProvenance(before, {
        outcome: "EVOLUTION_PREDECESSOR",
        rule: "HISTORICAL_PREDECESSOR",
        reason: supersedesReason,
      });
      after.provenance = buildProvenance(after, {
        outcome: "EVOLUTION_SUCCESSOR",
        rule: "EXPLICIT_SUPERSESSION",
        supersedes_version: before.version,
        reason: supersedesReason,
      });

      provenanceMap[before.evidence_id] = before.provenance;
      provenanceMap[after.evidence_id] = after.provenance;
      evolutionItems = [before, after];
    } else if (sorted.length === 1) {
      const single = { ...sorted[0], role: "INITIAL" };
      single.provenance = buildProvenance(single, {
        outcome: "INITIAL_BASELINE",
        rule: "SINGLE_VERSION_BASELINE",
      });
      provenanceMap[single.evidence_id] = single.provenance;
      evolutionItems = [single];
    }

    return {
      status: RESOLUTION_STATES.RESOLVED,
      intent,
      feature_id: deduplicated[0]?.feature_id || null,
      selected: evolutionItems,
      historical: [],
      evolution: evolutionItems,
      supporting: [],
      conflicts: detectedConflicts,
      warnings: [],
      provenanceMap,
    };
  }

  // -------------------------------------------------------------------------
  // Branch B: HISTORICAL_STATE
  // -------------------------------------------------------------------------
  if (intent === "HISTORICAL_STATE") {
    let eligible = [...deduplicated];

    // Filter by asOf timestamp
    if (asOf != null) {
      const targetTime = Number(asOf);
      eligible = eligible.filter((c) => {
        const from = c.temporal.valid_from ?? -Infinity;
        const to = c.temporal.valid_to ?? Infinity;
        return from <= targetTime && targetTime < to;
      });
    }

    // Filter by requestedVersion
    if (requestedVersion) {
      eligible = eligible.filter((c) => c.version === requestedVersion);
    }

    if (eligible.length === 0) {
      return {
        status: RESOLUTION_STATES.HISTORICAL_ONLY,
        intent,
        feature_id: deduplicated[0]?.feature_id || null,
        selected: [],
        historical: [],
        evolution: [],
        supporting: [],
        conflicts: detectedConflicts,
        resolution_reason: `No evidence valid at requested historical scope (asOf: ${asOf}, version: ${requestedVersion})`,
        warnings: ["Historical query produced 0 matching records within validity scope"],
        provenanceMap: {},
      };
    }

    // Sort by approval eligibility, then source authority score, then SemVer
    eligible.sort((a, b) => {
      const appA = a.authority.approval_status === "approved" ? 1 : 0;
      const appB = b.authority.approval_status === "approved" ? 1 : 0;
      if (appA !== appB) return appB - appA;

      if (b.authority.source_score !== a.authority.source_score) {
        return b.authority.source_score - a.authority.source_score;
      }

      if (a.version && b.version) {
        try { return compareSemVer(b.version, a.version); } catch {}
      }
      return 0;
    });

    // Check for source conflict at top tier
    const topScore = eligible[0].authority.source_score;
    const topTier = eligible.filter((c) => c.authority.source_score === topScore);
    if (topTier.length > 1) {
      const distinctDocs = new Set(topTier.map((c) => c.source.document_name).filter(Boolean));
      const distinctVersions = new Set(topTier.map((c) => c.version).filter(Boolean));

      if (distinctDocs.size > 1 || distinctVersions.size > 1) {
        return {
          status: RESOLUTION_STATES.CONFLICT_UNRESOLVED,
          intent,
          feature_id: deduplicated[0]?.feature_id || null,
          selected: [],
          historical: eligible,
          evolution: [],
          supporting: [],
          conflicts: [
            {
              type: CONFLICT_TYPES.SOURCE_CONFLICT,
              field: "content",
              candidates: topTier.map((c) => ({
                value: c.content,
                version: c.version,
                source: c.source.document_name,
              })),
            },
            ...detectedConflicts,
          ],
          resolution_reason: "Multiple approved historical records at equal authority tier disagree without supersession",
          warnings: ["Unresolved conflict among historical records"],
          provenanceMap: {},
        };
      }
    }

    const winner = { ...eligible[0], role: "HISTORICAL" };
    const winningDocs = eligible.filter(
      (c) => c.source.document_name === winner.source.document_name && c.version === winner.version
    );

    const selected = winningDocs.map((item) => {
      const chunk = { ...item, role: "HISTORICAL" };
      chunk.provenance = buildProvenance(chunk, {
        outcome: "SELECTED",
        rule: requestedVersion ? "EXPLICIT_VERSION_PIN" : "HISTORICAL_POINT_IN_TIME",
        reason: `Historical evidence valid as of ${asOf || requestedVersion}`,
      });
      provenanceMap[chunk.evidence_id] = chunk.provenance;
      return chunk;
    });

    return {
      status: RESOLUTION_STATES.RESOLVED,
      intent,
      feature_id: deduplicated[0]?.feature_id || null,
      selected,
      historical: selected,
      evolution: [],
      supporting: [],
      conflicts: detectedConflicts,
      warnings: [],
      provenanceMap,
    };
  }

  // -------------------------------------------------------------------------
  // Branch C: CURRENT_STATE (Default)
  // -------------------------------------------------------------------------
  // Check if non-temporal supporting RAG evidence only
  const allNonTemporal = deduplicated.every((c) => !c.feature_id && !c.version);
  if (allNonTemporal) {
    const supporting = deduplicated.map((c) => {
      const supp = { ...c, role: "SUPPORTING" };
      supp.provenance = buildProvenance(supp, {
        outcome: "SUPPORTING",
        rule: "NON_AUTHORITATIVE_RAG",
      });
      provenanceMap[supp.evidence_id] = supp.provenance;
      return supp;
    });

    return {
      status: RESOLUTION_STATES.RESOLVED,
      intent,
      feature_id: null,
      selected: supporting,
      historical: [],
      evolution: [],
      supporting,
      conflicts: [],
      warnings: ["Evidence contains non-temporal RAG chunks without canonical authority"],
      provenanceMap,
    };
  }

  // 1. Exclude expired records (valid_to in the past)
  const currentTime = Number(now);
  const unexpired = deduplicated.filter((c) => {
    if (c.temporal.valid_to != null && c.temporal.valid_to <= currentTime) {
      return false; // Expired
    }
    return true;
  });

  // 2. Exclude superseded and deprecated
  const nonSuperseded = unexpired.filter((c) => {
    if (c.authority.lifecycle_status === "superseded" || c.lineage.superseded_by != null) {
      return false;
    }
    if (c.authority.lifecycle_status === "deprecated" && !allowDeprecated) {
      return false;
    }
    return true;
  });

  if (nonSuperseded.length === 0) {
    const wasAllSuperseded = deduplicated.every((c) => c.authority.lifecycle_status === "superseded");
    const wasAllDeprecated = deduplicated.every((c) => c.authority.lifecycle_status === "deprecated");
    return {
      status: wasAllDeprecated
        ? RESOLUTION_STATES.DEPRECATED
        : wasAllSuperseded
          ? RESOLUTION_STATES.SUPERSEDED
          : RESOLUTION_STATES.HISTORICAL_ONLY,
      intent,
      feature_id: deduplicated[0]?.feature_id || null,
      selected: [],
      historical: deduplicated,
      evolution: [],
      supporting: [],
      conflicts: detectedConflicts,
      resolution_reason: "All available records are superseded, deprecated, or expired for current-state queries",
      warnings: ["No active approved records available for CURRENT_STATE"],
      provenanceMap: {},
    };
  }

  // 3. Approval status filter (approved > draft)
  let eligible = nonSuperseded;
  const approvedOnly = eligible.filter((c) => c.authority.approval_status === "approved");
  if (approvedOnly.length > 0) {
    eligible = approvedOnly;
  } else if (!allowDraft) {
    return {
      status: RESOLUTION_STATES.INSUFFICIENT_EVIDENCE,
      intent,
      feature_id: deduplicated[0]?.feature_id || null,
      selected: [],
      historical: [],
      evolution: [],
      supporting: [],
      conflicts: detectedConflicts,
      resolution_reason: "Candidate records exist but none are approved and drafts are disallowed",
      warnings: ["Drafts excluded from authoritative current requirements"],
      provenanceMap: {},
    };
  }

  // 4. Sort by source authority score descending, then SemVer descending
  eligible.sort((a, b) => {
    if (b.authority.source_score !== a.authority.source_score) {
      return b.authority.source_score - a.authority.source_score;
    }
    if (a.version && b.version) {
      try { return compareSemVer(b.version, a.version); } catch {}
    }
    // Transaction time tie-breaker only if exact same version/content
    return (b.temporal.transaction_time ?? 0) - (a.temporal.transaction_time ?? 0);
  });

  // 5. Check for unresolved conflict at highest authority tier
  const highestScore = eligible[0].authority.source_score;
  const topTier = eligible.filter((c) => c.authority.source_score === highestScore);

  if (topTier.length > 1) {
    const distinctDocs = new Set(topTier.map((c) => c.source.document_name).filter(Boolean));
    const distinctVersions = new Set(topTier.map((c) => c.version).filter(Boolean));

    // A conflict only exists if multiple distinct documents or differing versions exist at the top tier
    if (distinctDocs.size > 1 || distinctVersions.size > 1) {
      const c1 = topTier[0];
      const otherDoc = topTier.find(
        (c) => c.source.document_name !== c1.source.document_name || c.version !== c1.version
      );

      if (otherDoc) {
        const hasSupersession =
          (c1.version && otherDoc.lineage.supersedes.includes(c1.version)) ||
          (otherDoc.version && c1.lineage.supersedes.includes(otherDoc.version));

        if (!hasSupersession) {
          return {
            status: RESOLUTION_STATES.CONFLICT_UNRESOLVED,
            intent,
            feature_id: deduplicated[0]?.feature_id || null,
            selected: [],
            historical: [],
            evolution: [],
            supporting: [],
            conflicts: [
              {
                type: CONFLICT_TYPES.SOURCE_CONFLICT,
                field: "content",
                candidates: [c1, otherDoc].map((c) => ({
                  value: c.content,
                  version: c.version,
                  source: c.source.document_name,
                })),
              },
              ...detectedConflicts,
            ],
            resolution_reason: "Both records are approved and no authoritative supersession relationship establishes precedence.",
            warnings: ["Conflicting approved sources at equal authority tier"],
            provenanceMap: {},
          };
        }
      }
    }
  }

  // Winner determined cleanly
  const winner = { ...eligible[0], role: "CURRENT" };
  const supersededVer = winner.lineage.supersedes?.[0] || null;

  let rule = "HIGHEST_APPROVED_SEMVER";
  if (supersededVer) {
    rule = "EXPLICIT_SUPERSESSION";
  } else if (winner.authority.source_score > 40) {
    rule = "CANONICAL_SOURCE_PRECEDENCE";
  }

  // Select all sibling chunks belonging to the winning document version
  const winningDocs = eligible.filter(
    (c) => c.source.document_name === winner.source.document_name && c.version === winner.version
  );

  const selected = winningDocs.map((item) => {
    const chunk = { ...item, role: "CURRENT" };
    chunk.provenance = buildProvenance(chunk, {
      outcome: "SELECTED",
      rule,
      supersedes_version: supersededVer,
      reason: winner.lineage.superseded_reason || (supersededVer ? `Supersedes version ${supersededVer}` : "Highest authoritative record"),
    });
    provenanceMap[chunk.evidence_id] = chunk.provenance;
    return chunk;
  });

  return {
    status: RESOLUTION_STATES.RESOLVED,
    intent,
    feature_id: winner.feature_id,
    selected,
    historical: [],
    evolution: [],
    supporting: [],
    conflicts: detectedConflicts,
    warnings: [],
    provenanceMap,
  };
}

// ---------------------------------------------------------------------------
// 6. Context Block Formatter for contextPack.js
// ---------------------------------------------------------------------------

/**
 * Formats evidence resolution output into standardized markdown context blocks.
 */
function formatEvidenceForContext(resolution, budget = 2800) {
  if (!resolution) return "";

  // 1. Conflict Unresolved
  if (resolution.status === RESOLUTION_STATES.CONFLICT_UNRESOLVED) {
    const conflict = resolution.conflicts?.[0] || {};
    const candList = Array.isArray(conflict.candidates)
      ? conflict.candidates.map((c) => `- ${c.source || "Source"} (v${c.version || "?"}): ${c.value || ""}`).join("\n")
      : "- Conflicting records present at equal authority tier";

    return `[UNRESOLVED EVIDENCE CONFLICT]\n\nFeature: ${resolution.feature_id || "System Requirement"}\n\nConflicting approved sources:\n${candList}\n\nResolution: UNRESOLVED\nReason: ${resolution.resolution_reason || "Precedence cannot be safely established."}\n\nInstruction:\nDo not present either value as an established current fact.\nRequest clarification or explain the conflict.`.trim();
  }

  // 2. Evolution
  if (resolution.intent === "DIFF_EVOLUTION" && resolution.evolution?.length) {
    const before = resolution.evolution.find((e) => e.role === "BEFORE") || resolution.evolution[0];
    const after = resolution.evolution.find((e) => e.role === "AFTER") || resolution.evolution[1];

    if (before && after) {
      const reason =
        after.lineage?.superseded_reason ||
        after.provenance?.resolution?.reason ||
        "Requirements evolved across versions";

      return `[EVOLUTION EVIDENCE]\n\nBEFORE:\nVersion ${before.version || "1.0.0"} (Status: ${(before.authority?.lifecycle_status || "SUPERSEDED").toUpperCase()})\n${before.content}\n\nAFTER:\nVersion ${after.version || "2.0.0"} (Status: ${(after.authority?.lifecycle_status || "ACTIVE").toUpperCase()})\n${after.content}\n\nCHANGE:\n${reason}`.trim();
    } else if (before) {
      return `[EVOLUTION EVIDENCE]\n\n[INITIAL BASELINE: Version ${before.version || "1.0.0"}]\n${before.content}`.trim();
    }
  }

  // 3. Historical State
  if (resolution.intent === "HISTORICAL_STATE" && resolution.selected?.length) {
    const item = resolution.selected[0];
    return `[HISTORICAL EVIDENCE]\nFeature: ${item.feature_id || "Canonical Requirement"}\nVersion: ${item.version || "historical"}\nStatus: HISTORICAL\nSource: ${item.source?.document_name || "Historical Record"}\n\nFacts:\n${item.content}`.trim();
  }

  // 4. Authoritative Current Evidence
  if (resolution.status === RESOLUTION_STATES.RESOLVED && resolution.selected?.length) {
    const blocks = [];
    for (const item of resolution.selected) {
      if (item.role === "SUPPORTING") {
        blocks.push(`[SUPPORTING EVIDENCE]\nFile: ${item.source?.document_name || "Project File"}${item.source?.section ? ` · ${item.source.section}` : ""}\n\n${item.content}`);
      } else {
        const prov = item.provenance?.resolution || {};
        const lines = [
          `[AUTHORITATIVE EVIDENCE]`,
          `Feature: ${item.feature_id || "Canonical Requirement"}`,
          `Version: ${item.version || "1.0.0"}`,
          `Approval: ${(item.authority?.approval_status || "APPROVED").toUpperCase()}`,
          `Lifecycle: ${(item.authority?.lifecycle_status || "ACTIVE").toUpperCase()}`,
          ``,
          `Source: ${item.source?.document_name || "Canonical Specification"}`,
        ];
        if (item.source?.section) lines.push(`Section: ${item.source.section}`);
        if (item.source?.page != null) lines.push(`Page: ${item.source.page}`);

        lines.push(``);
        lines.push(`Resolution: SELECTED`);
        lines.push(`Rule: ${prov.rule || "DETERMINISTIC_PRECEDENCE"}`);
        if (prov.supersedes_version) lines.push(`Supersedes: Version ${prov.supersedes_version}`);
        if (prov.reason) lines.push(`Reason: ${prov.reason}`);

        lines.push(``);
        lines.push(`Facts:`);
        lines.push(item.content);
        blocks.push(lines.join("\n"));
      }
    }
    return blocks.join("\n\n").trim();
  }

  return "";
}

// ---------------------------------------------------------------------------
// Module Exports
// ---------------------------------------------------------------------------

module.exports = {
  parseSemVer,
  compareSemVer,
  normalizeEvidence,
  detectConflicts,
  resolvePrecedence,
  buildProvenance,
  resolveEvidence,
  formatEvidenceForContext,
  CONFLICT_TYPES,
  RESOLUTION_STATES,
  SOURCE_PRECEDENCE_TIERS,
};
