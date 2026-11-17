// test/copilot/authoritativeLookup.test.js
// Automated test suite for Phase 4: Authoritative Lookup Service (ALS).
// Verifies scenarios A through Q: matching precedence, version resolution,
// approval filtering, source precedence, conflict surfacing, and vector integration.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const path = require("path");

const { createRagStore } = require("../../src/copilot/rag/ragStore");
const { createFeatureRegistry } = require("../../src/copilot/core/okf/featureRegistry");
const { createAuthoritativeLookup, SOURCE_PRECEDENCE_TIERS } = require("../../src/copilot/rag/authoritativeLookup");
const { createRetriever } = require("../../src/copilot/rag/retrieve");

function setupTestEnvironment({ mockRegistryData = null } = {}) {
  const db = new Database(":memory:");
  const ragStore = createRagStore(db);
  const temporalStore = ragStore.temporal;

  let featureRegistry;
  if (mockRegistryData) {
    const yaml = { load: () => mockRegistryData };
    const fs = {
      existsSync: () => true,
      readFileSync: () => "mock-yaml",
    };
    featureRegistry = createFeatureRegistry({ yaml, fs, registryPath: "/mock/reg.yaml" });
  } else {
    const okfDir = path.resolve(__dirname, "../../OKF");
    featureRegistry = createFeatureRegistry({ okfDir });
  }
  featureRegistry.load();

  const als = createAuthoritativeLookup({
    db,
    ragStore,
    temporalStore,
    featureRegistry,
  });

  return { db, ragStore, temporalStore, featureRegistry, als };
}

describe("Phase 4: Authoritative Lookup Service (ALS)", () => {
  // -------------------------------------------------------------------------
  // Scenario A: EXACT FEATURE ID
  // -------------------------------------------------------------------------
  test("Scenario A: Exact feature ID lookup resolves canonical facts without vector search", async () => {
    const { temporalStore, als } = setupTestEnvironment();

    // Insert canonical active chunk
    temporalStore.insertTemporalChunk({
      file_id: 1,
      project_id: "proj_a",
      feature_id: "feat:ingestion_pipeline",
      version: "2.0.0",
      lifecycle_status: "active",
      text: "The data ingestion pipeline architecture processes up to 2,000 req/sec over 4 streaming channels.",
      meta: { source: "Client_Requirements_v2.pdf", section_id: "sec_2" },
      valid_from: 1000,
    });

    // Lookup by exact feature ID in query
    const res = await als.lookup({
      projectId: "proj_a",
      query: "What is the architecture of feat:ingestion_pipeline?",
    });

    assert.equal(res.status, "RESOLVED");
    assert.equal(res.match.matched_by, "exact_feature_id");
    assert.equal(res.match.confidence, 1.0);
    assert.equal(res.feature.feature_id, "feat:ingestion_pipeline");
    assert.equal(res.version.version, "2.0.0");
    assert.equal(res.authority.status, "AUTHORITATIVE");
    assert.equal(res.facts.length, 1);
    assert.match(res.facts[0].text, /2,000 req\/sec/);
  });

  // -------------------------------------------------------------------------
  // Scenario B: EXACT CANONICAL TITLE
  // -------------------------------------------------------------------------
  test("Scenario B: Exact canonical title lookup matches deterministically", async () => {
    const { temporalStore, als } = setupTestEnvironment();

    temporalStore.insertTemporalChunk({
      file_id: 2,
      project_id: "proj_b",
      feature_id: "feat:ingestion_pipeline",
      version: "2.0.0",
      lifecycle_status: "active",
      text: "Data ingestion pipeline architecture specification v2.",
      meta: { source: "OKF-0002-copilot-architecture.md" },
    });

    const res = await als.lookup({
      projectId: "proj_b",
      query: "Data Ingestion Pipeline Architecture",
    });

    assert.equal(res.status, "RESOLVED");
    assert.equal(res.match.matched_by, "canonical_name");
    assert.equal(res.feature.feature_id, "feat:ingestion_pipeline");
    assert.equal(res.facts.length, 1);
  });

  // -------------------------------------------------------------------------
  // Scenario C: EXACT ALIAS
  // -------------------------------------------------------------------------
  test("Scenario C: Exact registered alias resolves to canonical feature", async () => {
    const { temporalStore, als } = setupTestEnvironment();

    temporalStore.insertTemporalChunk({
      file_id: 3,
      project_id: "proj_c",
      feature_id: "feat:ingestion_pipeline",
      version: "2.0.0",
      lifecycle_status: "active",
      text: "Streaming pipeline requirement text.",
      meta: { source: "requirements.md" },
    });

    // 'streaming pipeline' is a registered alias for feat:ingestion_pipeline in feature_registry.yaml
    const res = await als.lookup({
      projectId: "proj_c",
      query: "streaming pipeline",
    });

    assert.equal(res.status, "RESOLVED");
    assert.equal(res.match.matched_by, "alias");
    assert.equal(res.feature.feature_id, "feat:ingestion_pipeline");
  });

  // -------------------------------------------------------------------------
  // Scenario D: EXACT KEYWORD
  // -------------------------------------------------------------------------
  test("Scenario D: Registered keyword lookup resolves single canonical feature", async () => {
    const { temporalStore, als } = setupTestEnvironment();

    temporalStore.insertTemporalChunk({
      file_id: 4,
      project_id: "proj_d",
      feature_id: "feat:copilot_orchestration",
      version: "1.0.0",
      lifecycle_status: "active",
      text: "Meeting copilot orchestration loop dispatching decider.",
      meta: { source: "OKF-0002-copilot-architecture.md" },
    });

    // 'decider' is a keyword uniquely registered for feat:copilot_orchestration
    const res = await als.lookup({
      projectId: "proj_d",
      query: "decider",
    });

    assert.equal(res.status, "RESOLVED");
    assert.equal(res.match.matched_by, "keyword");
    assert.equal(res.feature.feature_id, "feat:copilot_orchestration");
  });

  // -------------------------------------------------------------------------
  // Scenario E: AMBIGUOUS KEYWORD
  // -------------------------------------------------------------------------
  test("Scenario E: Ambiguous keyword across multiple features returns AMBIGUOUS without guessing", async () => {
    const mockData = {
      schema_version: "1.0.0",
      bundle_id: "test_bundle",
      features: [
        {
          feature_id: "feat:auth_oidc",
          canonical_name: "OIDC Authentication",
          domain: "security",
          aliases: [],
          keywords: ["security"],
          current_approved_version: "1.0.0",
          approval_status: "approved",
          lifecycle_status: "active",
          sources: [{ document_id: "doc1", document_name: "doc1.md" }],
        },
        {
          feature_id: "feat:auth_rbac",
          canonical_name: "Role Based Access Control",
          domain: "security",
          aliases: [],
          keywords: ["security"],
          current_approved_version: "1.0.0",
          approval_status: "approved",
          lifecycle_status: "active",
          sources: [{ document_id: "doc2", document_name: "doc2.md" }],
        },
      ],
    };

    const { als } = setupTestEnvironment({ mockRegistryData: mockData });

    const res = await als.lookup({
      projectId: "proj_e",
      query: "security",
    });

    assert.equal(res.status, "AMBIGUOUS");
    assert.equal(res.candidates.length, 2);
    assert.ok(res.candidates.includes("feat:auth_oidc"));
    assert.ok(res.candidates.includes("feat:auth_rbac"));
  });

  // -------------------------------------------------------------------------
  // Scenario F: CURRENT VERSION
  // -------------------------------------------------------------------------
  test("Scenario F: Current version returns active approved version and excludes superseded versions", async () => {
    const { temporalStore, als } = setupTestEnvironment();

    // Insert superseded v1.0.0
    temporalStore.insertTemporalChunk({
      file_id: 6,
      project_id: "proj_f",
      feature_id: "feat:ingestion_pipeline",
      version: "1.0.0",
      lifecycle_status: "superseded",
      text: "Ingestion v1: 50 req/sec single synchronous pipeline.",
      valid_from: 1000,
      valid_to: 2000,
    });

    // Insert active v2.0.0
    temporalStore.insertTemporalChunk({
      file_id: 7,
      project_id: "proj_f",
      feature_id: "feat:ingestion_pipeline",
      version: "2.0.0",
      lifecycle_status: "active",
      text: "Ingestion v2: 2,000 req/sec distributed streaming pipeline.",
      valid_from: 2000,
      valid_to: null,
    });

    const res = await als.lookup({
      projectId: "proj_f",
      featureId: "feat:ingestion_pipeline",
    });

    assert.equal(res.status, "RESOLVED");
    assert.equal(res.version.version, "2.0.0");
    assert.equal(res.version.lifecycle_status, "active");
    assert.equal(res.authority.status, "AUTHORITATIVE");
    assert.equal(res.facts.length, 1);
    assert.match(res.facts[0].text, /Ingestion v2/);
  });

  // -------------------------------------------------------------------------
  // Scenario G: HISTORICAL VERSION
  // -------------------------------------------------------------------------
  test("Scenario G: Explicit version request resolves superseded historical version", async () => {
    const { temporalStore, als } = setupTestEnvironment();

    temporalStore.insertTemporalChunk({
      file_id: 8,
      project_id: "proj_g",
      feature_id: "feat:ingestion_pipeline",
      version: "1.0.0",
      lifecycle_status: "superseded",
      text: "Ingestion v1: 50 req/sec single synchronous pipeline.",
      valid_from: 1000,
      valid_to: 2000,
    });

    temporalStore.insertTemporalChunk({
      file_id: 9,
      project_id: "proj_g",
      feature_id: "feat:ingestion_pipeline",
      version: "2.0.0",
      lifecycle_status: "active",
      text: "Ingestion v2: 2,000 req/sec distributed streaming pipeline.",
      valid_from: 2000,
    });

    const res = await als.lookup({
      projectId: "proj_g",
      query: "What was the specification in version 1.0.0 of feat:ingestion_pipeline?",
    });

    assert.equal(res.status, "RESOLVED");
    assert.equal(res.version.version, "1.0.0");
    assert.equal(res.authority.status, "HISTORICAL");
    assert.equal(res.facts.length, 1);
    assert.match(res.facts[0].text, /Ingestion v1/);
  });

  // -------------------------------------------------------------------------
  // Scenario H: POINT-IN-TIME LOOKUP
  // -------------------------------------------------------------------------
  test("Scenario H: Point-in-time lookup resolves effective version asOf timestamp", async () => {
    const { temporalStore, als } = setupTestEnvironment();

    // v1 valid 1000 -> 2000
    temporalStore.insertTemporalChunk({
      file_id: 10,
      project_id: "proj_h",
      feature_id: "feat:ingestion_pipeline",
      version: "1.0.0",
      lifecycle_status: "superseded",
      text: "Historical v1 pipeline text.",
      valid_from: 1000,
      valid_to: 2000,
    });

    // v2 valid 2000 -> null
    temporalStore.insertTemporalChunk({
      file_id: 11,
      project_id: "proj_h",
      feature_id: "feat:ingestion_pipeline",
      version: "2.0.0",
      lifecycle_status: "active",
      text: "Current v2 pipeline text.",
      valid_from: 2000,
    });

    // Lookup asOf 1500 (inside v1 validity interval)
    const res = await als.lookup({
      projectId: "proj_h",
      featureId: "feat:ingestion_pipeline",
      asOf: 1500,
    });

    assert.equal(res.status, "RESOLVED");
    assert.equal(res.version.version, "1.0.0");
    assert.equal(res.authority.status, "HISTORICAL");
    assert.equal(res.facts[0].text, "Historical v1 pipeline text.");
  });

  // -------------------------------------------------------------------------
  // Scenario I: DRAFT FILTERING
  // -------------------------------------------------------------------------
  test("Scenario I: Draft content is excluded by default and labeled NON_AUTHORITATIVE when requested", async () => {
    const { temporalStore, als } = setupTestEnvironment();

    temporalStore.insertTemporalChunk({
      file_id: 12,
      project_id: "proj_i",
      feature_id: "feat:ingestion_pipeline",
      version: "1.0.0",
      lifecycle_status: "active",
      text: "Approved active baseline.",
    });

    temporalStore.insertTemporalChunk({
      file_id: 13,
      project_id: "proj_i",
      feature_id: "feat:ingestion_pipeline",
      version: "3.0.0",
      lifecycle_status: "draft",
      text: "Draft v3 experimental architecture proposal.",
    });

    // Default lookup excludes draft
    const resDefault = await als.lookup({
      projectId: "proj_i",
      featureId: "feat:ingestion_pipeline",
    });
    assert.equal(resDefault.version.version, "1.0.0");
    assert.equal(resDefault.authority.status, "AUTHORITATIVE");

    // Explicit includeDrafts lookup
    const resDraft = await als.lookup({
      projectId: "proj_i",
      featureId: "feat:ingestion_pipeline",
      includeDrafts: true,
      bypassCache: true,
    });
    assert.equal(resDraft.version.version, "3.0.0");
    assert.equal(resDraft.authority.status, "NON_AUTHORITATIVE");
    assert.equal(resDraft.version.approval_status, "draft");
  });

  // -------------------------------------------------------------------------
  // Scenario J: REJECTED CONTENT
  // -------------------------------------------------------------------------
  test("Scenario J: Rejected content never appears as authoritative", async () => {
    const { db, temporalStore, als } = setupTestEnvironment();

    // Insert a rejected chunk
    db.prepare(`
      INSERT INTO copilot_chunks (file_id, project_id, ord, text, meta, embed, hash, dims, vec, feature_id, version, lifecycle_status)
      VALUES (14, 'proj_j', 0, 'Rejected pipeline proposal.', '{}', 'text', 'hash_rej', 4, ?, 'feat:ingestion_pipeline', '2.5.0', 'rejected')
    `).run(Buffer.alloc(16));

    const res = await als.lookup({
      projectId: "proj_j",
      featureId: "feat:ingestion_pipeline",
      version: "2.5.0",
    });

    assert.notEqual(res.authority.status, "AUTHORITATIVE");
  });

  // -------------------------------------------------------------------------
  // Scenario K: DEPRECATED CONTENT
  // -------------------------------------------------------------------------
  test("Scenario K: Deprecated content is excluded from current results and retrieved only when requested", async () => {
    const { temporalStore, als } = setupTestEnvironment();

    temporalStore.insertTemporalChunk({
      file_id: 15,
      project_id: "proj_k",
      feature_id: "feat:ingestion_pipeline",
      version: "1.0.0",
      lifecycle_status: "deprecated",
      text: "Retired legacy ingestion pipeline.",
    });

    // Default lookup
    const resDefault = await als.lookup({
      projectId: "proj_k",
      featureId: "feat:ingestion_pipeline",
    });
    assert.equal(resDefault.authority.status, "DEPRECATED");
    assert.equal(resDefault.facts.length, 0);

    // Explicit includeDeprecated lookup
    const resDeprecated = await als.lookup({
      projectId: "proj_k",
      featureId: "feat:ingestion_pipeline",
      includeDeprecated: true,
      bypassCache: true,
    });
    assert.equal(resDeprecated.authority.status, "DEPRECATED");
    assert.equal(resDeprecated.facts.length, 1);
    assert.match(resDeprecated.facts[0].text, /Retired legacy/);
  });

  // -------------------------------------------------------------------------
  // Scenario L: SOURCE PRECEDENCE
  // -------------------------------------------------------------------------
  test("Scenario L: Canonical OKF source ranks over lower-authority documents", async () => {
    const { temporalStore, als } = setupTestEnvironment();

    // Generic supporting document chunk
    temporalStore.insertTemporalChunk({
      file_id: 16,
      project_id: "proj_l",
      feature_id: "feat:ingestion_pipeline",
      version: "2.0.0",
      lifecycle_status: "active",
      text: "Supporting documentation note on ingestion.",
      meta: { source: "General_Notes.docx" },
      hash: "hash_gen",
    });

    // Canonical OKF source chunk
    temporalStore.insertTemporalChunk({
      file_id: 17,
      project_id: "proj_l",
      feature_id: "feat:ingestion_pipeline",
      version: "2.0.0",
      lifecycle_status: "active",
      text: "Canonical OKF pipeline specification text.",
      meta: { source: "OKF-0002-copilot-architecture.md", source_type: "canonical_okf" },
      hash: "hash_okf",
    });

    const res = await als.lookup({
      projectId: "proj_l",
      featureId: "feat:ingestion_pipeline",
    });

    assert.equal(res.status, "RESOLVED");
    assert.equal(res.facts[0].source_name, "OKF-0002-copilot-architecture.md");
    assert.equal(res.facts[0].authority_tier, SOURCE_PRECEDENCE_TIERS.CANONICAL_OKF.name);
    assert.equal(res.facts[0].authority_score, 100);
  });

  // -------------------------------------------------------------------------
  // Scenario M: CONFLICTING APPROVED SOURCES
  // -------------------------------------------------------------------------
  test("Scenario M: Conflicting approved sources at equal authority tier are surfaced in conflicts", async () => {
    const { temporalStore, als } = setupTestEnvironment();

    // Source A (Authoritative PRD 1)
    temporalStore.insertTemporalChunk({
      file_id: 18,
      project_id: "proj_m",
      feature_id: "feat:ingestion_pipeline",
      version: "2.0.0",
      lifecycle_status: "active",
      text: "Throughput requirement is 2,000 req/sec.",
      meta: { source: "Client_Requirements_v2_A.docx", source_type: "authoritative_requirement" },
      hash: "hash_prd_a",
    });

    // Source B (Authoritative PRD 2 with conflicting limit)
    temporalStore.insertTemporalChunk({
      file_id: 19,
      project_id: "proj_m",
      feature_id: "feat:ingestion_pipeline",
      version: "2.0.0",
      lifecycle_status: "active",
      text: "Throughput requirement is 5,000 req/sec.",
      meta: { source: "Client_Requirements_v2_B.docx", source_type: "authoritative_requirement" },
      hash: "hash_prd_b",
    });

    const res = await als.lookup({
      projectId: "proj_m",
      featureId: "feat:ingestion_pipeline",
    });

    assert.equal(res.status, "RESOLVED");
    assert.equal(res.conflicts.length, 1);
    assert.equal(res.conflicts[0].type, "CONFLICTING_APPROVED_SOURCES");
    assert.match(res.conflicts[0].message, /differing requirements/);
  });

  // -------------------------------------------------------------------------
  // Scenario N: EXACT MATCH VS VECTOR SIMILARITY
  // -------------------------------------------------------------------------
  test("Scenario N: ALS authoritative facts take precedence over semantically similar vector chunks in retrieve()", async () => {
    const { db, ragStore, temporalStore, als } = setupTestEnvironment();

    // 1. Insert an outdated legacy chunk with text similar to query
    db.prepare(`
      INSERT INTO copilot_project_files (id, project_id, path, name, status, chunk_count)
      VALUES (88, 1, '/docs/legacy.txt', 'legacy.txt', 'ready', 1)
    `).run();

    db.prepare(`
      INSERT INTO copilot_chunks (file_id, project_id, ord, text, meta, embed, hash, dims, vec, feature_id, lifecycle_status)
      VALUES (88, 1, 0, 'Outdated pipeline specification saying throughput is 50 req/sec.', '{}', 'text', 'h_old', 4, ?, NULL, 'active')
    `).run(Buffer.alloc(16));
    db.prepare(`INSERT INTO copilot_chunks_fts (rowid, text) VALUES (1, 'Outdated pipeline specification saying throughput is 50 req/sec.')`).run();

    // 2. Insert the canonical active requirement chunk via temporalStore
    temporalStore.insertTemporalChunk({
      file_id: 88,
      project_id: 1,
      feature_id: "feat:ingestion_pipeline",
      version: "2.0.0",
      lifecycle_status: "active",
      text: "Approved canonical specification: throughput is 2,000 req/sec across 4 streaming channels.",
      meta: { source: "Client_Requirements_v2.pdf", source_type: "authoritative_requirement" },
    });

    // 3. Create retriever with ALS injected
    const retriever = createRetriever({
      rag: ragStore,
      clients: () => null, // no model client needed for deterministic keyword/ALS test
      als,
    });

    const res = await retriever.retrieve({
      query: "What is the throughput of feat:ingestion_pipeline?",
      projectIds: [1],
    });

    assert.ok(res.authoritative, "Retriever must have authoritative facts from ALS");
    assert.equal(res.authoritative.feature.feature_id, "feat:ingestion_pipeline");
    assert.equal(res.used[0].authoritative, true, "First passage must be authoritative");
    assert.match(res.text, /CANONICAL AUTHORITATIVE/);
    assert.match(res.text, /2,000 req\/sec/);
  });

  // -------------------------------------------------------------------------
  // Scenario O: REGISTRY / DATABASE MISMATCH
  // -------------------------------------------------------------------------
  test("Scenario O: Missing temporal records for a registered feature returns INCONSISTENT status", async () => {
    const { als } = setupTestEnvironment();

    // Query feature registered in OKF but with 0 chunks in database for proj_o
    const res = await als.lookup({
      projectId: "proj_o",
      featureId: "feat:storage_isolation",
    });

    assert.equal(res.status, "RESOLVED");
    assert.equal(res.authority.status, "INCONSISTENT");
    assert.equal(res.facts.length, 0);
    assert.ok(res.warnings.length > 0);
  });

  // -------------------------------------------------------------------------
  // Scenario P: CACHE INVALIDATION
  // -------------------------------------------------------------------------
  test("Scenario P: Cache invalidation ensures fresh active facts after version updates", async () => {
    const { temporalStore, als } = setupTestEnvironment();

    temporalStore.insertTemporalChunk({
      file_id: 20,
      project_id: "proj_p",
      feature_id: "feat:ingestion_pipeline",
      version: "1.0.0",
      lifecycle_status: "active",
      text: "Version 1 facts.",
      valid_from: 1000,
    });

    const res1 = await als.lookup({
      projectId: "proj_p",
      featureId: "feat:ingestion_pipeline",
    });
    assert.equal(res1.version.version, "1.0.0");

    // Transition version to 2.0.0
    const chunkV1 = temporalStore.getActiveFeatureChunks("proj_p", "feat:ingestion_pipeline")[0];
    temporalStore.activateSuccessorVersion({
      predecessorId: chunkV1.id,
      newChunkData: {
        file_id: 21,
        project_id: "proj_p",
        feature_id: "feat:ingestion_pipeline",
        version: "2.0.0",
        text: "Version 2 facts.",
      },
      effectiveTime: 2000,
    });

    // Clear ALS cache to reflect DB update
    als.clearCache();

    const res2 = await als.lookup({
      projectId: "proj_p",
      featureId: "feat:ingestion_pipeline",
    });
    assert.equal(res2.version.version, "2.0.0");
    assert.equal(res2.facts[0].text, "Version 2 facts.");
  });

  // -------------------------------------------------------------------------
  // Scenario Q: BACKWARD COMPATIBILITY
  // -------------------------------------------------------------------------
  test("Scenario Q: Unresolved queries return NOT_FOUND allowing normal RAG retrieval to proceed", async () => {
    const { db, ragStore, als } = setupTestEnvironment();

    db.prepare(`
      INSERT INTO copilot_project_files (id, project_id, path, name, status, chunk_count)
      VALUES (99, 1, '/docs/general.txt', 'general.txt', 'ready', 1)
    `).run();

    db.prepare(`
      INSERT INTO copilot_chunks (file_id, project_id, ord, text, meta, embed, hash, dims, vec)
      VALUES (99, 1, 0, 'General team lunch meeting notes from Friday.', '{}', 'text', 'h_lunch', 4, ?)
    `).run(Buffer.alloc(16));
    db.prepare(`INSERT INTO copilot_chunks_fts (rowid, text) VALUES (1, 'General team lunch meeting notes from Friday.')`).run();

    // ALS lookup for general query returns NOT_FOUND
    const alsRes = await als.lookup({
      projectId: 1,
      query: "where did the team have lunch?",
    });
    assert.equal(alsRes.status, "NOT_FOUND");

    // Retriever proceeds normally
    const retriever = createRetriever({
      rag: ragStore,
      clients: () => null,
      als,
    });

    const res = await retriever.retrieve({
      query: "lunch meeting notes",
      projectIds: [1],
    });

    assert.equal(res.authoritative, null);
    assert.ok(res.text.includes("General team lunch"));
  });
});
