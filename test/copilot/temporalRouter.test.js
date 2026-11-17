// test/copilot/temporalRouter.test.js
// Automated test suite for Phase 5: Temporal OKF Router Gate.
// Verifies 25 tests across Groups A, B, C, D, and E:
// Group A: CURRENT_STATE (Tests 1-4)
// Group B: HISTORICAL_STATE (Tests 5-10)
// Group C: DIFF_EVOLUTION (Tests 11-16)
// Group D: Feature Identification (Tests 17-20)
// Group E: Regression & Integration (Tests 21-25)

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const path = require("path");

const { createRagStore } = require("../../src/copilot/rag/ragStore");
const { createFeatureRegistry } = require("../../src/copilot/core/okf/featureRegistry");
const { createAuthoritativeLookup } = require("../../src/copilot/rag/authoritativeLookup");
const {
  createTemporalRouter,
  classifyTemporalIntent,
  extractTemporalParameters,
} = require("../../src/copilot/core/okf/temporalRouter");
const { createOkfRouter } = require("../../src/copilot/core/okf/router");
const { createRetriever } = require("../../src/copilot/rag/retrieve");

function setupTestEnvironment({ mockNow = 1774051200000, mockRegistryData = null } = {}) {
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
    now: () => mockNow,
  });

  const temporalRouter = createTemporalRouter({
    featureRegistry,
    temporalStore,
    authoritativeLookup: als,
    now: () => mockNow,
  });

  return { db, ragStore, temporalStore, featureRegistry, als, temporalRouter, mockNow };
}

describe("Phase 5: Temporal OKF Router Gate", () => {
  // =========================================================================
  // Group A: CURRENT_STATE
  // =========================================================================
  describe("Group A: CURRENT_STATE", () => {
    test("Test 1: Default Intent: Query with no temporal markers classifies as CURRENT_STATE", () => {
      const classification = classifyTemporalIntent("What is the max latency for ingestion?");
      assert.equal(classification.intent, "CURRENT_STATE");
      assert.ok(classification.confidence >= 0.85);
      assert.ok(classification.reason.includes("default to CURRENT_STATE"));
    });

    test("Test 2: Active Chunk Retrieval: Returns active, approved v2.0.0 chunks", async () => {
      const { temporalStore, temporalRouter } = setupTestEnvironment();
      const projectId = "proj_curr";

      // Insert v1.0.0 historical (superseded) chunk
      const c1 = temporalStore.insertTemporalChunk({
        file_id: 1,
        project_id: projectId,
        feature_id: "feat:ingestion_pipeline",
        version: "1.0.0",
        lifecycle_status: "superseded",
        valid_from: 1000,
        valid_to: 2000,
        text: "Pipeline v1: Single synchronous thread supporting up to 50 req/sec.",
        meta: { source: "Client_Requirements_v1.docx" },
      });

      // Insert v2.0.0 active chunk
      temporalStore.insertTemporalChunk({
        file_id: 2,
        project_id: projectId,
        feature_id: "feat:ingestion_pipeline",
        version: "2.0.0",
        lifecycle_status: "active",
        valid_from: 2000,
        valid_to: null,
        predecessor_id: c1.id,
        superseded_reason: "Upgraded to 4 parallel streaming pipelines",
        text: "Pipeline v2: 4 parallel streaming pipelines supporting 2,000 req/sec.",
        meta: { source: "Client_Requirements_v2.pdf" },
      });

      const res = await temporalRouter.routeTemporalQuery({
        projectId,
        query: "What is the ingestion pipeline architecture?",
      });

      assert.equal(res.status, "RESOLVED");
      assert.equal(res.plan.intent, "CURRENT_STATE");
      assert.equal(res.evidence.length, 1);
      assert.equal(res.evidence[0].version, "2.0.0");
      assert.equal(res.evidence[0].lifecycleStatus, "active");
      assert.ok(res.evidence[0].text.includes("4 parallel streaming pipelines"));
      assert.ok(res.passages.includes("[QUERY INTENT: CURRENT_STATE]"));
      assert.ok(res.passages.includes("[AUTHORITATIVE VERSION: 2.0.0]"));
      assert.ok(res.passages.includes("[STATUS: APPROVED]"));
    });

    test("Test 3: Superseded Exclusion: Historical v1.0.0 chunks are excluded from CURRENT_STATE evidence", async () => {
      const { temporalStore, temporalRouter } = setupTestEnvironment();
      const projectId = "proj_curr_excl";

      temporalStore.insertTemporalChunk({
        file_id: 1,
        project_id: projectId,
        feature_id: "feat:ingestion_pipeline",
        version: "1.0.0",
        lifecycle_status: "superseded",
        valid_from: 1000,
        valid_to: 2000,
        text: "Old pipeline v1.",
        meta: { source: "v1.docx" },
      });

      temporalStore.insertTemporalChunk({
        file_id: 2,
        project_id: projectId,
        feature_id: "feat:ingestion_pipeline",
        version: "2.0.0",
        lifecycle_status: "active",
        valid_from: 2000,
        valid_to: null,
        text: "New pipeline v2.",
        meta: { source: "v2.pdf" },
      });

      const res = await temporalRouter.routeTemporalQuery({
        projectId,
        query: "Describe the data ingestion pipeline",
      });

      assert.equal(res.status, "RESOLVED");
      const versions = res.evidence.map((e) => e.version);
      assert.ok(versions.includes("2.0.0"));
      assert.ok(!versions.includes("1.0.0"), "v1.0.0 must be excluded from CURRENT_STATE");
      assert.ok(!res.passages.includes("Old pipeline v1."));
    });

    test("Test 4: Deprecated Exclusion: Deprecated chunks are excluded from CURRENT_STATE evidence", async () => {
      const { temporalStore, temporalRouter } = setupTestEnvironment();
      const projectId = "proj_curr_dep";

      temporalStore.insertTemporalChunk({
        file_id: 1,
        project_id: projectId,
        feature_id: "feat:ingestion_pipeline",
        version: "1.0.0",
        lifecycle_status: "deprecated",
        valid_from: 1000,
        valid_to: 1500,
        text: "Deprecated pipeline specification.",
        meta: { source: "old_spec.pdf" },
      });

      const res = await temporalRouter.routeTemporalQuery({
        projectId,
        query: "What is the ingestion pipeline architecture?",
      });

      // Since only deprecated chunk exists and CURRENT_STATE excludes deprecated, evidence must be empty
      assert.equal(res.evidence.length, 0);
    });
  });

  // =========================================================================
  // Group B: HISTORICAL_STATE
  // =========================================================================
  describe("Group B: HISTORICAL_STATE", () => {
    test("Test 5: Point-in-Time Date (Month/Year): January 2026 resolves to HISTORICAL_STATE and retrieves v1.0.0", async () => {
      const { temporalStore, temporalRouter } = setupTestEnvironment();
      const projectId = "proj_hist_month";

      const jan1_2026 = Date.UTC(2026, 0, 15);
      const feb1_2026 = Date.UTC(2026, 1, 15);
      const mar1_2026 = Date.UTC(2026, 2, 1);

      // v1 was valid from Jan 1 2026 to Mar 1 2026
      temporalStore.insertTemporalChunk({
        file_id: 1,
        project_id: projectId,
        feature_id: "feat:ingestion_pipeline",
        version: "1.0.0",
        lifecycle_status: "superseded",
        valid_from: Date.UTC(2026, 0, 1),
        valid_to: mar1_2026,
        text: "January 2026 baseline: 1 synchronous pipeline with 50 req/sec limit.",
        meta: { source: "Client_Requirements_v1.docx" },
      });

      // v2 valid from Mar 1 2026 onwards
      temporalStore.insertTemporalChunk({
        file_id: 2,
        project_id: projectId,
        feature_id: "feat:ingestion_pipeline",
        version: "2.0.0",
        lifecycle_status: "active",
        valid_from: mar1_2026,
        valid_to: null,
        text: "March 2026 baseline: 4 parallel streaming pipelines with 2,000 req/sec limit.",
        meta: { source: "Client_Requirements_v2.pdf" },
      });

      const query = "What was the ingestion pipeline architecture in January 2026?";
      const classification = classifyTemporalIntent(query);
      assert.equal(classification.intent, "HISTORICAL_STATE");

      const params = extractTemporalParameters(query);
      assert.equal(params.temporal.asOf, Date.UTC(2026, 0, 1));

      const res = await temporalRouter.routeTemporalQuery({
        projectId,
        query,
      });

      assert.equal(res.status, "RESOLVED");
      assert.equal(res.plan.intent, "HISTORICAL_STATE");
      assert.equal(res.evidence.length, 1);
      assert.equal(res.evidence[0].version, "1.0.0");
      assert.equal(res.evidence[0].lifecycleStatus, "superseded");
      assert.ok(res.evidence[0].text.includes("January 2026 baseline"));
    });

    test("Test 6: Exact Date: 2026-03-01 extracts exact timestamp and retrieves state valid at that point", async () => {
      const { temporalStore, temporalRouter } = setupTestEnvironment();
      const projectId = "proj_hist_exact";

      const tPoint = Date.UTC(2026, 2, 1);

      temporalStore.insertTemporalChunk({
        file_id: 1,
        project_id: projectId,
        feature_id: "feat:ingestion_pipeline",
        version: "2.0.0",
        lifecycle_status: "active",
        valid_from: tPoint,
        valid_to: null,
        text: "Exact date valid chunk as of March 1 2026.",
        meta: { source: "Client_Requirements_v2.pdf" },
      });

      const query = "What was the specification on 2026-03-01 for the ingestion pipeline?";
      const params = extractTemporalParameters(query);
      assert.equal(params.temporal.asOf, tPoint);

      const res = await temporalRouter.routeTemporalQuery({
        projectId,
        query,
      });

      assert.equal(res.status, "RESOLVED");
      assert.equal(res.evidence.length, 1);
      assert.ok(res.evidence[0].text.includes("Exact date valid chunk"));
    });

    test("Test 7: Explicit Version Reference: Architecture in v1.0.0 resolves to HISTORICAL_STATE with version 1.0.0", async () => {
      const { temporalStore, temporalRouter } = setupTestEnvironment();
      const projectId = "proj_hist_ver";

      temporalStore.insertTemporalChunk({
        file_id: 1,
        project_id: projectId,
        feature_id: "feat:ingestion_pipeline",
        version: "1.0.0",
        lifecycle_status: "superseded",
        valid_from: 1000,
        valid_to: 2000,
        text: "v1.0.0 single pipeline architecture specification.",
        meta: { source: "Client_Requirements_v1.docx" },
      });

      temporalStore.insertTemporalChunk({
        file_id: 2,
        project_id: projectId,
        feature_id: "feat:ingestion_pipeline",
        version: "2.0.0",
        lifecycle_status: "active",
        valid_from: 2000,
        valid_to: null,
        text: "v2.0.0 four stream architecture specification.",
        meta: { source: "Client_Requirements_v2.pdf" },
      });

      const query = "What was the architecture in v1.0.0 for the ingestion pipeline?";
      const res = await temporalRouter.routeTemporalQuery({
        projectId,
        query,
      });

      assert.equal(res.status, "RESOLVED");
      assert.equal(res.plan.intent, "HISTORICAL_STATE");
      assert.equal(res.plan.temporal.version, "1.0.0");
      assert.equal(res.evidence.length, 1);
      assert.equal(res.evidence[0].version, "1.0.0");
      assert.ok(res.evidence[0].text.includes("v1.0.0 single pipeline"));
    });

    test("Test 8: Historical Status Labeling: Formatted passages include [QUERY INTENT: HISTORICAL_STATE] and [RESOLVED VERSION: 1.0.0]", async () => {
      const { temporalStore, temporalRouter } = setupTestEnvironment();
      const projectId = "proj_hist_label";

      temporalStore.insertTemporalChunk({
        file_id: 1,
        project_id: projectId,
        feature_id: "feat:ingestion_pipeline",
        version: "1.0.0",
        lifecycle_status: "superseded",
        valid_from: 1000,
        valid_to: 2000,
        text: "Archival specification content.",
        meta: { source: "Client_Requirements_v1.docx" },
      });

      const res = await temporalRouter.routeTemporalQuery({
        projectId,
        query: "What was the pipeline architecture in v1.0.0?",
      });

      assert.ok(res.passages.includes("[QUERY INTENT: HISTORICAL_STATE]"));
      assert.ok(res.passages.includes("[RESOLVED VERSION: 1.0.0]"));
      assert.ok(res.passages.includes("[STATUS: HISTORICAL]"));
      assert.ok(res.passages.includes("Archival specification content."));
    });

    test("Test 9: No Fallback to Current: If historical state not found, returns empty rather than current version", async () => {
      const { temporalStore, temporalRouter } = setupTestEnvironment();
      const projectId = "proj_hist_nofallback";

      // Current active version starts in 2026
      temporalStore.insertTemporalChunk({
        file_id: 1,
        project_id: projectId,
        feature_id: "feat:ingestion_pipeline",
        version: "2.0.0",
        lifecycle_status: "active",
        valid_from: Date.UTC(2026, 2, 1),
        valid_to: null,
        text: "Active 2026 specification.",
        meta: { source: "Client_Requirements_v2.pdf" },
      });

      // Target year 2020 where feature did not exist
      const query = "What was the ingestion pipeline architecture in January 2020?";
      const res = await temporalRouter.routeTemporalQuery({
        projectId,
        query,
      });

      assert.equal(res.status, "RESOLVED");
      assert.equal(res.plan.intent, "HISTORICAL_STATE");
      assert.equal(res.evidence.length, 0, "Must not return current version when historical time point had no record");
      assert.ok(!res.passages.includes("Active 2026 specification."));
    });

    test("Test 10: Ambiguous Date Handling: Query with unanchored relative date records ambiguity", () => {
      const query = "What was the pipeline back then?";
      const { temporal, ambiguity } = extractTemporalParameters(query);

      assert.equal(temporal.asOf, null);
      assert.equal(temporal.version, null);
      assert.ok(ambiguity.length > 0);
      assert.ok(ambiguity[0].includes("relative temporal reference"));
    });
  });

  // =========================================================================
  // Group C: DIFF_EVOLUTION
  // =========================================================================
  describe("Group C: DIFF_EVOLUTION", () => {
    test("Test 11: Evolution Query Classification: 'What changed in the ingestion pipeline?' classifies as DIFF_EVOLUTION", () => {
      const classification = classifyTemporalIntent("What changed in the ingestion pipeline?");
      assert.equal(classification.intent, "DIFF_EVOLUTION");
      assert.ok(classification.confidence >= 0.9);
    });

    test("Test 12: Version Comparison: 'Compare v1 and v2 of the ingestion pipeline' extracts from=1.0.0, to=2.0.0", () => {
      const query = "Compare v1 and v2 of the ingestion pipeline";
      const classification = classifyTemporalIntent(query);
      assert.equal(classification.intent, "DIFF_EVOLUTION");

      const { temporal } = extractTemporalParameters(query);
      assert.equal(temporal.from, "1.0.0");
      assert.equal(temporal.to, "2.0.0");
      assert.equal(temporal.version, "2.0.0");
    });

    test("Test 13: Lineage Retrieval: Retrieves both predecessor (v1.0.0) and successor (v2.0.0) via temporalStore", async () => {
      const { temporalStore, temporalRouter } = setupTestEnvironment();
      const projectId = "proj_diff_lineage";

      const c1 = temporalStore.insertTemporalChunk({
        file_id: 1,
        project_id: projectId,
        feature_id: "feat:ingestion_pipeline",
        version: "1.0.0",
        lifecycle_status: "superseded",
        valid_from: 1000,
        valid_to: 2000,
        text: "Single pipeline synchronous throughput limit 50 req/sec.",
        meta: { source: "Client_Requirements_v1.docx" },
      });

      temporalStore.insertTemporalChunk({
        file_id: 2,
        project_id: projectId,
        feature_id: "feat:ingestion_pipeline",
        version: "2.0.0",
        lifecycle_status: "active",
        valid_from: 2000,
        valid_to: null,
        predecessor_id: c1.id,
        superseded_reason: "Upgraded from 1 single synchronous pipeline to 4 parallel streaming pipelines",
        text: "4 parallel streaming pipelines throughput limit 2,000 req/sec.",
        meta: { source: "Client_Requirements_v2.pdf" },
      });

      const res = await temporalRouter.routeTemporalQuery({
        projectId,
        query: "What changed in the ingestion pipeline?",
      });

      assert.equal(res.status, "RESOLVED");
      assert.equal(res.plan.intent, "DIFF_EVOLUTION");
      assert.equal(res.evidence.length, 2);

      const beforeItem = res.evidence.find((e) => e.role === "BEFORE");
      const afterItem = res.evidence.find((e) => e.role === "AFTER");

      assert.ok(beforeItem, "BEFORE evidence role must exist");
      assert.equal(beforeItem.version, "1.0.0");
      assert.ok(beforeItem.text.includes("Single pipeline synchronous"));

      assert.ok(afterItem, "AFTER evidence role must exist");
      assert.equal(afterItem.version, "2.0.0");
      assert.ok(afterItem.text.includes("4 parallel streaming pipelines"));
    });

    test("Test 14: Superseded Reason Preserved: Formatted output includes CHANGE: containing superseded_reason", async () => {
      const { temporalStore, temporalRouter } = setupTestEnvironment();
      const projectId = "proj_diff_reason";

      const c1 = temporalStore.insertTemporalChunk({
        file_id: 1,
        project_id: projectId,
        feature_id: "feat:ingestion_pipeline",
        version: "1.0.0",
        lifecycle_status: "superseded",
        valid_from: 1000,
        valid_to: 2000,
        text: "Old pipeline details.",
        meta: { source: "v1.docx" },
      });

      temporalStore.insertTemporalChunk({
        file_id: 2,
        project_id: projectId,
        feature_id: "feat:ingestion_pipeline",
        version: "2.0.0",
        lifecycle_status: "active",
        valid_from: 2000,
        valid_to: null,
        predecessor_id: c1.id,
        superseded_reason: "Migrated to gRPC event bus with 4x concurrency.",
        text: "New pipeline details.",
        meta: { source: "v2.pdf" },
      });

      const res = await temporalRouter.routeTemporalQuery({
        projectId,
        query: "What changed in the data ingestion architecture?",
      });

      assert.ok(res.passages.includes("[QUERY INTENT: DIFF_EVOLUTION]"));
      assert.ok(res.passages.includes("BEFORE:\nVersion 1.0.0 (Status: SUPERSEDED)"));
      assert.ok(res.passages.includes("AFTER:\nVersion 2.0.0 (Status: ACTIVE)"));
      assert.ok(res.passages.includes("CHANGE:\nMigrated to gRPC event bus with 4x concurrency."));
    });

    test("Test 15: Missing Predecessor Handling: Single version returns [INITIAL BASELINE: Version ...]", async () => {
      const { temporalStore, temporalRouter } = setupTestEnvironment();
      const projectId = "proj_diff_initial";

      // Insert single baseline version for feat:storage_isolation (which only has v1.0.0)
      temporalStore.insertTemporalChunk({
        file_id: 1,
        project_id: projectId,
        feature_id: "feat:storage_isolation",
        version: "1.0.0",
        lifecycle_status: "active",
        valid_from: 1000,
        valid_to: null,
        text: "Copilot isolation invariant: strictly copilot.db only.",
        meta: { source: "OKF-0002" },
      });

      const res = await temporalRouter.routeTemporalQuery({
        projectId,
        query: "How has storage isolation evolved?",
      });

      assert.equal(res.status, "RESOLVED");
      assert.equal(res.plan.intent, "DIFF_EVOLUTION");
      assert.equal(res.evidence.length, 1);
      assert.equal(res.evidence[0].role, "INITIAL");
      assert.ok(res.passages.includes("[QUERY INTENT: DIFF_EVOLUTION]"));
      assert.ok(res.passages.includes("[INITIAL BASELINE: Version 1.0.0]"));
    });

    test("Test 16: Unresolved Conflict Visibility: Surfaced conflicts appear in conflicts property", async () => {
      const { temporalStore, temporalRouter } = setupTestEnvironment();
      const projectId = "proj_diff_conflict";

      // Two chunks at same tier and version with conflicting text
      temporalStore.insertTemporalChunk({
        file_id: 1,
        project_id: projectId,
        feature_id: "feat:ingestion_pipeline",
        version: "2.0.0",
        lifecycle_status: "active",
        approval_status: "approved",
        valid_from: 2000,
        valid_to: null,
        text: "Ingestion pipeline supports 2,000 req/sec limit.",
        meta: { source: "doc_a.pdf" },
      });

      temporalStore.insertTemporalChunk({
        file_id: 2,
        project_id: projectId,
        feature_id: "feat:ingestion_pipeline",
        version: "2.0.0",
        lifecycle_status: "active",
        approval_status: "approved",
        valid_from: 2000,
        valid_to: null,
        text: "Ingestion pipeline supports 5,000 req/sec limit.",
        meta: { source: "doc_b.pdf" },
      });

      const res = await temporalRouter.routeTemporalQuery({
        projectId,
        query: "What is the ingestion pipeline architecture?",
      });

      assert.ok(res.conflicts.length > 0, "Conflicts should be surfaced when conflicting facts exist at same tier");
      assert.ok(res.conflicts[0].type.includes("CONFLICT") || res.conflicts[0].reason.includes("Conflicting"));
    });
  });

  // =========================================================================
  // Group D: Feature Identification
  // =========================================================================
  describe("Group D: Feature Identification", () => {
    test("Test 17: Canonical Name Match: Resolves feature via exact canonical name", async () => {
      const { temporalRouter } = setupTestEnvironment();
      const res = await temporalRouter.routeTemporalQuery({
        projectId: "p_d1",
        query: "Tell me about Data Ingestion Pipeline Architecture",
      });

      assert.equal(res.status, "RESOLVED");
      assert.equal(res.plan.featureIds[0], "feat:ingestion_pipeline");
    });

    test("Test 18: Alias Match: Resolves feature via registered alias", async () => {
      const { temporalRouter } = setupTestEnvironment();
      const res = await temporalRouter.routeTemporalQuery({
        projectId: "p_d2",
        query: "What is the streaming pipeline?",
      });

      assert.equal(res.status, "RESOLVED");
      assert.equal(res.plan.featureIds[0], "feat:ingestion_pipeline");
    });

    test("Test 19: Ambiguous Keyword Match: Query matching keywords of multiple features reports AMBIGUOUS", async () => {
      const mockData = {
        features: [
          {
            feature_id: "feat:stream_alpha",
            canonical_name: "Stream Alpha Engine",
            aliases: ["alpha stream"],
            keywords: ["stream", "telemetry"],
            current_approved_version: "1.0.0",
            sources: [{ document_name: "doc_alpha.pdf", section_id: "sec_1" }],
          },
          {
            feature_id: "feat:stream_beta",
            canonical_name: "Stream Beta Engine",
            aliases: ["beta stream"],
            keywords: ["stream", "telemetry"],
            current_approved_version: "1.0.0",
            sources: [{ document_name: "doc_beta.pdf", section_id: "sec_2" }],
          },
        ],
      };

      const { temporalRouter } = setupTestEnvironment({ mockRegistryData: mockData });
      const res = await temporalRouter.routeTemporalQuery({
        projectId: "p_d3",
        query: "What is the telemetry configuration?",
      });

      assert.equal(res.status, "AMBIGUOUS");
      assert.ok(res.plan.featureIds.length >= 2);
      assert.ok(res.ambiguity.length > 0);
    });

    test("Test 20: Non-Feature Query: General project query returns NOT_FOUND and falls back", async () => {
      const { temporalRouter } = setupTestEnvironment();
      const res = await temporalRouter.routeTemporalQuery({
        projectId: "p_d4",
        query: "What did we discuss in yesterday's marketing sync?",
      });

      assert.equal(res.status, "NOT_FOUND");
      assert.equal(res.evidence.length, 0);
      assert.equal(res.passages, "");
    });
  });

  // =========================================================================
  // Group E: Regression & Integration
  // =========================================================================
  describe("Group E: Regression & Integration", () => {
    test("Test 21: Vector Search Precedence: In retrieve(), temporal passages are prepended before vector search", async () => {
      const { db, ragStore, temporalStore, als, temporalRouter } = setupTestEnvironment();
      const projectId = 101;

      // Seed project files in SQLite
      db.prepare(`
        INSERT INTO copilot_project_files (id, project_id, path, name, status, chunk_count)
        VALUES (1, 101, '/path/notes.txt', 'notes.txt', 'ready', 1)
      `).run();

      // Seed standard vector chunk in copilot_chunks
      db.prepare(`
        INSERT INTO copilot_chunks (id, file_id, project_id, ord, text, meta, embed, hash, dims, vec, feature_id, lifecycle_status)
        VALUES (1, 1, 101, 0, 'General meeting note: The team talked about pipeline scaling.', '{}', 'text', 'hash1', 4, ?, NULL, 'active')
      `).run(Buffer.alloc(16));
      db.prepare(`INSERT INTO copilot_chunks_fts (rowid, text) VALUES (1, 'General meeting note: The team talked about pipeline scaling.')`).run();

      // Insert authoritative temporal chunk
      temporalStore.insertTemporalChunk({
        file_id: 1,
        project_id: projectId,
        feature_id: "feat:ingestion_pipeline",
        version: "2.0.0",
        lifecycle_status: "active",
        valid_from: 1000,
        valid_to: null,
        text: "Authoritative Specification: 4 parallel streaming pipelines at 2,000 req/sec.",
        meta: { source: "Client_Requirements_v2.pdf" },
      });

      const retriever = createRetriever({
        rag: ragStore,
        clients: () => null,
        als,
        temporalRouter,
      });

      const query = "What is the ingestion pipeline architecture?";
      const res = await retriever.retrieve({
        query,
        projectIds: [projectId],
      });

      assert.ok(res.text.includes("[QUERY INTENT: CURRENT_STATE]"));
      assert.ok(res.text.indexOf("[QUERY INTENT: CURRENT_STATE]") < res.text.indexOf("General meeting note:"));
      assert.ok(res.temporalRouting != null);
      assert.equal(res.temporalRouting.plan.intent, "CURRENT_STATE");
      assert.ok(res.used.some((u) => u.temporal === true && u.role === "CURRENT"));
    });

    test("Test 22: ALS Backward Compatibility: Existing als.lookup() still works directly", async () => {
      const { temporalStore, als } = setupTestEnvironment();
      const projectId = "proj_als_compat";

      temporalStore.insertTemporalChunk({
        file_id: 1,
        project_id: projectId,
        feature_id: "feat:ingestion_pipeline",
        version: "2.0.0",
        lifecycle_status: "active",
        valid_from: 1000,
        valid_to: null,
        text: "Direct ALS verification chunk.",
        meta: { source: "Client_Requirements_v2.pdf" },
      });

      const alsRes = await als.lookup({
        projectId,
        query: "What is the ingestion pipeline?",
      });

      assert.equal(alsRes.status, "RESOLVED");
      assert.equal(alsRes.feature.feature_id, "feat:ingestion_pipeline");
      assert.equal(alsRes.version.version, "2.0.0");
      assert.equal(alsRes.facts.length, 1);
      assert.ok(alsRes.facts[0].text.includes("Direct ALS verification chunk"));
    });

    test("Test 23: Router Backward Compatibility: okfRouter.classifyQuery() returns route and temporal metadata", () => {
      const { featureRegistry } = setupTestEnvironment();
      const router = createOkfRouter();

      const res = router.classifyQuery({
        query: "What changed in the ingestion pipeline?",
        registry: featureRegistry,
      });

      // Preserves legacy classification
      assert.ok(res.route === "okf" || res.route === "mixed" || res.route === "rag");
      assert.ok(res.confidence > 0);
      assert.ok(Array.isArray(res.matched_signals));

      // Contains Phase 5 temporal metadata
      assert.ok(res.temporal != null);
      assert.equal(res.temporal.intent, "DIFF_EVOLUTION");
    });

    test("Test 24: DeltaIngest Backward Compatibility: Incremental delta ingestion operates cleanly", async () => {
      const { ragStore, temporalStore, featureRegistry } = setupTestEnvironment();
      const mockEmbedder = {
        dims: 4,
        embedDocs: async (docs) => ({
          vectors: docs.map(() => new Float32Array(4)),
          tokens: 10,
          cost: 0,
        }),
      };
      const deltaIngest = ragStore.createDeltaIngest({ featureRegistry, embedder: mockEmbedder });
      const projectId = 505;

      const markdown = `
# Data Ingestion Pipeline Architecture

The system processes 2,000 requests per second with high throughput streaming.
`;

      const result = await deltaIngest.processDocument({
        projectId,
        fileId: 10,
        document: markdown,
        source: "ingest.md",
        approved: true,
      });

      assert.equal(result.status, "success");
      assert.equal(result.summary.total_sections, 1);
      assert.equal(result.summary.new_features, 1);

      const activeChunks = temporalStore.getActiveFeatureChunks(projectId, "feat:ingestion_pipeline");
      assert.ok(activeChunks.length >= 1);
    });

    test("Test 25: Cache Isolation Across Intents: Different intents for identical queries maintain distinct cache entries", async () => {
      const { temporalStore, temporalRouter } = setupTestEnvironment();
      const projectId = "proj_cache_iso";

      const tPoint = Date.UTC(2026, 0, 15);

      temporalStore.insertTemporalChunk({
        file_id: 1,
        project_id: projectId,
        feature_id: "feat:ingestion_pipeline",
        version: "1.0.0",
        lifecycle_status: "superseded",
        valid_from: 1000,
        valid_to: 2000,
        text: "Predecessor v1.0.0.",
        meta: { source: "v1.docx" },
      });

      temporalStore.insertTemporalChunk({
        file_id: 2,
        project_id: projectId,
        feature_id: "feat:ingestion_pipeline",
        version: "2.0.0",
        lifecycle_status: "active",
        valid_from: 2000,
        valid_to: null,
        text: "Successor v2.0.0.",
        meta: { source: "v2.pdf" },
      });

      // Query 1: Default CURRENT_STATE
      const res1 = await temporalRouter.routeTemporalQuery({
        projectId,
        query: "What is the ingestion pipeline architecture?",
      });
      assert.equal(res1.plan.intent, "CURRENT_STATE");
      assert.equal(res1.evidence[0].version, "2.0.0");

      // Query 2: Same query text, but with explicit asOf for HISTORICAL_STATE
      const res2 = await temporalRouter.routeTemporalQuery({
        projectId,
        query: "What is the ingestion pipeline architecture?",
        asOf: 1500,
      });

      // Must NOT return cached CURRENT_STATE!
      assert.notEqual(res1, res2);
      assert.equal(res2.plan.temporal.asOf, 1500);
      assert.equal(res2.evidence[0].version, "1.0.0");
    });
  });
});
