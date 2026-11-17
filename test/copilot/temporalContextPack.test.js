// test/copilot/temporalContextPack.test.js
// Automated test suite for Phase 7: Production-Grade Temporal Context Assembly & Evaluation.

const { test } = require("node:test");
const assert = require("node:assert");

const {
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
  REQUIREMENT_VS_IMPLEMENTATION_NOTICE,
} = require("../../src/copilot/core/answer/contextPack");

const {
  resolveEvidence,
  RESOLUTION_STATES,
  CONFLICT_TYPES,
} = require("../../src/copilot/core/okf/versionResolver");

// ---------------------------------------------------------------------------
// Mock Fixtures
// ---------------------------------------------------------------------------

const chunkV1 = {
  id: "chunk_001_v1",
  feature_id: "feat:ingestion_pipeline",
  feature_name: "Data Ingestion Pipeline Architecture",
  version: "1.0.0",
  status: "approved",
  lifecycle: "superseded",
  authority_tier: 100,
  source_doc: "Client_Requirements_v1.pdf",
  section: "Ingestion Architecture",
  page: 2,
  content: "Single synchronous ingestion pipeline supporting up to 50 req/sec limit.",
  content_hash: "hash_v1_sync",
  valid_from: "2026-01-01T00:00:00.000Z",
  valid_to: "2026-03-01T00:00:00.000Z",
  superseded_by: "chunk_002_v2",
};

const chunkV2 = {
  id: "chunk_002_v2",
  feature_id: "feat:ingestion_pipeline",
  feature_name: "Data Ingestion Pipeline Architecture",
  version: "2.0.0",
  status: "approved",
  lifecycle: "active",
  authority_tier: 100,
  source_doc: "Client_Requirements_v2.pdf",
  section: "System Architecture > Ingestion Layer",
  page: 4,
  content: "The data ingestion pipeline architecture processes up to 2,000 req/sec over 4 parallel streaming channels.",
  content_hash: "hash_v2_stream",
  valid_from: "2026-03-01T00:00:00.000Z",
  valid_to: null,
  supersedes: "1.0.0",
  superseded_reason: "Client-approved architectural upgrade to 4 parallel streaming channels.",
};

const implementationRecord = {
  id: "chunk_impl_001",
  feature_id: "feat:ingestion_pipeline",
  feature_name: "Data Ingestion Pipeline Architecture",
  version: "1.2.0-deploy",
  status: "approved",
  lifecycle: "active",
  authority_tier: 60,
  role: "IMPLEMENTATION",
  evidence_type: "IMPLEMENTATION",
  source_doc: "Infrastructure_Status_Report.md",
  section: "Cluster Deployment Metrics",
  page: 1,
  content: "Currently 2 parallel streaming pipelines deployed in production cluster.",
  content_hash: "hash_impl_2pipe",
  valid_from: "2026-03-15T00:00:00.000Z",
  valid_to: null,
};

const conflictingApprovedRecord = {
  id: "chunk_conflict_001",
  feature_id: "feat:ingestion_pipeline",
  feature_name: "Data Ingestion Pipeline Architecture",
  version: "2.0.0",
  status: "approved",
  lifecycle: "active",
  authority_tier: 100,
  source_doc: "Architecture_ADR_04.md",
  section: "Pipeline Specs",
  page: 3,
  content: "The ingestion architecture operates 3 parallel batch pipelines.",
  content_hash: "hash_conflict_3pipe",
  valid_from: "2026-03-01T00:00:00.000Z",
  valid_to: null,
};

// ---------------------------------------------------------------------------
// TEST 1: Current-State Retrieval & Stale Exclusion
// ---------------------------------------------------------------------------
test("TEST 1: Current-state retrieval excludes superseded evidence from current facts", () => {
  const resolution = resolveEvidence([chunkV2, chunkV1], { intent: "CURRENT_STATE" });
  assert.equal(resolution.status, RESOLUTION_STATES.RESOLVED);
  assert.equal(resolution.selected.length, 1);
  assert.equal(resolution.selected[0].version, "2.0.0");

  const assembled = assembleTemporalContext({
    resolution,
    intent: "CURRENT_STATE",
    budget: 8000,
  });

  assert.match(assembled.text, /\[QUERY INTENT: CURRENT_STATE\]/);
  assert.match(assembled.text, /\[AUTHORITATIVE EVIDENCE: CANONICAL SPECIFICATION\]/);
  assert.match(assembled.text, /Version: 2\.0\.0/);
  assert.match(assembled.text, /4 parallel streaming channels/);
  // v1 must NOT appear in current factual evidence
  assert.ok(!assembled.text.includes("Single synchronous ingestion pipeline"));

  assert.equal(assembled.evaluation.status, EVALUATION_STATUS.PASS);
  assert.equal(assembled.metrics.superseded_leakage_rate, 0.0);
  assert.equal(assembled.metrics.temporal_selection_accuracy, 1.0);
});

// ---------------------------------------------------------------------------
// TEST 2: Historical Point-in-Time Retrieval
// ---------------------------------------------------------------------------
test("TEST 2: Historical retrieval retrieves version covering date and flags uncovered dates", () => {
  // Point in time: 2026-01-20 (falls within v1 validity: 2026-01-01 to 2026-03-01)
  const targetDate = Date.parse("2026-01-20T00:00:00.000Z");
  const resolution = resolveEvidence([chunkV1, chunkV2], {
    intent: "HISTORICAL_STATE",
    asOf: targetDate,
  });

  assert.equal(resolution.intent, "HISTORICAL_STATE");
  assert.equal(resolution.selected.length, 1);
  assert.equal(resolution.selected[0].version, "1.0.0");

  const assembled = assembleTemporalContext({
    resolution,
    intent: "HISTORICAL_STATE",
    asOf: targetDate,
  });

  assert.match(assembled.text, /\[QUERY INTENT: HISTORICAL_STATE\]/);
  assert.match(assembled.text, /\[HISTORICAL EVIDENCE/);
  assert.match(assembled.text, /Target Date: 2026-01-20/);
  assert.match(assembled.text, /Resolved Version: 1\.0\.0/);
  assert.match(assembled.text, /Single synchronous ingestion pipeline/);
  // v2 must not be substituted
  assert.ok(!assembled.text.includes("4 parallel streaming channels"));

  // Subtest: Uncovered historical date (e.g. 2024-01-01)
  const oldDate = Date.parse("2024-01-01T00:00:00.000Z");
  const emptyResolution = resolveEvidence([chunkV1, chunkV2], {
    intent: "HISTORICAL_STATE",
    asOf: oldDate,
  });

  const assembledOld = assembleTemporalContext({
    resolution: emptyResolution,
    intent: "HISTORICAL_STATE",
    asOf: oldDate,
  });

  assert.match(assembledOld.text, /\[HISTORICAL EVIDENCE UNAVAILABLE\]/);
  assert.match(assembledOld.text, /Current active versions were NOT substituted/);
});

// ---------------------------------------------------------------------------
// TEST 3: Evolution Retrieval & Predecessor-Successor Pairing
// ---------------------------------------------------------------------------
test("TEST 3: Evolution retrieval includes predecessor and successor without synthetic merging", () => {
  const resolution = resolveEvidence([chunkV1, chunkV2], { intent: "DIFF_EVOLUTION" });
  assert.equal(resolution.intent, "DIFF_EVOLUTION");
  assert.equal(resolution.evolution.length, 2);

  const assembled = assembleTemporalContext({
    resolution,
    intent: "DIFF_EVOLUTION",
    budget: 8000,
  });

  assert.match(assembled.text, /\[QUERY INTENT: DIFF_EVOLUTION\]/);
  assert.match(assembled.text, /\[EVOLUTION EVIDENCE/);
  assert.match(assembled.text, /BEFORE:/);
  assert.match(assembled.text, /Version 1\.0\.0/);
  assert.match(assembled.text, /Single synchronous ingestion pipeline/);
  assert.match(assembled.text, /AFTER:/);
  assert.match(assembled.text, /Version 2\.0\.0/);
  assert.match(assembled.text, /4 parallel streaming channels/);
  assert.match(assembled.text, /CHANGE:/);
  assert.match(assembled.text, /Client-approved architectural upgrade/);

  assert.equal(assembled.evaluation.status, EVALUATION_STATUS.PASS);
  assert.equal(assembled.metrics.temporal_selection_accuracy, 1.0);
});

// ---------------------------------------------------------------------------
// TEST 4: Unresolved Conflict & Evaluation Fail/Warning
// ---------------------------------------------------------------------------
test("TEST 4: Unresolved conflict surfaces both sources with explicit anti-hallucination instruction", () => {
  const resolution = resolveEvidence([chunkV2, conflictingApprovedRecord], {
    intent: "CURRENT_STATE",
  });
  assert.equal(resolution.status, RESOLUTION_STATES.CONFLICT_UNRESOLVED);

  const assembled = assembleTemporalContext({
    resolution,
    intent: "CURRENT_STATE",
    budget: 8000,
  });

  assert.match(assembled.text, /\[UNRESOLVED EVIDENCE CONFLICT/);
  assert.match(assembled.text, /CANDIDATE A:/);
  assert.match(assembled.text, /CANDIDATE B:/);
  assert.match(assembled.text, /Client_Requirements_v2\.pdf/);
  assert.match(assembled.text, /Architecture_ADR_04\.md/);
  assert.match(assembled.text, /Do not present either value as an established current fact/);
  assert.match(assembled.text, /Do NOT guess which requirement is correct/);

  assert.equal(assembled.evaluation.status, EVALUATION_STATUS.FAIL);
  assert.ok(assembled.evaluation.conflict_count >= 1);
});

// ---------------------------------------------------------------------------
// TEST 5: Missing Metadata Handling
// ---------------------------------------------------------------------------
test("TEST 5: Missing metadata is represented cleanly without fabricating dates or crashing", () => {
  const incompleteChunk = {
    id: "chunk_missing_01",
    feature_id: "feat:auth",
    version: "1.0.0",
    status: "approved",
    lifecycle: "active",
    source_doc: "Auth_Spec.md",
    section: null,
    page: null,
    valid_from: null,
    valid_to: null,
    content: "OAuth2 with PKCE mandatory for public clients.",
  };

  const banner = buildEvidenceBanner(incompleteChunk);
  assert.match(banner, /Effective From: UNKNOWN/);
  assert.match(banner, /Effective Until: PRESENT/);
  assert.match(banner, /Source: Auth_Spec\.md/);
  assert.ok(!banner.includes("Page:")); // Omitted when null
  assert.ok(!banner.includes("Section:")); // Omitted when null
  assert.match(banner, /OAuth2 with PKCE mandatory/);

  const evalReport = evaluateContextIntegrity({
    evidence: [incompleteChunk],
    intent: "CURRENT_STATE",
  });
  // Non-critical warning recorded for missing temporal bounds
  assert.equal(evalReport.status, EVALUATION_STATUS.WARNING);
  assert.ok(evalReport.issues.some((i) => i.type === CONTEXT_ISSUE_TYPES.MISSING_TEMPORAL_BOUNDARIES));
});

// ---------------------------------------------------------------------------
// TEST 6: Context Budget & Atomic Truncation
// ---------------------------------------------------------------------------
test("TEST 6: Context budget prioritizes authoritative items and never separates banners from facts", () => {
  const largeSupporting = {
    id: "sup_01",
    role: "SUPPORTING",
    feature_id: "feat:ingestion_pipeline",
    source_doc: "Engineering_Notes.txt",
    content: "Lorem ipsum dolor sit amet ".repeat(20),
  };

  // Tight budget that can fit the authoritative banner but cannot fit the large supporting chunk
  const assembled = assembleTemporalContext({
    candidates: [chunkV2, largeSupporting],
    intent: "CURRENT_STATE",
    budget: 900,
  });

  // Authoritative banner and facts are intact
  assert.match(assembled.text, /\[AUTHORITATIVE EVIDENCE: CANONICAL SPECIFICATION\]/);
  assert.match(assembled.text, /FACTS:/);
  assert.match(assembled.text, /4 parallel streaming channels/);
  // Supporting chunk dropped under tight budget
  assert.ok(!assembled.text.includes("Lorem ipsum dolor sit amet"));

  // Check evolution pair atomicity under tight budget
  const tightEvo = assembleTemporalContext({
    candidates: [chunkV1, chunkV2],
    intent: "DIFF_EVOLUTION",
    budget: 100, // Impossibly tight budget
  });
  assert.match(tightEvo.text, /\[DIFF INCOMPLETE: Insufficient budget/);
});

// ---------------------------------------------------------------------------
// TEST 7: Requirements Versus Implementation Distinction
// ---------------------------------------------------------------------------
test("TEST 7: Requirements and implementation records remain distinct with explicit notice", () => {
  const resolution = {
    status: RESOLUTION_STATES.RESOLVED,
    intent: "CURRENT_STATE",
    feature_id: "feat:ingestion_pipeline",
    selected: [chunkV2, implementationRecord],
  };

  const assembled = assembleTemporalContext({
    resolution,
    intent: "CURRENT_STATE",
    budget: 8000,
  });

  assert.match(assembled.text, /\[AUTHORITATIVE EVIDENCE: (?:CANONICAL SPECIFICATION|AUTHORITATIVE REQUIREMENT)\]/);
  assert.match(assembled.text, /\[AUTHORITATIVE EVIDENCE: AS-BUILT IMPLEMENTATION RECORD\]/);
  assert.match(assembled.text, /\[REQUIREMENT VS IMPLEMENTATION NOTICE\]/);
  assert.match(assembled.text, /4 parallel streaming channels/);
  assert.match(assembled.text, /Currently 2 parallel streaming pipelines deployed/);

  // Both facts are preserved side-by-side
  assert.ok(assembled.text.includes("Client_Requirements_v2.pdf"));
  assert.ok(assembled.text.includes("Infrastructure_Status_Report.md"));
});

// ---------------------------------------------------------------------------
// TEST 8: Contradiction Detection & Context Integrity Evaluation
// ---------------------------------------------------------------------------
test("TEST 8: evaluateContextIntegrity detects stale evidence, contradictions, and incomplete evolution", () => {
  // Stale evidence in CURRENT_STATE
  const staleEval = evaluateContextIntegrity({
    evidence: [chunkV1], // v1 is superseded
    intent: "CURRENT_STATE",
  });
  assert.equal(staleEval.status, EVALUATION_STATUS.FAIL);
  assert.ok(staleEval.issues.some((i) => i.type === CONTEXT_ISSUE_TYPES.STALE_EVIDENCE));

  // Incomplete evolution pair in DIFF_EVOLUTION
  const incompleteEvoEval = evaluateContextIntegrity({
    evidence: [chunkV1],
    intent: "DIFF_EVOLUTION",
    resolution: { intent: "DIFF_EVOLUTION", evolution: [{ role: "BEFORE", ...chunkV1 }] },
  });
  assert.equal(incompleteEvoEval.status, EVALUATION_STATUS.FAIL);
  assert.ok(incompleteEvoEval.issues.some((i) => i.type === CONTEXT_ISSUE_TYPES.INCOMPLETE_EVOLUTION_PAIR));

  // Duplicate evidence detection
  const dupEval = evaluateContextIntegrity({
    evidence: [chunkV2, { ...chunkV2, id: "chunk_dup_v2" }],
    intent: "CURRENT_STATE",
  });
  assert.ok(dupEval.issues.some((i) => i.type === CONTEXT_ISSUE_TYPES.DUPLICATE_EVIDENCE));
  assert.ok(dupEval.metrics.duplicate_evidence_rate > 0);
});

// ---------------------------------------------------------------------------
// TEST 9: Deterministic Metrics Benchmark
// ---------------------------------------------------------------------------
test("TEST 9: Deterministic evaluation metrics benchmark achieves expected accuracy and zero leakage", () => {
  // Benchmark dataset: 5 scenarios
  const scenarios = [
    { intent: "CURRENT_STATE", candidates: [chunkV2] },
    { intent: "CURRENT_STATE", candidates: [chunkV2, implementationRecord] },
    { intent: "HISTORICAL_STATE", candidates: [chunkV1], asOf: Date.parse("2026-01-20T00:00:00.000Z") },
    { intent: "DIFF_EVOLUTION", candidates: [chunkV1, chunkV2] },
    { intent: "CURRENT_STATE", candidates: [chunkV2, conflictingApprovedRecord] },
  ];

  let totalScenarios = scenarios.length;
  let passedIntegrity = 0;
  let totalLeakage = 0;
  let totalDuplicates = 0;
  let totalProvScore = 0;

  for (const s of scenarios) {
    const res = resolveEvidence(s.candidates, { intent: s.intent, asOf: s.asOf });
    const assembled = assembleTemporalContext({ resolution: res, intent: s.intent, asOf: s.asOf });

    totalLeakage += assembled.metrics.superseded_leakage_rate || 0;
    totalDuplicates += assembled.metrics.duplicate_evidence_rate || 0;
    totalProvScore += assembled.metrics.provenance_completeness || 1.0;

    if (assembled.evaluation.status !== EVALUATION_STATUS.FAIL || res.status === RESOLUTION_STATES.CONFLICT_UNRESOLVED) {
      passedIntegrity++;
    }
  }

  const avgLeakage = totalLeakage / totalScenarios;
  const avgDuplicates = totalDuplicates / totalScenarios;
  const avgProvenance = totalProvScore / totalScenarios;

  assert.equal(avgLeakage, 0.0, "Superseded evidence leakage rate must be 0.0");
  assert.equal(avgDuplicates, 0.0, "Duplicate evidence rate must be 0.0");
  assert.ok(avgProvenance >= 0.95, "Provenance completeness must be >= 0.95");
  assert.equal(passedIntegrity, totalScenarios, "All benchmark scenarios handled safely");
});

// ---------------------------------------------------------------------------
// TEST 10: Backward Compatibility
// ---------------------------------------------------------------------------
test("TEST 10: Backward compatibility with legacy plain-string passages and buildAnswerMessages", () => {
  const legacyPassages = "Passages from the project files:\n- FileA.md: Pricing is $20/month.";
  const [sys, user] = buildAnswerMessages({
    focus: "What is our pricing?",
    passages: legacyPassages,
    proactive: false,
  });

  assert.equal(sys.role, "system");
  assert.match(user.content, /Pricing is \$20\/month/);
  assert.match(user.content, /The USER asks:\nWhat is our pricing\?/);

  // Direct formatEvidenceForContext call backward compatibility
  const legacyResolution = resolveEvidence([chunkV2], { intent: "CURRENT_STATE" });
  const formatted = formatEvidenceForContext(legacyResolution);
  assert.match(formatted, /\[AUTHORITATIVE EVIDENCE: CANONICAL SPECIFICATION\]/);
  assert.match(formatted, /Version: 2\.0\.0/);
});
