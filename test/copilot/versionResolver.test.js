// test/copilot/versionResolver.test.js
// Automated test suite for Phase 6: Evidence Precedence Resolver (EPR).
// Verifies scenarios 1 through 17:
// Precedence resolution, conflict detection, temporal intent integration,
// provenance tracking, context packing integration, and legacy backward compatibility.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeEvidence,
  detectConflicts,
  resolvePrecedence,
  buildProvenance,
  resolveEvidence,
  formatEvidenceForContext,
  CONFLICT_TYPES,
  RESOLUTION_STATES,
  SOURCE_PRECEDENCE_TIERS,
} = require("../../src/copilot/core/okf/versionResolver");

const { buildAnswerMessages } = require("../../src/copilot/core/answer/contextPack");

describe("Phase 6: Evidence Precedence Resolver (EPR)", () => {
  // =========================================================================
  // TEST 1: Approved v2 explicitly supersedes approved v1
  // =========================================================================
  test("TEST 1: Approved v2 explicitly supersedes approved v1 -> v2 selected for CURRENT_STATE", () => {
    const candidates = [
      {
        evidence_id: "ev_v1",
        feature_id: "feat:ingestion_pipeline",
        version: "1.0.0",
        content: "Single synchronous pipeline with 50 req/sec limit.",
        approval_status: "approved",
        lifecycle_status: "superseded",
        source_type: "authoritative_requirement",
        valid_from: 1000,
        valid_to: 2000,
        superseded_by: "2.0.0",
        source: { document_name: "Client_Requirements_v1.docx" },
      },
      {
        evidence_id: "ev_v2",
        feature_id: "feat:ingestion_pipeline",
        version: "2.0.0",
        content: "Four parallel streaming pipelines with 2,000 req/sec limit.",
        approval_status: "approved",
        lifecycle_status: "active",
        source_type: "authoritative_requirement",
        valid_from: 2000,
        valid_to: null,
        supersedes: ["1.0.0"],
        superseded_reason: "Upgraded from 1 single pipeline to 4 parallel streaming pipelines",
        source: { document_name: "Client_Requirements_v2.pdf", page: 4 },
      },
    ];

    const result = resolveEvidence(candidates, { intent: "CURRENT_STATE", now: 3000 });

    assert.equal(result.status, RESOLUTION_STATES.RESOLVED);
    assert.equal(result.selected.length, 1);
    assert.equal(result.selected[0].version, "2.0.0");
    assert.equal(result.selected[0].authority.lifecycle_status, "active");
    assert.equal(result.selected[0].provenance.resolution.rule, "EXPLICIT_SUPERSESSION");
    assert.equal(result.selected[0].provenance.resolution.supersedes_version, "1.0.0");
    assert.ok(result.selected[0].content.includes("Four parallel streaming pipelines"));
  });

  // =========================================================================
  // TEST 2: Historical query requests a date before v2 became effective
  // =========================================================================
  test("TEST 2: Historical query requests a date before v2 became effective -> v1 selected", () => {
    const candidates = [
      {
        evidence_id: "ev_v1",
        feature_id: "feat:ingestion_pipeline",
        version: "1.0.0",
        content: "Single synchronous pipeline with 50 req/sec limit.",
        approval_status: "approved",
        lifecycle_status: "superseded",
        source_type: "authoritative_requirement",
        valid_from: 1000,
        valid_to: 2000,
        source: { document_name: "Client_Requirements_v1.docx" },
      },
      {
        evidence_id: "ev_v2",
        feature_id: "feat:ingestion_pipeline",
        version: "2.0.0",
        content: "Four parallel streaming pipelines with 2,000 req/sec limit.",
        approval_status: "approved",
        lifecycle_status: "active",
        source_type: "authoritative_requirement",
        valid_from: 2000,
        valid_to: null,
        source: { document_name: "Client_Requirements_v2.pdf" },
      },
    ];

    const result = resolveEvidence(candidates, { intent: "HISTORICAL_STATE", asOf: 1500 });

    assert.equal(result.status, RESOLUTION_STATES.RESOLVED);
    assert.equal(result.selected.length, 1);
    assert.equal(result.selected[0].version, "1.0.0");
    assert.equal(result.selected[0].provenance.resolution.rule, "HISTORICAL_POINT_IN_TIME");
    assert.ok(result.selected[0].content.includes("Single synchronous pipeline"));
  });

  // =========================================================================
  // TEST 3: DIFF_EVOLUTION requests v1 to v2
  // =========================================================================
  test("TEST 3: DIFF_EVOLUTION requests v1 to v2 -> Both versions retained with transition metadata", () => {
    const candidates = [
      {
        evidence_id: "ev_v1",
        feature_id: "feat:ingestion_pipeline",
        version: "1.0.0",
        content: "Single synchronous pipeline limit 50 req/sec.",
        approval_status: "approved",
        lifecycle_status: "superseded",
        valid_from: 1000,
        valid_to: 2000,
        source: { document_name: "Client_Requirements_v1.docx" },
      },
      {
        evidence_id: "ev_v2",
        feature_id: "feat:ingestion_pipeline",
        version: "2.0.0",
        content: "Four parallel streaming pipelines limit 2,000 req/sec.",
        approval_status: "approved",
        lifecycle_status: "active",
        valid_from: 2000,
        valid_to: null,
        supersedes: ["1.0.0"],
        superseded_reason: "Migrated to parallel streaming architecture in Phase 2",
        source: { document_name: "Client_Requirements_v2.pdf" },
      },
    ];

    const result = resolveEvidence(candidates, { intent: "DIFF_EVOLUTION" });

    assert.equal(result.status, RESOLUTION_STATES.RESOLVED);
    assert.equal(result.evolution.length, 2);

    const before = result.evolution.find((e) => e.role === "BEFORE");
    const after = result.evolution.find((e) => e.role === "AFTER");

    assert.ok(before, "BEFORE version must be present");
    assert.equal(before.version, "1.0.0");
    assert.ok(after, "AFTER version must be present");
    assert.equal(after.version, "2.0.0");
    assert.equal(after.provenance.resolution.rule, "EXPLICIT_SUPERSESSION");
    assert.equal(after.provenance.resolution.supersedes_version, "1.0.0");
  });

  // =========================================================================
  // TEST 4: Draft v3 conflicts with approved v2
  // =========================================================================
  test("TEST 4: Draft v3 conflicts with approved v2 -> Approved v2 selected", () => {
    const candidates = [
      {
        evidence_id: "ev_v2",
        feature_id: "feat:ingestion_pipeline",
        version: "2.0.0",
        content: "Approved throughput is 2,000 req/sec.",
        approval_status: "approved",
        lifecycle_status: "active",
        source_type: "authoritative_requirement",
        source: { document_name: "Client_Requirements_v2.pdf" },
      },
      {
        evidence_id: "ev_v3_draft",
        feature_id: "feat:ingestion_pipeline",
        version: "3.0.0",
        content: "Proposed throughput is 10,000 req/sec.",
        approval_status: "draft",
        lifecycle_status: "active",
        source_type: "authoritative_requirement",
        source: { document_name: "RFC_Draft_v3.md" },
      },
    ];

    const result = resolveEvidence(candidates, { intent: "CURRENT_STATE" });

    assert.equal(result.status, RESOLUTION_STATES.RESOLVED);
    assert.equal(result.selected.length, 1);
    assert.equal(result.selected[0].version, "2.0.0");
    assert.equal(result.selected[0].authority.approval_status, "approved");
    assert.ok(result.selected[0].content.includes("2,000 req/sec"));
  });

  // =========================================================================
  // TEST 5: Two approved records disagree without supersession
  // =========================================================================
  test("TEST 5: Two approved records disagree without supersession -> CONFLICT_UNRESOLVED", () => {
    const candidates = [
      {
        evidence_id: "ev_prd_a",
        feature_id: "feat:ingestion_pipeline",
        version: "2.0.0",
        content: "Throughput requirement is 2,000 req/sec across 4 streaming channels.",
        approval_status: "approved",
        lifecycle_status: "active",
        source_type: "authoritative_requirement",
        valid_from: 2000,
        valid_to: null,
        source: { document_name: "Client_Requirements_v2_A.pdf" },
      },
      {
        evidence_id: "ev_prd_b",
        feature_id: "feat:ingestion_pipeline",
        version: "2.0.0",
        content: "Throughput requirement is 5,000 req/sec across 4 streaming channels.",
        approval_status: "approved",
        lifecycle_status: "active",
        source_type: "authoritative_requirement",
        valid_from: 2000,
        valid_to: null,
        source: { document_name: "Client_Requirements_v2_B.pdf" },
      },
    ];

    const result = resolveEvidence(candidates, { intent: "CURRENT_STATE" });

    assert.equal(result.status, RESOLUTION_STATES.CONFLICT_UNRESOLVED);
    assert.equal(result.selected.length, 0, "No winner must be selected when approved sources contradict");
    assert.ok(result.conflicts.length > 0);
    assert.equal(result.conflicts[0].type, CONFLICT_TYPES.SOURCE_CONFLICT);
    assert.match(result.resolution_reason, /Both records are approved/);
  });

  // =========================================================================
  // TEST 6: Newer upload timestamp but lower authority
  // =========================================================================
  test("TEST 6: Newer upload timestamp but lower authority -> Higher-authority record remains selected", () => {
    const candidates = [
      {
        evidence_id: "ev_okf_older",
        feature_id: "feat:copilot_orchestration",
        version: "1.0.0",
        content: "Canonical scheduler turn gap is strictly 1.5 seconds.",
        approval_status: "approved",
        lifecycle_status: "active",
        source_type: "canonical_specification",
        transaction_time: 1000, // Older upload
        source: { document_name: "OKF-0002-copilot-architecture.md" },
      },
      {
        evidence_id: "ev_guide_newer",
        feature_id: "feat:copilot_orchestration",
        version: "1.0.0",
        content: "Guide says scheduler turn gap is 2.5 seconds.",
        approval_status: "approved",
        lifecycle_status: "active",
        source_type: "supporting_document",
        transaction_time: 5000, // Newer upload
        source: { document_name: "Team_Guide_Notes.md" },
      },
    ];

    const result = resolveEvidence(candidates, { intent: "CURRENT_STATE" });

    assert.equal(result.status, RESOLUTION_STATES.RESOLVED);
    assert.equal(result.selected.length, 1);
    assert.equal(result.selected[0].evidence_id, "ev_okf_older");
    assert.equal(result.selected[0].provenance.resolution.rule, "CANONICAL_SOURCE_PRECEDENCE");
    assert.ok(result.selected[0].content.includes("strictly 1.5 seconds"));
  });

  // =========================================================================
  // TEST 7: Supersession pointer references a different feature
  // =========================================================================
  test("TEST 7: Supersession pointer references a different feature -> LINEAGE_CONFLICT", () => {
    const candidates = [
      {
        evidence_id: "ev_bad_pointer",
        feature_id: "feat:ingestion_pipeline",
        version: "2.0.0",
        content: "Pipeline spec v2.",
        approval_status: "approved",
        lifecycle_status: "active",
        supersedes_feature_id: "feat:storage_isolation", // Mismatched feature
        source: { document_name: "bad_spec.pdf" },
      },
      {
        evidence_id: "ev_other",
        feature_id: "feat:ingestion_pipeline",
        version: "1.0.0",
        content: "Pipeline spec v1.",
        approval_status: "approved",
        lifecycle_status: "superseded",
        source: { document_name: "old_spec.pdf" },
      },
    ];

    const result = resolveEvidence(candidates, { intent: "CURRENT_STATE" });

    assert.equal(result.status, RESOLUTION_STATES.CONFLICT_UNRESOLVED);
    assert.equal(result.selected.length, 0);
    assert.ok(result.conflicts.some((c) => c.type === CONFLICT_TYPES.LINEAGE_CONFLICT));
  });

  // =========================================================================
  // TEST 8: Expired record appears in current-state candidates
  // =========================================================================
  test("TEST 8: Expired record appears in current-state candidates -> Excluded from current evidence", () => {
    const candidates = [
      {
        evidence_id: "ev_expired",
        feature_id: "feat:ingestion_pipeline",
        version: "1.0.0",
        content: "Expired temporary ingestion fix.",
        approval_status: "approved",
        lifecycle_status: "active",
        valid_from: 1000,
        valid_to: 2000, // Expired at t=2000
        source: { document_name: "temp_fix.pdf" },
      },
    ];

    // Current time is 3000 (after valid_to)
    const result = resolveEvidence(candidates, { intent: "CURRENT_STATE", now: 3000 });

    assert.equal(result.selected.length, 0);
    assert.ok(result.status === RESOLUTION_STATES.HISTORICAL_ONLY || result.status === RESOLUTION_STATES.INSUFFICIENT_EVIDENCE);
  });

  // =========================================================================
  // TEST 9: Two records have overlapping valid-time intervals and disagree
  // =========================================================================
  test("TEST 9: Two records have overlapping valid-time intervals and disagree -> TEMPORAL_CONFLICT", () => {
    const candidates = [
      {
        evidence_id: "ev_t1",
        feature_id: "feat:ingestion_pipeline",
        version: "1.0.0",
        content: "Maximum ingestion throughput is 100 req/sec.",
        approval_status: "approved",
        lifecycle_status: "active",
        source_type: "canonical_specification",
        valid_from: 1000,
        valid_to: 5000,
        source: { document_name: "Spec_Alpha.pdf" },
      },
      {
        evidence_id: "ev_t2",
        feature_id: "feat:ingestion_pipeline",
        version: "1.0.0",
        content: "Maximum ingestion throughput is 300 req/sec.",
        approval_status: "approved",
        lifecycle_status: "active",
        source_type: "authoritative_requirement",
        valid_from: 3000, // Overlaps with [1000, 5000]
        valid_to: 7000,
        source: { document_name: "Spec_Beta.pdf" },
      },
    ];

    const conflicts = detectConflicts(candidates.map((c) => normalizeEvidence(c)));

    assert.ok(conflicts.length > 0);
    assert.ok(conflicts.some((c) => c.type === CONFLICT_TYPES.TEMPORAL_CONFLICT));
  });

  // =========================================================================
  // TEST 10: Missing version metadata
  // =========================================================================
  test("TEST 10: Missing version metadata -> No crash; evidence normalized safely with null version", () => {
    const candidates = [
      {
        evidence_id: "ev_no_ver",
        feature_id: "feat:storage_isolation",
        content: "Storage isolation invariant.",
        source: { document_name: "notes.txt" },
      },
    ];

    const norm = normalizeEvidence(candidates[0]);
    assert.equal(norm.version, null);
    assert.equal(norm.feature_id, "feat:storage_isolation");

    const result = resolveEvidence(candidates, { intent: "CURRENT_STATE" });
    assert.ok(result != null);
    assert.ok(result.status != null);
  });

  // =========================================================================
  // TEST 11: Duplicate evidence records
  // =========================================================================
  test("TEST 11: Duplicate evidence records -> Deterministic deduplication without losing provenance", () => {
    const candidates = [
      {
        evidence_id: "ev_dup_1",
        feature_id: "feat:ingestion_pipeline",
        version: "2.0.0",
        content: "Four streaming channels.",
        approval_status: "approved",
        lifecycle_status: "active",
        source: { document_name: "Client_Requirements_v2.pdf" },
      },
      {
        evidence_id: "ev_dup_2",
        feature_id: "feat:ingestion_pipeline",
        version: "2.0.0",
        content: "Four streaming channels.",
        approval_status: "approved",
        lifecycle_status: "active",
        source: { document_name: "Client_Requirements_v2.pdf" },
      },
    ];

    const result = resolveEvidence(candidates, { intent: "CURRENT_STATE" });

    assert.equal(result.status, RESOLUTION_STATES.RESOLVED);
    assert.equal(result.selected.length, 1, "Duplicate records must be deduplicated");
    assert.ok(result.selected[0].provenance != null);
  });

  // =========================================================================
  // TEST 12: Empty candidates
  // =========================================================================
  test("TEST 12: Empty candidates -> INSUFFICIENT_EVIDENCE", () => {
    const result = resolveEvidence([], { intent: "CURRENT_STATE" });

    assert.equal(result.status, RESOLUTION_STATES.INSUFFICIENT_EVIDENCE);
    assert.equal(result.selected.length, 0);
    assert.ok(result.warnings.length > 0);
  });

  // =========================================================================
  // TEST 13: Historical predecessor is deprecated after its validity period
  // =========================================================================
  test("TEST 13: Historical predecessor is deprecated after its validity period -> Historical retrieval respects requested date", () => {
    const candidates = [
      {
        evidence_id: "ev_v1_dep",
        feature_id: "feat:ingestion_pipeline",
        version: "1.0.0",
        content: "Historical baseline v1 in January.",
        approval_status: "approved",
        lifecycle_status: "deprecated",
        valid_from: 1000,
        valid_to: 2000,
        source: { document_name: "old_spec.docx" },
      },
      {
        evidence_id: "ev_v2_act",
        feature_id: "feat:ingestion_pipeline",
        version: "2.0.0",
        content: "Active specification v2 in March.",
        approval_status: "approved",
        lifecycle_status: "active",
        valid_from: 2000,
        valid_to: null,
        source: { document_name: "new_spec.pdf" },
      },
    ];

    const result = resolveEvidence(candidates, { intent: "HISTORICAL_STATE", asOf: 1500 });

    assert.equal(result.status, RESOLUTION_STATES.RESOLVED);
    assert.equal(result.selected.length, 1);
    assert.equal(result.selected[0].version, "1.0.0");
    assert.ok(result.selected[0].content.includes("Historical baseline v1"));
  });

  // =========================================================================
  // TEST 14: Existing non-temporal RAG evidence
  // =========================================================================
  test("TEST 14: Existing non-temporal RAG evidence -> Backward-compatible handling as supporting evidence", () => {
    const candidates = [
      {
        id: 99,
        file: "meeting_notes.txt",
        text: "Team discussed customer onboarding flow.",
        meta: { heading: "Discussion" },
      },
    ];

    const result = resolveEvidence(candidates, { intent: "CURRENT_STATE" });

    assert.equal(result.status, RESOLUTION_STATES.RESOLVED);
    assert.equal(result.supporting.length, 1);
    assert.equal(result.supporting[0].role, "SUPPORTING");
    assert.equal(result.supporting[0].provenance.resolution.rule, "NON_AUTHORITATIVE_RAG");
  });

  // =========================================================================
  // TEST 15: Malformed supersession chain (circular)
  // =========================================================================
  test("TEST 15: Malformed supersession chain -> LINEAGE_CONFLICT and no silent winner", () => {
    const candidates = [
      {
        evidence_id: "ev_c1",
        feature_id: "feat:ingestion_pipeline",
        version: "1.0.0",
        content: "Specification 1.",
        approval_status: "approved",
        lifecycle_status: "active",
        supersedes: ["2.0.0"], // Circular
      },
      {
        evidence_id: "ev_c2",
        feature_id: "feat:ingestion_pipeline",
        version: "2.0.0",
        content: "Specification 2.",
        approval_status: "approved",
        lifecycle_status: "active",
        supersedes: ["1.0.0"], // Circular
      },
    ];

    const result = resolveEvidence(candidates, { intent: "CURRENT_STATE" });

    assert.equal(result.status, RESOLUTION_STATES.CONFLICT_UNRESOLVED);
    assert.equal(result.selected.length, 0);
    assert.ok(result.conflicts.some((c) => c.type === CONFLICT_TYPES.LINEAGE_CONFLICT));
  });

  // =========================================================================
  // TEST 16: contextPack.js integration
  // =========================================================================
  test("TEST 16: contextPack.js integration -> Renders [AUTHORITATIVE EVIDENCE] and [UNRESOLVED EVIDENCE CONFLICT]", () => {
    // 1. Authoritative resolution formatting
    const authResolution = {
      status: RESOLUTION_STATES.RESOLVED,
      intent: "CURRENT_STATE",
      selected: [
        {
          evidence_id: "ev_1",
          feature_id: "feat:ingestion_pipeline",
          version: "2.0.0",
          content: "The system processes 2,000 req/sec over 4 parallel streaming channels.",
          source: { document_name: "Client_Requirements_v2.pdf", section: "System Architecture > Ingestion", page: 4 },
          authority: { approval_status: "approved", lifecycle_status: "active" },
          provenance: {
            resolution: {
              outcome: "SELECTED",
              rule: "EXPLICIT_SUPERSESSION",
              supersedes_version: "1.0.0",
              reason: "Upgraded from single pipeline to 4 parallel streaming pipelines",
            },
          },
        },
      ],
    };

    const [sys1, user1] = buildAnswerMessages({
      evidenceResolution: authResolution,
      focus: "What is the ingestion architecture?",
    });

    assert.ok(user1.content.includes("[AUTHORITATIVE EVIDENCE: AUTHORITATIVE REQUIREMENT]"));
    assert.ok(user1.content.includes("Feature: feat:ingestion_pipeline"));
    assert.ok(user1.content.includes("Version: 2.0.0"));
    assert.ok(user1.content.includes("Approval: APPROVED"));
    assert.ok(user1.content.includes("Rule: EXPLICIT_SUPERSESSION"));
    assert.ok(user1.content.includes("Supersedes: Version 1.0.0"));
    assert.ok(user1.content.includes("The system processes 2,000 req/sec over 4 parallel streaming channels."));

    // 2. Unresolved conflict formatting
    const conflictResolution = {
      status: RESOLUTION_STATES.CONFLICT_UNRESOLVED,
      feature_id: "feat:ingestion_pipeline",
      conflicts: [
        {
          type: CONFLICT_TYPES.SOURCE_CONFLICT,
          candidates: [
            { source: "Client_Requirements_v2.pdf", version: "2.0.0", value: "4 pipelines" },
            { source: "Architecture_ADR_04.md", version: "1.1.0", value: "3 pipelines" },
          ],
        },
      ],
      resolution_reason: "Both records are approved and no authoritative supersession relationship establishes precedence.",
    };

    const [sys2, user2] = buildAnswerMessages({
      evidenceResolution: conflictResolution,
      focus: "How many pipelines do we have?",
    });

    assert.ok(user2.content.includes("[UNRESOLVED EVIDENCE CONFLICT]"));
    assert.ok(user2.content.includes("Conflicting approved sources:"));
    assert.ok(user2.content.includes("Client_Requirements_v2.pdf (v2.0.0): 4 pipelines"));
    assert.ok(user2.content.includes("Architecture_ADR_04.md (v1.1.0): 3 pipelines"));
    assert.ok(user2.content.includes("Instruction:"));
    assert.ok(user2.content.includes("Do not present either value as an established current fact."));
  });

  // =========================================================================
  // TEST 17: Legacy resolvePrecedence backward compatibility
  // =========================================================================
  test("TEST 17: Legacy resolvePrecedence backward compatibility -> Passes legacy document precedence", () => {
    const legacyCandidates = [
      { id: "OKF-0002", version: "1.0.0", status: "approved" },
      { id: "OKF-0002", version: "2.0.0", status: "draft" },
    ];

    // Default: highest approved version
    const res1 = resolvePrecedence(legacyCandidates);
    assert.equal(res1.status, "resolved");
    assert.equal(res1.resolvedRecord.version, "1.0.0");

    // Pinning: explicit requestedVersion
    const res2 = resolvePrecedence(legacyCandidates, { requestedVersion: "2.0.0" });
    assert.equal(res2.status, "resolved");
    assert.equal(res2.resolvedRecord.version, "2.0.0");
  });
});
