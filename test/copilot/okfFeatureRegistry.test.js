// test/copilot/okfFeatureRegistry.test.js
// Automated test suite for Phase 1: Canonical Feature Registry & Deterministic Feature Lookup

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { createOkfRegistry } = require("../../src/copilot/core/okf/registry");
const { createFeatureRegistry, normalizeTitle, normalizeKeyword } = require("../../src/copilot/core/okf/featureRegistry");
const { validateFeatureRegistry } = require("../../src/copilot/core/okf/featureRegistryValidator");
const { createAuthoritativeLookupService } = require("../../src/copilot/core/okf/lookup");
const { createOkfRouter } = require("../../src/copilot/core/okf/router");

const okfDir = path.resolve(__dirname, "../../OKF");

// ============================================================================
// 1. IDENTITY TESTS
// ============================================================================

test("F01: Exact feature ID lookup", () => {
  const reg = createOkfRegistry({ okfDir });
  const feat = reg.getFeatureById("feat:ingestion_pipeline");
  assert.ok(feat != null, "Feature must be found by ID");
  assert.equal(feat.feature_id, "feat:ingestion_pipeline");
  assert.equal(feat.canonical_name, "Data Ingestion Pipeline Architecture");
  assert.equal(feat.current_approved_version, "2.0.0");
  assert.equal(feat.approval_status, "approved");
  assert.equal(feat.lifecycle_status, "active");
});

test("F02: Canonical name lookup", () => {
  const reg = createOkfRegistry({ okfDir });
  const feat = reg.getFeatureByName("Data Ingestion Pipeline Architecture");
  assert.ok(feat != null, "Feature must be found by canonical name");
  assert.equal(feat.feature_id, "feat:ingestion_pipeline");
});

test("F03: Alias lookup", () => {
  const reg = createOkfRegistry({ okfDir });
  const feat = reg.getFeatureByAlias("streaming pipeline");
  assert.ok(feat != null, "Feature must be found by registered alias");
  assert.equal(feat.feature_id, "feat:ingestion_pipeline");
});

test("F04: Keyword lookup", () => {
  const reg = createOkfRegistry({ okfDir });
  const candidates = reg.findFeaturesByKeyword("streaming");
  assert.ok(candidates.length > 0, "Keyword lookup must return candidates");
  assert.ok(candidates.some((f) => f.feature_id === "feat:ingestion_pipeline"));
});

test("F05: Unknown feature lookup returns null / not found", () => {
  const reg = createOkfRegistry({ okfDir });
  assert.equal(reg.getFeatureById("feat:non_existent_feature"), null);
  assert.equal(reg.getFeatureByName("Non Existent Architecture"), null);
  assert.equal(reg.getFeatureByAlias("unknown alias"), null);
  assert.deepEqual(reg.findFeaturesByKeyword("unregisteredkeyword12345"), []);
});

// ============================================================================
// 2. DETERMINISM & NORMALIZATION TESTS
// ============================================================================

test("F06: Case-insensitive normalized matching", () => {
  const reg = createOkfRegistry({ okfDir });
  const featById = reg.getFeatureById("FEAT:INGESTION_PIPELINE");
  assert.ok(featById != null);
  assert.equal(featById.feature_id, "feat:ingestion_pipeline");

  const featByName = reg.getFeatureByName("  data ingestion pipeline architecture  ");
  assert.ok(featByName != null);
  assert.equal(featByName.feature_id, "feat:ingestion_pipeline");

  const featByAlias = reg.getFeatureByAlias("STREAMING PIPELINE");
  assert.ok(featByAlias != null);
  assert.equal(featByAlias.feature_id, "feat:ingestion_pipeline");
});

test("F07: Whitespace and punctuation normalization", () => {
  const reg = createOkfRegistry({ okfDir });
  const feat = reg.getFeatureByName("  Data   Ingestion   Pipeline Architecture:--  ");
  assert.ok(feat != null);
  assert.equal(feat.feature_id, "feat:ingestion_pipeline");
});

test("F08: Duplicate alias ambiguity handling", () => {
  const mockRegistryData = {
    schema_version: "1.0.0",
    bundle_id: "test-bundle",
    features: [
      {
        feature_id: "feat:ingestion_pipeline",
        canonical_name: "Ingestion Pipeline",
        domain: "core",
        aliases: ["pipeline"],
        keywords: ["ingestion"],
        approval_status: "approved",
        lifecycle_status: "active",
        sources: [{ document_id: "doc1", document_name: "doc1.md" }],
      },
      {
        feature_id: "feat:analytics_pipeline",
        canonical_name: "Analytics Pipeline",
        domain: "core",
        aliases: ["pipeline"],
        keywords: ["analytics"],
        approval_status: "approved",
        lifecycle_status: "active",
        sources: [{ document_id: "doc2", document_name: "doc2.md" }],
      },
    ],
  };

  const featReg = createFeatureRegistry({
    fs: {
      existsSync: () => true,
      readFileSync: () => JSON.stringify(mockRegistryData),
    },
    yaml: { load: (c) => JSON.parse(c) },
  });

  const res = featReg.getFeatureByAlias("pipeline");
  assert.equal(res.matched, false);
  assert.equal(res.ambiguous, true);
  assert.equal(res.resolution, "requires_disambiguation");
  assert.deepEqual(res.candidates.sort(), ["feat:analytics_pipeline", "feat:ingestion_pipeline"]);
});

test("F09: Multiple candidate ambiguity in resolveFeature()", () => {
  const mockRegistryData = {
    schema_version: "1.0.0",
    bundle_id: "test-bundle",
    features: [
      {
        feature_id: "feat:ingestion_pipeline",
        canonical_name: "Ingestion Pipeline",
        domain: "core",
        aliases: ["shared-alias"],
        keywords: ["shared-keyword"],
        approval_status: "approved",
        lifecycle_status: "active",
        sources: [{ document_id: "doc1", document_name: "doc1.md" }],
      },
      {
        feature_id: "feat:analytics_pipeline",
        canonical_name: "Analytics Pipeline",
        domain: "core",
        aliases: ["shared-alias"],
        keywords: ["shared-keyword"],
        approval_status: "approved",
        lifecycle_status: "active",
        sources: [{ document_id: "doc2", document_name: "doc2.md" }],
      },
    ],
  };

  const featReg = createFeatureRegistry({
    fs: {
      existsSync: () => true,
      readFileSync: () => JSON.stringify(mockRegistryData),
    },
    yaml: { load: (c) => JSON.parse(c) },
  });

  const aliasRes = featReg.resolveFeature("shared-alias");
  assert.equal(aliasRes.matched, false);
  assert.equal(aliasRes.ambiguous, true);
  assert.equal(aliasRes.resolution, "requires_disambiguation");
  assert.deepEqual(aliasRes.candidates.sort(), ["feat:analytics_pipeline", "feat:ingestion_pipeline"]);

  const kwRes = featReg.resolveFeature("shared-keyword");
  assert.equal(kwRes.matched, false);
  assert.equal(kwRes.ambiguous, true);
  assert.equal(kwRes.resolution, "requires_disambiguation");
  assert.deepEqual(kwRes.candidates.sort(), ["feat:analytics_pipeline", "feat:ingestion_pipeline"]);
});

test("F10: Exact match precedence over semantic fallback", () => {
  const reg = createOkfRegistry({ okfDir });
  const featReg = reg.featureRegistry;

  // Exact ID takes absolute top precedence
  const idRes = featReg.resolveFeature("feat:ingestion_pipeline");
  assert.equal(idRes.matched, true);
  assert.equal(idRes.matchTier, "exact_feature_id");
  assert.equal(idRes.feature.feature_id, "feat:ingestion_pipeline");

  // Name match
  const nameRes = featReg.resolveFeature("Data Ingestion Pipeline Architecture");
  assert.equal(nameRes.matched, true);
  assert.equal(nameRes.matchTier, "canonical_name");

  // Alias match
  const aliasRes = featReg.resolveFeature("streaming pipeline");
  assert.equal(aliasRes.matched, true);
  assert.equal(aliasRes.matchTier, "alias");

  // Semantic fallback when no exact match exists
  const fallbackRes = featReg.resolveFeature("how does our system do complex machine learning inference?");
  assert.equal(fallbackRes.matched, false);
  assert.equal(fallbackRes.ambiguous, false);
  assert.ok(fallbackRes.reason.includes("fallback to semantic retrieval"));
});

// ============================================================================
// 3. AUTHORITY & APPROVAL GOVERNANCE TESTS
// ============================================================================

test("F11: Approved version selection and provenance", () => {
  const reg = createOkfRegistry({ okfDir });
  const appVer = reg.getCurrentApprovedVersion("feat:ingestion_pipeline");
  assert.equal(appVer.status, "resolved");
  assert.equal(appVer.version, "2.0.0");
  assert.equal(appVer.approval_status, "approved");
  assert.equal(appVer.lifecycle_status, "active");
  assert.ok(Array.isArray(appVer.sources) && appVer.sources.length > 0);
  assert.equal(appVer.sources[0].document_id, "client_requirements_v2");
  assert.equal(appVer.sources[0].section_id, "section_2");
});

test("F12: Draft, pending, and rejected versions exclusion from authority", () => {
  const mockRegistryData = {
    schema_version: "1.0.0",
    bundle_id: "test-bundle",
    features: [
      {
        feature_id: "feat:draft_feature",
        canonical_name: "Draft Feature",
        domain: "core",
        aliases: ["draft"],
        keywords: ["draft"],
        current_approved_version: null,
        approval_status: "draft",
        lifecycle_status: "active",
        versions: [
          {
            version: "0.1.0",
            approval_status: "draft",
            lifecycle_status: "active",
            sources: [{ document_id: "doc1", document_name: "doc1.md" }],
          },
        ],
      },
      {
        feature_id: "feat:pending_feature",
        canonical_name: "Pending Feature",
        domain: "core",
        aliases: ["pending"],
        keywords: ["pending"],
        current_approved_version: null,
        approval_status: "pending",
        lifecycle_status: "active",
        versions: [
          {
            version: "0.2.0",
            approval_status: "pending",
            lifecycle_status: "active",
            sources: [{ document_id: "doc2", document_name: "doc2.md" }],
          },
        ],
      },
      {
        feature_id: "feat:rejected_feature",
        canonical_name: "Rejected Feature",
        domain: "core",
        aliases: ["rejected"],
        keywords: ["rejected"],
        current_approved_version: null,
        approval_status: "rejected",
        lifecycle_status: "active",
        versions: [
          {
            version: "0.3.0",
            approval_status: "rejected",
            lifecycle_status: "active",
            sources: [{ document_id: "doc3", document_name: "doc3.md" }],
          },
        ],
      },
    ],
  };

  const featReg = createFeatureRegistry({
    fs: {
      existsSync: () => true,
      readFileSync: () => JSON.stringify(mockRegistryData),
    },
    yaml: { load: (c) => JSON.parse(c) },
  });

  const draftRes = featReg.getCurrentApprovedVersion("feat:draft_feature");
  assert.equal(draftRes.status, "no_authoritative_version");

  const pendingRes = featReg.getCurrentApprovedVersion("feat:pending_feature");
  assert.equal(pendingRes.status, "no_authoritative_version");

  const rejectedRes = featReg.getCurrentApprovedVersion("feat:rejected_feature");
  assert.equal(rejectedRes.status, "no_authoritative_version");
});

test("F13: Deprecated feature exclusion", () => {
  const mockRegistryData = {
    schema_version: "1.0.0",
    bundle_id: "test-bundle",
    features: [
      {
        feature_id: "feat:old_protocol",
        canonical_name: "Old Protocol",
        domain: "core",
        aliases: ["old protocol"],
        keywords: ["legacy"],
        current_approved_version: "1.0.0",
        approval_status: "approved",
        lifecycle_status: "deprecated",
        versions: [
          {
            version: "1.0.0",
            approval_status: "approved",
            lifecycle_status: "deprecated",
            sources: [{ document_id: "doc1", document_name: "doc1.md" }],
          },
        ],
      },
    ],
  };

  const featReg = createFeatureRegistry({
    fs: {
      existsSync: () => true,
      readFileSync: () => JSON.stringify(mockRegistryData),
    },
    yaml: { load: (c) => JSON.parse(c) },
  });

  const appVer = featReg.getCurrentApprovedVersion("feat:old_protocol");
  assert.equal(appVer.status, "deprecated");
  assert.equal(appVer.resolvedVersion, null);
  assert.ok(appVer.reason.includes("is deprecated"));
});

// ============================================================================
// 4. LINEAGE & SUPERSESSION VALIDATION TESTS
// ============================================================================

test("F14: Valid multi-version supersession lineage", () => {
  const reg = createOkfRegistry({ okfDir });
  const lineage = reg.getFeatureLineage("feat:ingestion_pipeline");
  assert.equal(lineage.status, "resolved");
  assert.equal(lineage.feature_id, "feat:ingestion_pipeline");
  assert.equal(lineage.versions.length, 2);

  const v1 = lineage.versions.find((v) => v.version === "1.0.0");
  const v2 = lineage.versions.find((v) => v.version === "2.0.0");

  assert.equal(v1.lifecycle_status, "superseded");
  assert.deepEqual(v1.supersession.superseded_by, ["2.0.0"]);

  assert.equal(v2.lifecycle_status, "active");
  assert.deepEqual(v2.supersession.supersedes, ["1.0.0"]);
});

test("F15: Circular supersession detection", () => {
  const corruptedData = {
    schema_version: "1.0.0",
    bundle_id: "test-bundle",
    features: [
      {
        feature_id: "feat:circular_feature",
        canonical_name: "Circular Feature",
        domain: "core",
        aliases: ["circular"],
        keywords: ["circular"],
        current_approved_version: "2.0.0",
        approval_status: "approved",
        lifecycle_status: "active",
        versions: [
          {
            version: "1.0.0",
            approval_status: "approved",
            lifecycle_status: "superseded",
            sources: [{ document_id: "doc1", document_name: "doc1.md" }],
            supersession: { supersedes: ["2.0.0"], superseded_by: ["2.0.0"] },
          },
          {
            version: "2.0.0",
            approval_status: "approved",
            lifecycle_status: "active",
            sources: [{ document_id: "doc2", document_name: "doc2.md" }],
            supersession: { supersedes: ["1.0.0"], superseded_by: ["1.0.0"] },
          },
        ],
      },
    ],
  };

  const val = validateFeatureRegistry(corruptedData);
  assert.equal(val.valid, false);
  assert.ok(val.errors.some((e) => e.includes("Circular supersession detected")));
});

test("F16: Multiple active approved versions rejection", () => {
  const corruptedData = {
    schema_version: "1.0.0",
    bundle_id: "test-bundle",
    features: [
      {
        feature_id: "feat:multi_active",
        canonical_name: "Multi Active Feature",
        domain: "core",
        aliases: ["multi"],
        keywords: ["multi"],
        current_approved_version: "2.0.0",
        approval_status: "approved",
        lifecycle_status: "active",
        versions: [
          {
            version: "1.0.0",
            approval_status: "approved",
            lifecycle_status: "active", // First active approved
            sources: [{ document_id: "doc1", document_name: "doc1.md" }],
          },
          {
            version: "2.0.0",
            approval_status: "approved",
            lifecycle_status: "active", // Second active approved -> ERROR
            sources: [{ document_id: "doc2", document_name: "doc2.md" }],
          },
        ],
      },
    ],
  };

  const val = validateFeatureRegistry(corruptedData);
  assert.equal(val.valid, false);
  assert.ok(val.errors.some((e) => e.includes("Multiple active approved versions detected")));
});

test("F17: Missing predecessor and successor references", () => {
  const corruptedData = {
    schema_version: "1.0.0",
    bundle_id: "test-bundle",
    features: [
      {
        feature_id: "feat:broken_links",
        canonical_name: "Broken Links Feature",
        domain: "core",
        aliases: ["broken"],
        keywords: ["broken"],
        current_approved_version: "1.0.0",
        approval_status: "approved",
        lifecycle_status: "active",
        versions: [
          {
            version: "1.0.0",
            approval_status: "approved",
            lifecycle_status: "active",
            sources: [{ document_id: "doc1", document_name: "doc1.md" }],
            supersession: { supersedes: ["0.9.0"], superseded_by: ["9.9.9"] },
          },
        ],
      },
    ],
  };

  const val = validateFeatureRegistry(corruptedData);
  assert.equal(val.valid, false);
  assert.ok(val.errors.some((e) => e.includes("references non-existent successor '9.9.9'")));
  assert.ok(val.errors.some((e) => e.includes("references non-existent predecessor '0.9.0'")));
});

// ============================================================================
// 5. BACKWARD COMPATIBILITY & INTEGRATION TESTS
// ============================================================================

test("F18: Authoritative Lookup Service (ALS) feature resolution", () => {
  const reg = createOkfRegistry({ okfDir });
  const als = reg.als;

  // Direct feature lookup on ALS
  const feat = als.getFeatureById("feat:ingestion_pipeline");
  assert.ok(feat != null);
  assert.equal(feat.feature_id, "feat:ingestion_pipeline");

  // Resolve with type: "feature"
  const res = als.resolve({ type: "feature", value: "feat:ingestion_pipeline" });
  assert.equal(res.status, "resolved");
  assert.equal(res.matched, true);
  assert.equal(res.feature.feature_id, "feat:ingestion_pipeline");
  assert.equal(res.provenance.feature_id, "feat:ingestion_pipeline");
  assert.equal(res.provenance.version, "2.0.0");
});

test("F19: Router recognizes feature identity and routes to okf", async () => {
  const reg = createOkfRegistry({ okfDir });
  const router = createOkfRouter();

  const ctx = await router.routeContext({
    query: "What is the specification for feat:ingestion_pipeline in our architecture?",
    registry: reg,
    ragResult: null,
  });

  assert.equal(ctx.route, "okf");
  assert.ok(ctx.provenance != null);
  assert.equal(ctx.provenance.feature_id, "feat:ingestion_pipeline");
  assert.equal(ctx.provenance.version, "2.0.0");
  assert.ok(ctx.passages.includes("Data Ingestion Pipeline Architecture"));
});

test("F20: Router routes exploratory feature questions to mixed", async () => {
  const reg = createOkfRegistry({ okfDir });
  const router = createOkfRouter();

  const ctx = await router.routeContext({
    query: "What did we discuss in the meeting notes about feat:ingestion_pipeline?",
    registry: reg,
    ragResult: { text: "Meeting discussion notes", used: [{ file: "meeting.docx" }] },
  });

  assert.equal(ctx.route, "mixed");
  assert.ok(ctx.provenance != null);
  assert.equal(ctx.provenance.feature_id, "feat:ingestion_pipeline");
  assert.ok(ctx.passages.includes("=== AUTHORITATIVE CANONICAL BASELINE"));
  assert.ok(ctx.passages.includes("=== SUPPORTING PROJECT EXPLORATION"));
});

test("F21: Determinism across 100 repeated runs", () => {
  const reg = createOkfRegistry({ okfDir });
  const first = reg.resolveFeature("feat:ingestion_pipeline");

  for (let i = 0; i < 100; i++) {
    const next = reg.resolveFeature("feat:ingestion_pipeline");
    assert.equal(next.matched, first.matched);
    assert.equal(next.feature.feature_id, first.feature.feature_id);
    assert.equal(next.currentApproved.version, first.currentApproved.version);
  }
});
