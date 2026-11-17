// src/copilot/core/answer/contextPack.js
// Production-Grade Temporal Context Assembly & Evaluation for Meethu Copilot.
// Assembles provenance-aware, temporal, conflict-resistant context packs with
// programmatic evidence banners, strict temporal intent handling, contradiction
// evaluation, atomic token-budget management, and backward compatibility.

const { buildSystemPrompt, PROACTIVE_CHECK } = require("../../prompts/main");
const { ANSWER_BUDGET } = require("../../config/budgets");
const { speakerLabel, clip, oneLine } = require("../decision/buildState");
const { toUtterances } = require("../transcript/utterances");
const {
  resolveEvidence,
  RESOLUTION_STATES,
  CONFLICT_TYPES,
  SOURCE_PRECEDENCE_TIERS,
} = require("../okf/versionResolver");

// ---------------------------------------------------------------------------
// Constants & Issue Types
// ---------------------------------------------------------------------------

const CONTEXT_ISSUE_TYPES = {
  CONTRADICTORY_VALUE: "CONTRADICTORY_VALUE",
  VERSION_CONFLICT: "VERSION_CONFLICT",
  STALE_EVIDENCE: "STALE_EVIDENCE",
  MISSING_PROVENANCE: "MISSING_PROVENANCE",
  MISSING_TEMPORAL_BOUNDARIES: "MISSING_TEMPORAL_BOUNDARIES",
  INCOMPLETE_EVOLUTION_PAIR: "INCOMPLETE_EVOLUTION_PAIR",
  UNRESOLVED_CONFLICT: "UNRESOLVED_CONFLICT",
  DUPLICATE_EVIDENCE: "DUPLICATE_EVIDENCE",
  REQUIREMENT_VS_IMPLEMENTATION: "REQUIREMENT_VS_IMPLEMENTATION",
};

const EVALUATION_STATUS = {
  PASS: "PASS",
  WARNING: "WARNING",
  FAIL: "FAIL",
};

const SEVERITY = {
  CRITICAL: "CRITICAL",
  WARNING: "WARNING",
  INFO: "INFO",
};

const REQUIREMENT_VS_IMPLEMENTATION_NOTICE = `[REQUIREMENT VS IMPLEMENTATION NOTICE]
Requirements specify target design specifications, while implementation records report current operational deployment. Distinguish planned requirements from actual deployed state. Do not state that planned requirements are fully deployed unless verified by implementation records.`;

const ASSISTANT_DIRECTIVES = `[ASSISTANT DIRECTIVES]
- Treat authoritative evidence according to the resolver's decision.
- Do not treat superseded evidence as current facts.
- Respect requested historical dates.
- Keep predecessor and successor versions distinct; never merge them into a synthetic specification.
- Explicitly disclose unresolved conflicts; do not guess a winner.
- Distinguish requirements from actual implementation status.
- Cite evidence using the available source references.`;

const MAX_LINES = 15; // the last 15 messages; the summary covers older ones
const newest = (lines, budget) => {
  const kept = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (used + lines[i].length > budget && kept.length) break;
    kept.unshift(lines[i]);
    used += lines[i].length;
  }
  return kept;
};

// contextSeconds 0 = no limit (the summary covers the past).
function transcriptLines(transcript, { now, contextSeconds }, budget) {
  const from = contextSeconds > 0 ? now - contextSeconds * 1000 : -Infinity;
  const lines = toUtterances(
    transcript.filter((s) => s.final !== false && (s.at ?? now) >= from),
    speakerLabel
  ).map((s) => `${s.label}: ${clip(oneLine(s.text), 600)}`);
  return newest(lines.slice(-MAX_LINES), budget);
}

// ---------------------------------------------------------------------------
// 1. Programmatic Evidence Banner Formatter
// ---------------------------------------------------------------------------

/**
 * Builds a standardized, programmatic, token-efficient evidence banner.
 * Never hardcodes values and represents missing data cleanly without fabricating.
 *
 * @param {Object} item - Normalized evidence record
 * @param {Object} [options]
 * @returns {string} Formatted banner
 */
function buildEvidenceBanner(item, options = {}) {
  if (!item) return "";

  // Classification deduction
  let classification = "CANONICAL SPECIFICATION";
  const sourceName = item.source?.document_name || item.source_doc || item.source_name || item.file || "";
  const role = item.role || options.role;

  if (
    item.authority_tier === 100 ||
    item.authority?.source_score === 100 ||
    item.source_type === "canonical_specification" ||
    item.source_type === "canonical_okf" ||
    /okf|canonical/i.test(sourceName)
  ) {
    classification = "CANONICAL SPECIFICATION";
  } else if (
    role === "IMPLEMENTATION" ||
    item.evidence_type === "IMPLEMENTATION" ||
    item.authority_tier === 60 ||
    item.authority?.source_score === 60 ||
    /implement|deploy|status_report|as-built|production/i.test(sourceName)
  ) {
    classification = "AS-BUILT IMPLEMENTATION RECORD";
  } else if (
    item.evidence_type === "REQUIREMENT" ||
    item.authority_tier === 80 ||
    item.authority?.source_score === 80 ||
    /requirement|client_req/i.test(sourceName)
  ) {
    classification = "AUTHORITATIVE REQUIREMENT";
  } else if (
    role === "SUPPORTING" ||
    item.authority_tier === 40 ||
    item.authority?.source_score === 40
  ) {
    classification = "SUPPORTING DOCUMENT";
  } else if (role === "HISTORICAL") {
    classification = "HISTORICAL SPECIFICATION";
  }

  const featName =
    item.feature_name || item.canonical_name || item.feature_id || "Canonical Requirement";
  const featId = item.feature_id || "UNKNOWN";
  const version = item.version || "UNKNOWN";
  const approval = (
    item.authority?.approval_status ||
    item.approval_status ||
    item.status ||
    "UNKNOWN"
  ).toUpperCase();
  const lifecycle = (
    item.authority?.lifecycle_status ||
    item.lifecycle_status ||
    item.lifecycle ||
    "UNKNOWN"
  ).toUpperCase();

  const validFrom = item.temporal?.valid_from
    ? typeof item.temporal.valid_from === "number"
      ? new Date(item.temporal.valid_from).toISOString().split("T")[0]
      : String(item.temporal.valid_from).split("T")[0]
    : item.valid_from
      ? String(item.valid_from).split("T")[0]
      : "UNKNOWN";

  const validTo = item.temporal?.valid_to
    ? typeof item.temporal.valid_to === "number"
      ? new Date(item.temporal.valid_to).toISOString().split("T")[0]
      : String(item.temporal.valid_to).split("T")[0]
    : item.valid_to
      ? String(item.valid_to).split("T")[0]
      : "PRESENT";

  const sourceDoc = sourceName || "UNKNOWN";
  const section = item.source?.section || item.source_section || item.section || null;
  const page = item.source?.page ?? item.source_page ?? item.page ?? null;

  const supersedesVer =
    item.lineage?.supersedes?.[0] ||
    item.superseded_version ||
    item.supersedes ||
    item.provenance?.resolution?.supersedes_version ||
    null;
  const supersedesReason =
    item.lineage?.superseded_reason ||
    item.superseded_reason ||
    item.provenance?.resolution?.reason ||
    null;
  const rule = item.provenance?.resolution?.rule || item.resolution_rule || null;

  const lines = [
    "========================================================",
    `[AUTHORITATIVE EVIDENCE]`,
    `[AUTHORITATIVE EVIDENCE: ${classification}]`,
    "",
    `Feature: ${featName}`,
    `Feature ID: ${featId}`,
    "",
    `Version: ${version}`,
    `Approval: ${approval}`,
    `Approval Status: ${approval}`,
    `Lifecycle: ${lifecycle}`,
    `Lifecycle Status: ${lifecycle}`,
    "",
    `Effective From: ${validFrom}`,
    `Effective Until: ${validTo}`,
    "",
    `Source: ${sourceDoc}`,
  ];

  if (section) lines.push(`Section: ${section}`);
  if (page != null) lines.push(`Page: ${page}`);
  if (rule) {
    lines.push(`Rule: ${rule}`);
    lines.push(`Precedence Rule: ${rule}`);
  }
  if (supersedesVer) lines.push(`Supersedes: Version ${supersedesVer}`);
  if (supersedesReason) lines.push(`Reason: ${supersedesReason}`);

  lines.push("");
  lines.push("FACTS:");
  lines.push((item.content || item.text || "").trim());
  lines.push("========================================================");

  return lines.join("\n");
}

/**
 * Builds an explicit Unresolved Conflict Banner.
 */
function buildConflictBanner(conflict, resolution = {}) {
  const feat = resolution.feature_id || conflict.feature_id || "System Requirement";
  const cands = conflict.candidates || [];
  const lines = [
    "========================================================",
    `[UNRESOLVED EVIDENCE CONFLICT]`,
    `[UNRESOLVED EVIDENCE CONFLICT: ${feat}]`,
    "",
    `Feature: ${feat}`,
    `CONFLICT TYPE: ${conflict.type || "FACT_CONFLICT"}`,
    `DESCRIPTION: ${
      conflict.description ||
      resolution.resolution_reason ||
      "Two approved records disagree without an authoritative supersession link."
    }`,
    "",
    "Conflicting approved sources:",
  ];

  if (cands.length >= 2) {
    cands.forEach((c) => {
      lines.push(`- ${c.source || c.source_doc || "Approved Document"} (v${c.version || "1.0.0"}): ${(c.value || c.content || "").trim()}`);
    });
    lines.push("");
    cands.forEach((c, idx) => {
      const label = String.fromCharCode(65 + idx); // A, B, ...
      lines.push(`CANDIDATE ${label}:`);
      lines.push(
        `Source: ${c.source || c.source_doc || "Approved Document"} (Version: ${c.version || "1.0.0"}, Status: ${(c.status || "APPROVED").toUpperCase()})`
      );
      lines.push((c.value || c.content || "").trim());
      lines.push("");
    });
  } else {
    lines.push("- Conflicting approved records present at equal authority tier without supersession.");
  }

  lines.push("Instruction:");
  lines.push("INSTRUCTION TO ASSISTANT:");
  lines.push("Do not present either value as an established current fact.");
  lines.push(
    "Conflicting authoritative requirements detected. State both requirements explicitly and inform the user of the contradiction. Do NOT guess which requirement is correct."
  );
  lines.push("========================================================");

  return lines.join("\n");
}

/**
 * Builds an Evolution (DIFF_EVOLUTION) comparison banner.
 */
function buildEvolutionBanner(before, after, options = {}) {
  const feat =
    after?.feature_name ||
    after?.canonical_name ||
    before?.feature_name ||
    after?.feature_id ||
    "Canonical Requirement";
  const reason =
    after?.lineage?.superseded_reason ||
    after?.superseded_reason ||
    after?.provenance?.resolution?.reason ||
    "Requirements evolved across versions";

  const lines = [
    "========================================================",
    `[EVOLUTION EVIDENCE]`,
    `[EVOLUTION EVIDENCE: ${feat}]`,
    "",
    "BEFORE:",
    `Version ${before.version || "1.0.0"} (Status: ${(before.authority?.lifecycle_status || before.lifecycle || "SUPERSEDED").toUpperCase()})`,
    `Source: ${before.source?.document_name || before.source_doc || "Baseline Document"}`,
    (before.content || before.text || "").trim(),
    "",
    "AFTER:",
    `Version ${after.version || "2.0.0"} (Status: ${(after.authority?.lifecycle_status || after.lifecycle || "ACTIVE").toUpperCase()})`,
    `Source: ${after.source?.document_name || after.source_doc || "Successor Document"}`,
    (after.content || after.text || "").trim(),
    "",
    "CHANGE:",
    reason,
    "========================================================",
  ];

  return lines.join("\n");
}

/**
 * Builds a Historical point-in-time banner.
 */
function buildHistoricalBanner(item, asOf) {
  const feat = item.feature_name || item.canonical_name || item.feature_id || "Canonical Requirement";
  const validFrom = item.temporal?.valid_from
    ? typeof item.temporal.valid_from === "number"
      ? new Date(item.temporal.valid_from).toISOString().split("T")[0]
      : String(item.temporal.valid_from).split("T")[0]
    : item.valid_from
      ? String(item.valid_from).split("T")[0]
      : "UNKNOWN";

  const validTo = item.temporal?.valid_to
    ? typeof item.temporal.valid_to === "number"
      ? new Date(item.temporal.valid_to).toISOString().split("T")[0]
      : String(item.temporal.valid_to).split("T")[0]
    : item.valid_to
      ? String(item.valid_to).split("T")[0]
      : "PRESENT";

  const asOfStr = asOf
    ? typeof asOf === "number"
      ? new Date(asOf).toISOString().split("T")[0]
      : String(asOf).split("T")[0]
    : "SPECIFIED HISTORICAL POINT";

  const lines = [
    "========================================================",
    `[HISTORICAL EVIDENCE]`,
    `[HISTORICAL EVIDENCE: ${feat}]`,
    "",
    `Target Date: ${asOfStr}`,
    `Resolved Version: ${item.version || "1.0.0"}`,
    `Status: HISTORICAL`,
    `Effective From: ${validFrom}`,
    `Effective Until: ${validTo}`,
    `Source: ${item.source?.document_name || item.source_doc || "Historical Specification"}`,
    "",
    "FACTS:",
    (item.content || item.text || "").trim(),
    "========================================================",
  ];

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 2. Contradiction Detection & Context Integrity Evaluation Layer
// ---------------------------------------------------------------------------

/**
 * Evaluates the integrity of the assembled evidence context.
 * Deterministically checks for contradictions, stale versions, missing provenance,
 * invalid temporal selection, or incomplete diff pairs.
 *
 * @param {Object} params
 * @returns {Object} Evaluation report
 */
function evaluateContextIntegrity({
  evidence = [],
  intent = "CURRENT_STATE",
  asOf = null,
  resolution = null,
  budget = 8000,
} = {}) {
  const issues = [];
  const items = Array.isArray(evidence) ? evidence : [];
  const now = Date.now();

  let authoritativeCount = 0;
  let supportingCount = 0;
  let historicalCount = 0;
  let supersededCount = 0;
  let missingProvCount = 0;
  let duplicateCount = 0;

  // Track seen hashes / keys for deduplication check
  const seenKeys = new Set();

  // 1. Unresolved Conflict from Resolver
  if (resolution && resolution.status === RESOLUTION_STATES.CONFLICT_UNRESOLVED) {
    const conflict = resolution.conflicts?.[0] || {};
    issues.push({
      type: CONTEXT_ISSUE_TYPES.UNRESOLVED_CONFLICT,
      severity: SEVERITY.CRITICAL,
      feature_id: resolution.feature_id || conflict.feature_id || null,
      description: resolution.resolution_reason || "Unresolved conflict at highest authority tier.",
      resolution_status: "UNRESOLVED",
    });
  }

  // 2. Scan Candidate Items
  for (const item of items) {
    const sourceName = item.source?.document_name || item.source_doc || item.source_name || item.file;
    const featId = item.feature_id;
    const lifecycle = (item.authority?.lifecycle_status || item.lifecycle || "").toLowerCase();
    const isSuperseded = lifecycle === "superseded" || item.lineage?.superseded_by != null || item.superseded_by != null;
    const isHistorical = lifecycle === "superseded" || item.role === "HISTORICAL";

    // Provenance completeness check
    if (!sourceName || !featId) {
      missingProvCount++;
      issues.push({
        type: CONTEXT_ISSUE_TYPES.MISSING_PROVENANCE,
        severity: !sourceName && !featId ? SEVERITY.CRITICAL : SEVERITY.WARNING,
        feature_id: featId || "UNKNOWN",
        description: `Missing critical provenance metadata: ${!sourceName ? "source_document" : ""} ${!featId ? "feature_id" : ""}`.trim(),
        resolution_status: "RESOLVED_WITH_WARNING",
      });
    }

    // Missing temporal boundaries check
    const hasTemporalFrom = item.temporal?.valid_from != null || item.valid_from != null;
    if (!hasTemporalFrom) {
      issues.push({
        type: CONTEXT_ISSUE_TYPES.MISSING_TEMPORAL_BOUNDARIES,
        severity: SEVERITY.WARNING,
        feature_id: featId || "UNKNOWN",
        description: "Candidate chunk lacks valid_from boundary.",
        resolution_status: "RESOLVED_WITH_WARNING",
      });
    }

    // Duplicate check
    const hashKey = item.content_hash || (item.content ? item.content.trim() : item.id);
    if (hashKey) {
      if (seenKeys.has(hashKey)) {
        duplicateCount++;
        issues.push({
          type: CONTEXT_ISSUE_TYPES.DUPLICATE_EVIDENCE,
          severity: SEVERITY.WARNING,
          feature_id: featId || "UNKNOWN",
          description: "Duplicate evidence chunk detected in context.",
          resolution_status: "RESOLVED",
        });
      } else {
        seenKeys.add(hashKey);
      }
    }

    // Role counting
    if (item.role === "SUPPORTING") {
      supportingCount++;
    } else if (isHistorical || item.role === "HISTORICAL") {
      historicalCount++;
    } else {
      authoritativeCount++;
    }

    if (isSuperseded) {
      supersededCount++;
    }

    // 3. Stale Evidence Check for CURRENT_STATE
    if (intent === "CURRENT_STATE" && item.role !== "SUPPORTING") {
      if (isSuperseded) {
        issues.push({
          type: CONTEXT_ISSUE_TYPES.STALE_EVIDENCE,
          severity: SEVERITY.CRITICAL,
          feature_id: featId,
          version: item.version,
          description: `Superseded version ${item.version} included in CURRENT_STATE context.`,
          resolution_status: "UNRESOLVED",
        });
      }
      // Expired validity interval check
      const validToMs = item.temporal?.valid_to ? (typeof item.temporal.valid_to === "number" ? item.temporal.valid_to : Date.parse(item.temporal.valid_to)) : null;
      if (validToMs && validToMs <= now) {
        issues.push({
          type: CONTEXT_ISSUE_TYPES.STALE_EVIDENCE,
          severity: SEVERITY.CRITICAL,
          feature_id: featId,
          version: item.version,
          description: `Expired record (valid_to: ${new Date(validToMs).toISOString().split("T")[0]}) included in CURRENT_STATE.`,
          resolution_status: "UNRESOLVED",
        });
      }
    }
  }

  // 4. Incomplete Evolution Pair Check
  if (intent === "DIFF_EVOLUTION" && resolution) {
    const evo = resolution.evolution || [];
    const hasBefore = evo.some((e) => e.role === "BEFORE");
    const hasAfter = evo.some((e) => e.role === "AFTER");
    if (evo.length > 0 && (!hasBefore || !hasAfter)) {
      issues.push({
        type: CONTEXT_ISSUE_TYPES.INCOMPLETE_EVOLUTION_PAIR,
        severity: SEVERITY.CRITICAL,
        feature_id: resolution.feature_id,
        description: "Evolution context is missing either predecessor (BEFORE) or successor (AFTER) version.",
        resolution_status: "UNRESOLVED",
      });
    }
  }

  // 5. Requirements vs Implementation Coexistence Detection
  const hasReq = items.some((i) => i.evidence_type === "REQUIREMENT" || /requirement|spec/i.test(i.source?.document_name || i.source_doc || ""));
  const hasImpl = items.some((i) => i.role === "IMPLEMENTATION" || i.evidence_type === "IMPLEMENTATION" || /implement|deploy|status/i.test(i.source?.document_name || i.source_doc || ""));
  if (hasReq && hasImpl) {
    issues.push({
      type: CONTEXT_ISSUE_TYPES.REQUIREMENT_VS_IMPLEMENTATION,
      severity: SEVERITY.INFO,
      feature_id: resolution?.feature_id || items[0]?.feature_id || null,
      description: "Both authoritative requirements and as-built implementation records present in context.",
      resolution_status: "RESOLVED",
    });
  }

  // Determine Overall Status
  const criticalCount = issues.filter((i) => i.severity === SEVERITY.CRITICAL).length;
  const warningCount = issues.filter((i) => i.severity === SEVERITY.WARNING).length;

  let status = EVALUATION_STATUS.PASS;
  if (criticalCount > 0) {
    status = EVALUATION_STATUS.FAIL;
  } else if (warningCount > 0) {
    status = EVALUATION_STATUS.WARNING;
  }

  // Calculate Metrics
  const total = items.length;
  const metrics = {
    provenance_completeness: total > 0 ? Number(((total - missingProvCount) / total).toFixed(3)) : 1.0,
    temporal_selection_accuracy: total > 0 ? Number(((total - (intent === "CURRENT_STATE" ? supersededCount : 0)) / total).toFixed(3)) : 1.0,
    superseded_leakage_rate: total > 0 && intent === "CURRENT_STATE" ? Number((supersededCount / total).toFixed(3)) : 0.0,
    duplicate_evidence_rate: total > 0 ? Number((duplicateCount / total).toFixed(3)) : 0.0,
  };

  return {
    status,
    intent,
    evidence_count: total,
    authoritative_count: authoritativeCount,
    supporting_count: supportingCount,
    historical_count: historicalCount,
    superseded_count: supersededCount,
    conflict_count: criticalCount,
    missing_provenance_count: missingProvCount,
    issues,
    metrics,
  };
}

// ---------------------------------------------------------------------------
// 3. Temporal Context Assembler (`assembleTemporalContext`)
// ---------------------------------------------------------------------------

/**
 * Assembles a complete, structured, temporal context pack.
 * Respects token budgets, treats evidence as atomic units, and performs evaluation.
 *
 * @param {Object} params
 * @returns {Object} { text, evaluation, resolution, metrics }
 */
function assembleTemporalContext({
  resolution = null,
  candidates = [],
  query = "",
  intent = "CURRENT_STATE",
  asOf = null,
  version = null,
  budget = 8000,
  options = {},
} = {}) {
  // If resolution is not pre-computed, compute it via EPR
  let res = resolution;
  if (!res && Array.isArray(candidates) && candidates.length > 0) {
    res = resolveEvidence(candidates, { query, intent, asOf, version });
  }

  const effectiveIntent = res?.intent || intent || "CURRENT_STATE";
  const sections = [];

  // Header: Query Intent
  sections.push(`[QUERY INTENT: ${effectiveIntent}]`);
  sections.push(ASSISTANT_DIRECTIVES);

  // 1. Conflict Unresolved Case
  if (res && res.status === RESOLUTION_STATES.CONFLICT_UNRESOLVED) {
    const conflict = res.conflicts?.[0] || {};
    const conflictBlock = buildConflictBanner(conflict, res);
    sections.push(conflictBlock);

    const evalReport = evaluateContextIntegrity({
      evidence: conflict.candidates || [],
      intent: effectiveIntent,
      resolution: res,
      budget,
    });

    sections.push(
      `[CONTEXT EVALUATION SUMMARY: ${evalReport.status}]\nStatus: ${evalReport.status} | Conflicts: ${evalReport.conflict_count} | Canonical claim prohibited.`
    );

    return {
      text: sections.join("\n\n"),
      evaluation: evalReport,
      resolution: res,
      metrics: evalReport.metrics,
    };
  }

  // 2. Evolution Case (DIFF_EVOLUTION)
  if (effectiveIntent === "DIFF_EVOLUTION" && res?.evolution?.length) {
    const before = res.evolution.find((e) => e.role === "BEFORE") || res.evolution[0];
    const after = res.evolution.find((e) => e.role === "AFTER") || res.evolution[1];

    if (before && after) {
      const evoBlock = buildEvolutionBanner(before, after);
      // Atomic pair check against budget
      if (evoBlock.length > budget) {
        sections.push(
          `[DIFF INCOMPLETE: Insufficient budget to include both predecessor and successor versions. Neither was truncated partially.]`
        );
      } else {
        sections.push(evoBlock);
      }
    } else if (before) {
      sections.push(
        `[EVOLUTION EVIDENCE: INITIAL BASELINE]\nVersion ${before.version || "1.0.0"} (Status: ${(before.authority?.lifecycle_status || "ACTIVE").toUpperCase()})\nSource: ${before.source?.document_name || "Baseline"}\n\n${before.content}`
      );
    }

    const evalReport = evaluateContextIntegrity({
      evidence: res.evolution,
      intent: effectiveIntent,
      resolution: res,
      budget,
    });

    sections.push(
      `[CONTEXT EVALUATION SUMMARY: ${evalReport.status}]\nStatus: ${evalReport.status} | Issues: ${evalReport.issues.length}`
    );

    return {
      text: sections.join("\n\n"),
      evaluation: evalReport,
      resolution: res,
      metrics: evalReport.metrics,
    };
  }

  // 3. Historical Case (HISTORICAL_STATE)
  if (effectiveIntent === "HISTORICAL_STATE") {
    const histItems = res?.selected?.length ? res.selected : (res?.historical?.length ? res.historical : []);
    if (!histItems.length) {
      const asOfStr = asOf
        ? typeof asOf === "number"
          ? new Date(asOf).toISOString().split("T")[0]
          : String(asOf).split("T")[0]
        : "the requested date";
      sections.push(
        `[HISTORICAL EVIDENCE UNAVAILABLE]\nNo authoritative historical records cover ${asOfStr}.\nCurrent active versions were NOT substituted.`
      );
    } else {
      for (const item of histItems) {
        sections.push(buildHistoricalBanner(item, asOf));
      }
    }

    const evalReport = evaluateContextIntegrity({
      evidence: histItems,
      intent: effectiveIntent,
      asOf,
      resolution: res,
      budget,
    });

    sections.push(
      `[CONTEXT EVALUATION SUMMARY: ${evalReport.status}]\nStatus: ${evalReport.status} | Historical Records: ${histItems.length}`
    );

    return {
      text: sections.join("\n\n"),
      evaluation: evalReport,
      resolution: res,
      metrics: evalReport.metrics,
    };
  }

  // 4. Current State (CURRENT_STATE) & General Case
  const selectedItems = res?.selected || [];
  const supportingItems = res?.supporting || [];
  const assembledItems = [];

  let hasRequirement = false;
  let hasImplementation = false;

  for (const item of selectedItems) {
    // Strictly exclude superseded and deprecated items from current factual claims
    const lifecycle = (item.authority?.lifecycle_status || item.lifecycle || "").toLowerCase();
    if (lifecycle === "superseded" || item.lineage?.superseded_by != null) {
      continue;
    }
    if (lifecycle === "deprecated") {
      continue;
    }

    if (
      item.role === "IMPLEMENTATION" ||
      item.evidence_type === "IMPLEMENTATION" ||
      /implement|deploy|status/i.test(item.source?.document_name || item.source_doc || "")
    ) {
      hasImplementation = true;
    } else {
      hasRequirement = true;
    }

    assembledItems.push(item);
  }

  // Requirement vs Implementation Notice
  if (hasRequirement && hasImplementation) {
    sections.push(REQUIREMENT_VS_IMPLEMENTATION_NOTICE);
  }

  // Render Authoritative Units Atomically
  let usedChars = sections.join("\n\n").length;
  for (const item of assembledItems) {
    const bannerBlock = buildEvidenceBanner(item);
    if (usedChars + bannerBlock.length <= budget || sections.length <= 2) {
      sections.push(bannerBlock);
      usedChars += bannerBlock.length;
    }
  }

  // Render Supporting Units (lower priority, truncated first)
  for (const sup of supportingItems) {
    const supBlock = `[SUPPORTING EVIDENCE]\nFile: ${sup.source?.document_name || sup.source_doc || "Project File"}${sup.source?.section ? ` · ${sup.source.section}` : ""}\n\n${(sup.content || sup.text || "").trim()}`;
    if (usedChars + supBlock.length <= budget) {
      sections.push(supBlock);
      usedChars += supBlock.length;
    }
  }

  const evalReport = evaluateContextIntegrity({
    evidence: [...assembledItems, ...supportingItems],
    intent: effectiveIntent,
    resolution: res,
    budget,
  });

  sections.push(
    `[CONTEXT EVALUATION SUMMARY: ${evalReport.status}]\nStatus: ${evalReport.status} | Authoritative: ${assembledItems.length} | Supporting: ${supportingItems.length}`
  );

  return {
    text: sections.join("\n\n"),
    evaluation: evalReport,
    resolution: res,
    metrics: evalReport.metrics,
  };
}

/**
 * Enhanced formatEvidenceForContext utilizing Phase 7 assembly engine.
 * Fully backward-compatible with Phase 6 callers.
 */
function formatEvidenceForContext(resolution, budget = 8000) {
  if (!resolution) return "";
  const assembled = assembleTemporalContext({ resolution, budget });
  return assembled.text || "";
}

// ---------------------------------------------------------------------------
// 4. Main Answer Messages Builder (`buildAnswerMessages`)
// ---------------------------------------------------------------------------

/**
 * Builds the complete prompt message array for the answer model.
 */
function buildAnswerMessages({
  deliverable,
  web = false,
  proactive = true,
  deep = false,
  meeting = {},
  summary = "",
  transcript = [],
  now = Date.now(),
  contextSeconds = 120,
  thread = [],
  focus,
  instructions = "", // the USER's own standing instructions for this copilot
  plan = "", // what the USER wrote about this meeting (agenda, to-dos, goals)
  reference = "", // project files that are not indexed (small ones, inlined)
  behavior = "", // learned guide on how the copilot should behave (global)
  catalog = "", // one line per indexed project file: what it holds
  passages = "", // the matching pieces of those files for this moment, already worded
  evidenceResolution = null, // Phase 6 & 7: structured Evidence Precedence Resolver result
  temporalContext = null, // Phase 7: optional direct temporal context assembly
  budget = ANSWER_BUDGET,
}) {
  const parts = [];
  if (instructions)
    parts.push(
      `The USER's standing instructions (follow them unless they conflict with the reply format):\n${clip(instructions, budget.instructions)}`
    );
  if (behavior)
    parts.push(
      `How the USER wants this copilot to behave (learned from their feedback; applies to every project and meeting):\n${clip(behavior, budget.behavior)}`
    );
  if (meeting.title) parts.push(`Meeting: ${clip(oneLine(meeting.title), budget.meeting)}`);
  if (plan)
    parts.push(
      `The USER's notes for this meeting (agenda, to-dos, goals):\n${clip(plan, budget.plan)}`
    );
  if (reference)
    parts.push(
      `Reference files the USER attached (use when relevant, name the file when you rely on it):\n${clip(reference, budget.reference)}`
    );
  if (catalog) parts.push(clip(catalog, budget.catalog));

  let effectivePassages = passages;
  if (temporalContext && typeof temporalContext.text === "string") {
    effectivePassages = temporalContext.text;
  } else if (evidenceResolution) {
    if (typeof evidenceResolution.formatForContext === "function") {
      effectivePassages = evidenceResolution.formatForContext(budget.passages);
    } else {
      const assembled = assembleTemporalContext({
        resolution: evidenceResolution,
        budget: budget.passages,
      });
      if (assembled && assembled.text) {
        effectivePassages = assembled.text;
      }
    }
  }

  if (effectivePassages) parts.push(clip(effectivePassages, budget.passages));

  if (summary)
    parts.push(`Summary of the meeting so far:\n${clip(oneLine(summary), budget.summary)}`);
  const lines = transcriptLines(transcript, { now, contextSeconds }, budget.transcript);
  if (lines.length) parts.push(`Recent transcript, oldest first:\n${lines.join("\n")}`);
  const cards = newest(
    thread.map(
      (c) => `- ${c.title ? c.title + ": " : ""}${clip(oneLine(c.body ?? c.gist ?? ""), 300)}`
    ),
    budget.thread
  );
  if (cards.length)
    parts.push(`Earlier cards in this thread (do not repeat them):\n${cards.join("\n")}`);
  parts.push(
    `${proactive ? "Help with" : "The USER asks"}:\n${clip(oneLine(focus), budget.focus)}`
  );

  // Last line wins: the model skips the search tool unless told right where it answers.
  if (web) parts.push("Run a web search for this before you answer.");
  if (proactive) parts.push(PROACTIVE_CHECK);

  return [
    { role: "system", content: buildSystemPrompt({ deliverable, web, proactive, deep }) },
    { role: "user", content: parts.join("\n\n") },
  ];
}

// ---------------------------------------------------------------------------
// Module Exports
// ---------------------------------------------------------------------------

module.exports = {
  buildAnswerMessages,
  assembleTemporalContext,
  buildEvidenceBanner,
  buildConflictBanner,
  buildEvolutionBanner,
  buildHistoricalBanner,
  evaluateContextIntegrity,
  formatEvidenceForContext,
  CONTEXT_ISSUE_TYPES,
  EVALUATION_STATUS,
  SEVERITY,
  REQUIREMENT_VS_IMPLEMENTATION_NOTICE,
  ASSISTANT_DIRECTIVES,
};
