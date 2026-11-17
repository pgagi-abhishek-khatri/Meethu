// test/copilot/deltaIngest.test.js
// Automated test suite for Phase 3: Incremental Semantic Delta Ingestion.
// Verifies scenarios A through L: idempotency, delta classification,
// baseline preservation, dry run, atomic rollback, and legacy compatibility.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const path = require("path");

const { createRagStore } = require("../../src/copilot/rag/ragStore");
const { createTemporalStore } = require("../../src/copilot/rag/temporalStore");
const { createFeatureRegistry } = require("../../src/copilot/core/okf/featureRegistry");
const {
  createDeltaIngest,
  normalizeContent,
  computeContentHash,
  extractSections,
  matchFeature,
  classifySectionDelta,
  isExplicitlyDeprecated,
} = require("../../src/copilot/rag/deltaIngest");

// Mock Embedder
function createMockEmbedder({ dims = 4, failOnCall = false } = {}) {
  let callCount = 0;
  const embeddedTexts = [];

  return {
    dims,
    getCallCount: () => callCount,
    getEmbeddedTexts: () => embeddedTexts,
    embedDocs: async (docs) => {
      callCount++;
      if (failOnCall) {
        throw new Error("Simulated embedding network failure");
      }
      return {
        vectors: docs.map((d, i) => {
          embeddedTexts.push(d.text);
          const v = new Float32Array(dims);
          for (let j = 0; j < dims; j++) v[j] = (callCount * 10 + i + j) / 100;
          return v;
        }),
        tokens: docs.reduce((acc, d) => acc + d.text.length, 0),
        cost: 0.0001 * docs.length,
      };
    },
  };
}

// Setup helper
function setupTestContext({ mockRegistryData = null } = {}) {
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
    // Load canonical feature registry from OKF
    const okfDir = path.resolve(__dirname, "../../OKF");
    featureRegistry = createFeatureRegistry({ okfDir });
  }
  featureRegistry.load();

  return { db, ragStore, temporalStore, featureRegistry };
}

describe("Phase 3: Incremental Semantic Delta Ingestion", () => {
  // -------------------------------------------------------------------------
  // Scenario A: IDENTICAL RE-INGESTION
  // -------------------------------------------------------------------------
  test("Scenario A: Identical re-ingestion produces 0 new embeddings and 0 duplicate chunks", async () => {
    const { db, ragStore, temporalStore, featureRegistry } = setupTestContext();
    const embedder = createMockEmbedder();
    const deltaIngest = createDeltaIngest({
      db,
      ragStore,
      temporalStore,
      featureRegistry,
      embedder,
    });

    const docText = `
# Data Ingestion Pipeline Architecture

The system shall ingest real-time voice streams via WebRTC with a maximum latency of 250ms.
`;

    // First ingestion (approved)
    const res1 = await deltaIngest.processDocument({
      projectId: "proj_a",
      fileId: 101,
      document: docText,
      source: "requirements_v1.md",
      approved: true,
    });

    assert.equal(res1.status, "success");
    assert.equal(res1.summary.total_sections, 1);
    assert.equal(res1.summary.new_features, 1);
    assert.equal(res1.summary.embeddings_created, 1);
    assert.equal(embedder.getCallCount(), 1);

    const activeBefore = temporalStore.getActiveFeatureChunks("proj_a", "feat:ingestion_pipeline");
    assert.equal(activeBefore.length, 1);
    const hash1 = activeBefore[0].hash;

    // Second identical ingestion
    const res2 = await deltaIngest.processDocument({
      projectId: "proj_a",
      fileId: 101,
      document: docText,
      source: "requirements_v1.md",
      approved: true,
    });

    assert.equal(res2.status, "success");
    assert.equal(res2.summary.total_sections, 1);
    assert.equal(res2.summary.unchanged_features, 1);
    assert.equal(res2.summary.new_features, 0);
    assert.equal(res2.summary.modified_features, 0);
    assert.equal(res2.summary.embeddings_created, 0);
    assert.equal(res2.summary.embeddings_reused, 1);
    assert.equal(embedder.getCallCount(), 1, "Embedder must NOT be called on identical re-ingestion");

    const activeAfter = temporalStore.getActiveFeatureChunks("proj_a", "feat:ingestion_pipeline");
    assert.equal(activeAfter.length, 1, "No duplicate chunks created");
    assert.equal(activeAfter[0].id, activeBefore[0].id, "Retains same chunk ID");
    assert.equal(activeAfter[0].hash, hash1, "Identical content hash");
  });

  // -------------------------------------------------------------------------
  // Scenario B: SINGLE FEATURE MODIFICATION
  // -------------------------------------------------------------------------
  test("Scenario B: Single feature modification embeds ONLY changed feature and preserves history", async () => {
    const { db, ragStore, temporalStore, featureRegistry } = setupTestContext();
    const embedder = createMockEmbedder();
    const deltaIngest = createDeltaIngest({
      db,
      ragStore,
      temporalStore,
      featureRegistry,
      embedder,
    });

    // Ingest baseline with 2 canonical features: Ingestion Pipeline & Copilot Orchestration
    const baselineDoc = `
# Data Ingestion Pipeline Architecture
Initial single pipeline ingestion supporting 50 req/sec.

# Live Meeting Copilot Core Orchestration
Core copilot loop orchestrating decider and context pack.
`;

    await deltaIngest.processDocument({
      projectId: "proj_b",
      fileId: 201,
      document: baselineDoc,
      source: "baseline.md",
      approved: true,
      effectiveAt: 1000,
    });

    assert.equal(embedder.getCallCount(), 2);
    const activePipelineV1 = temporalStore.getActiveFeatureChunks("proj_b", "feat:ingestion_pipeline")[0];
    const activeCopilotV1 = temporalStore.getActiveFeatureChunks("proj_b", "feat:copilot_orchestration")[0];

    // Second document: Copilot is unchanged, Ingestion Pipeline is modified to 2,000 req/sec
    const updatedDoc = `
# Data Ingestion Pipeline Architecture
Upgraded 4 parallel distributed streaming pipelines supporting 2,000 req/sec.

# Live Meeting Copilot Core Orchestration
Core copilot loop orchestrating decider and context pack.
`;

    const resUpdate = await deltaIngest.processDocument({
      projectId: "proj_b",
      fileId: 202,
      document: updatedDoc,
      source: "update_v2.md",
      approved: true,
      effectiveAt: 2000,
      proposedVersion: "2.0.0",
    });

    assert.equal(resUpdate.status, "success");
    assert.equal(resUpdate.summary.modified_features, 1);
    assert.equal(resUpdate.summary.unchanged_features, 1);
    assert.equal(resUpdate.summary.embeddings_created, 1, "Only modified feature was embedded");
    assert.equal(resUpdate.summary.embeddings_reused, 1, "Unchanged feature reused embedding");
    assert.equal(embedder.getCallCount(), 3, "Only 1 additional embedder call made");

    // Verify Ingestion Pipeline is superseded and has v2 active
    const activePipelineV2 = temporalStore.getActiveFeatureChunks("proj_b", "feat:ingestion_pipeline")[0];
    assert.notEqual(activePipelineV2.id, activePipelineV1.id);
    assert.equal(activePipelineV2.version, "2.0.0");
    assert.equal(activePipelineV2.lifecycle_status, "active");

    // Verify historical point-in-time retrieval for v1 at t=1500
    const histV1 = temporalStore.getFeatureAt("proj_b", "feat:ingestion_pipeline", 1500);
    assert.equal(histV1.length, 1);
    assert.equal(histV1[0].id, activePipelineV1.id);
    assert.equal(histV1[0].version, activePipelineV1.version);

    // Verify Copilot Orchestration remains completely untouched
    const activeCopilotV2 = temporalStore.getActiveFeatureChunks("proj_b", "feat:copilot_orchestration")[0];
    assert.equal(activeCopilotV2.id, activeCopilotV1.id, "Copilot orchestration chunk unchanged");
  });

  // -------------------------------------------------------------------------
  // Scenario C: PARTIAL DOCUMENT UPDATE (Preserve Baseline)
  // -------------------------------------------------------------------------
  test("Scenario C: Partial document update preserves untouched baseline requirements", async () => {
    const { db, ragStore, temporalStore, featureRegistry } = setupTestContext();
    const embedder = createMockEmbedder();
    const deltaIngest = createDeltaIngest({
      db,
      ragStore,
      temporalStore,
      featureRegistry,
      embedder,
    });

    // Ingest 2 features initially
    await deltaIngest.processDocument({
      projectId: "proj_c",
      fileId: 301,
      document: `
# Data Ingestion Pipeline Architecture
Baseline ingestion pipeline.

# Live Meeting Copilot Core Orchestration
Baseline copilot orchestration.
`,
      approved: true,
      effectiveAt: 1000,
    });

    // New document ONLY mentions Copilot Orchestration with an update; Ingestion Pipeline is absent
    const partialDoc = `
# Live Meeting Copilot Core Orchestration
Upgraded copilot loop with sub-millisecond dispatch.
`;

    const res = await deltaIngest.processDocument({
      projectId: "proj_c",
      fileId: 302,
      document: partialDoc,
      approved: true,
      effectiveAt: 2000,
    });

    assert.equal(res.summary.total_sections, 1);
    assert.equal(res.summary.modified_features, 1);

    // CRITICAL: Ingestion Pipeline was omitted from partialDoc, but MUST still be active in project!
    const activePipeline = temporalStore.getActiveFeatureChunks("proj_c", "feat:ingestion_pipeline");
    assert.equal(activePipeline.length, 1, "Omitted baseline requirement must be preserved as active");
    assert.equal(activePipeline[0].lifecycle_status, "active");
  });

  // -------------------------------------------------------------------------
  // Scenario D: EXPLICIT DEPRECATION
  // -------------------------------------------------------------------------
  test("Scenario D: Explicit deprecation closes interval, marks deprecated, retains history", async () => {
    const { db, ragStore, temporalStore, featureRegistry } = setupTestContext();
    const embedder = createMockEmbedder();
    const deltaIngest = createDeltaIngest({
      db,
      ragStore,
      temporalStore,
      featureRegistry,
      embedder,
    });

    // Ingest initial active feature
    await deltaIngest.processDocument({
      projectId: "proj_d",
      fileId: 401,
      document: `
# Data Ingestion Pipeline Architecture
Active pipeline specification.
`,
      approved: true,
      effectiveAt: 1000,
    });

    const activeBefore = temporalStore.getActiveFeatureChunks("proj_d", "feat:ingestion_pipeline");
    assert.equal(activeBefore.length, 1);

    // Deprecating document with explicit [DEPRECATED] tag
    const deprecateDoc = `
# Data Ingestion Pipeline Architecture [DEPRECATED]
Status: Deprecated. This requirement is deprecated and retired in favor of external messaging.
`;

    const res = await deltaIngest.processDocument({
      projectId: "proj_d",
      fileId: 402,
      document: deprecateDoc,
      approved: true,
      effectiveAt: 3000,
    });

    assert.equal(res.summary.deprecated_features, 1);
    assert.equal(res.changes[0].classification, "DEPRECATED");
    assert.equal(res.changes[0].action_taken, "deprecated");

    // Active feature chunks should now be empty
    const activeAfter = temporalStore.getActiveFeatureChunks("proj_d", "feat:ingestion_pipeline");
    assert.equal(activeAfter.length, 0, "No active chunks remain after deprecation");

    // Historical lookup before t=3000 still returns the chunk
    const hist = temporalStore.getFeatureAt("proj_d", "feat:ingestion_pipeline", 2000);
    assert.equal(hist.length, 1);
    assert.equal(hist[0].id, activeBefore[0].id);

    // Lineage shows the chunk is deprecated
    const lineage = temporalStore.getFeatureLineage("proj_d", "feat:ingestion_pipeline");
    assert.equal(lineage.length, 1);
    assert.equal(lineage[0].lifecycle_status, "deprecated");
    assert.equal(lineage[0].valid_to, 3000);
  });

  // -------------------------------------------------------------------------
  // Scenario E: AMBIGUOUS FEATURE MATCH
  // -------------------------------------------------------------------------
  test("Scenario E: Ambiguous feature match is reported for human review without writing chunks", async () => {
    // Setup mock registry with two features sharing a common keyword
    const mockData = {
      schema_version: "1.0.0",
      bundle_id: "test_bundle",
      features: [
        {
          feature_id: "feat:stream_alpha",
          canonical_name: "Streaming Audio Processor Alpha",
          domain: "dsp",
          aliases: [],
          keywords: ["telemetry"],
          current_approved_version: "1.0.0",
          approval_status: "approved",
          lifecycle_status: "active",
          sources: [{ document_id: "doc", document_name: "doc.md" }],
        },
        {
          feature_id: "feat:stream_beta",
          canonical_name: "Streaming Telemetry Pipeline Beta",
          domain: "dsp",
          aliases: [],
          keywords: ["telemetry"],
          current_approved_version: "1.0.0",
          approval_status: "approved",
          lifecycle_status: "active",
          sources: [{ document_id: "doc", document_name: "doc.md" }],
        },
      ],
    };

    const { db, ragStore, temporalStore, featureRegistry } = setupTestContext({ mockRegistryData: mockData });
    const embedder = createMockEmbedder();
    const deltaIngest = createDeltaIngest({ db, ragStore, temporalStore, featureRegistry, embedder });

    // Section title matches 'telemetry', which is ambiguous across stream_alpha and stream_beta
    const doc = `
# Telemetry
Detailed telemetry requirement.
`;

    const res = await deltaIngest.processDocument({
      projectId: "proj_e",
      fileId: 501,
      document: doc,
      approved: true,
    });

    assert.equal(res.summary.ambiguous_features, 1);
    assert.equal(res.changes[0].classification, "AMBIGUOUS");
    assert.equal(res.changes[0].action_taken, "none");
    assert.deepEqual(res.changes[0].evidence.candidates, ["feat:stream_alpha", "feat:stream_beta"]);
    assert.equal(embedder.getCallCount(), 0, "No embedding created for ambiguous feature");
  });

  // -------------------------------------------------------------------------
  // Scenario F: UNMATCHED FEATURE
  // -------------------------------------------------------------------------
  test("Scenario F: Unmatched feature is retained as candidate without creating arbitrary IDs", async () => {
    const { db, ragStore, temporalStore, featureRegistry } = setupTestContext();
    const embedder = createMockEmbedder();
    const deltaIngest = createDeltaIngest({ db, ragStore, temporalStore, featureRegistry, embedder });

    const doc = `
# Quantum Entanglement Synchronization Layer
Specialized quantum networking requirements.
`;

    const res = await deltaIngest.processDocument({
      projectId: "proj_f",
      fileId: 601,
      document: doc,
      approved: true,
    });

    assert.equal(res.summary.unmatched_sections, 1);
    assert.equal(res.changes[0].classification, "UNMATCHED");
    assert.equal(res.changes[0].feature_id, null, "Must NOT invent arbitrary feature ID");
    assert.equal(res.changes[0].action_taken, "none");
    assert.equal(embedder.getCallCount(), 0);
  });

  // -------------------------------------------------------------------------
  // Scenario G: FORMATTING-ONLY CHANGE
  // -------------------------------------------------------------------------
  test("Scenario G: Formatting-only changes produce identical hash and are UNCHANGED", async () => {
    const { db, ragStore, temporalStore, featureRegistry } = setupTestContext();
    const embedder = createMockEmbedder();
    const deltaIngest = createDeltaIngest({ db, ragStore, temporalStore, featureRegistry, embedder });

    const docOriginal = `# Data Ingestion Pipeline Architecture
System must support 100 concurrent streams with <50ms latency.`;

    await deltaIngest.processDocument({
      projectId: "proj_g",
      fileId: 701,
      document: docOriginal,
      approved: true,
    });

    assert.equal(embedder.getCallCount(), 1);

    // Same content with redundant whitespace, blank lines, and line endings
    const docFormatted = `   #    Data Ingestion Pipeline Architecture   \r\n\r\n\r\n
System must support 100 concurrent streams with <50ms latency.    \r\n`;

    const res = await deltaIngest.processDocument({
      projectId: "proj_g",
      fileId: 702,
      document: docFormatted,
      approved: true,
    });

    assert.equal(res.summary.unchanged_features, 1);
    assert.equal(res.summary.modified_features, 0);
    assert.equal(res.summary.embeddings_reused, 1);
    assert.equal(res.summary.embeddings_created, 0);
    assert.equal(embedder.getCallCount(), 1, "Zero new embeddings generated for formatting-only changes");
  });

  // -------------------------------------------------------------------------
  // Scenario H: MEANINGFUL CONTENT CHANGE
  // -------------------------------------------------------------------------
  test("Scenario H: Meaningful changes (numbers, negations) produce different hashes and classify as MODIFIED", async () => {
    // 1. Numeric change
    const h1 = computeContentHash("System must support 100 concurrent users.");
    const h2 = computeContentHash("System must support 1,000 concurrent users.");
    assert.notEqual(h1.content_hash, h2.content_hash, "Numeric differences must change hash");

    // 2. Negation change
    const h3 = computeContentHash("Authentication is required for this endpoint.");
    const h4 = computeContentHash("Authentication is not required for this endpoint.");
    assert.notEqual(h3.content_hash, h4.content_hash, "Negation must change hash");

    // Integration test with deltaIngest
    const { db, ragStore, temporalStore, featureRegistry } = setupTestContext();
    const embedder = createMockEmbedder();
    const deltaIngest = createDeltaIngest({ db, ragStore, temporalStore, featureRegistry, embedder });

    await deltaIngest.processDocument({
      projectId: "proj_h",
      fileId: 801,
      document: `# Data Ingestion Pipeline Architecture\nThroughput limit is 100 req/sec.`,
      approved: true,
    });

    const resMod = await deltaIngest.processDocument({
      projectId: "proj_h",
      fileId: 802,
      document: `# Data Ingestion Pipeline Architecture\nThroughput limit is 1,000 req/sec.`,
      approved: true,
    });

    assert.equal(resMod.summary.modified_features, 1);
    assert.equal(resMod.changes[0].classification, "MODIFIED");
    assert.notEqual(resMod.changes[0].content_hash, h1.content_hash);
  });

  // -------------------------------------------------------------------------
  // Scenario I: EMBEDDING FAILURE
  // -------------------------------------------------------------------------
  test("Scenario I: Embedding failure aborts version transition without corrupting active records", async () => {
    const { db, ragStore, temporalStore, featureRegistry } = setupTestContext();
    const workingEmbedder = createMockEmbedder();
    const deltaIngestNormal = createDeltaIngest({
      db,
      ragStore,
      temporalStore,
      featureRegistry,
      embedder: workingEmbedder,
    });

    // Ingest baseline successfully
    await deltaIngestNormal.processDocument({
      projectId: "proj_i",
      fileId: 901,
      document: `# Data Ingestion Pipeline Architecture\nBaseline version text.`,
      approved: true,
    });

    const activeBefore = temporalStore.getActiveFeatureChunks("proj_i", "feat:ingestion_pipeline")[0];
    assert.ok(activeBefore);

    // Attempt modification with a failing embedder
    const failingEmbedder = createMockEmbedder({ failOnCall: true });
    const deltaIngestFailing = createDeltaIngest({
      db,
      ragStore,
      temporalStore,
      featureRegistry,
      embedder: failingEmbedder,
    });

    const res = await deltaIngestFailing.processDocument({
      projectId: "proj_i",
      fileId: 902,
      document: `# Data Ingestion Pipeline Architecture\nUpdated modified version text that should fail.`,
      approved: true,
    });

    assert.equal(res.status, "error");
    assert.ok(res.errors.length > 0);
    assert.match(res.errors[0], /Simulated embedding network failure/);

    // Verify baseline chunk remains active and was NOT superseded
    const activeAfter = temporalStore.getActiveFeatureChunks("proj_i", "feat:ingestion_pipeline")[0];
    assert.equal(activeAfter.id, activeBefore.id);
    assert.equal(activeAfter.lifecycle_status, "active");
    assert.equal(activeAfter.valid_to, null);
  });

  // -------------------------------------------------------------------------
  // Scenario J: DATABASE TRANSACTION FAILURE
  // -------------------------------------------------------------------------
  test("Scenario J: Database transaction failure rolls back cleanly leaving predecessor authoritative", async () => {
    const { db, ragStore, temporalStore, featureRegistry } = setupTestContext();
    const embedder = createMockEmbedder();

    // Mock temporalStore with a sabotaged activateSuccessorVersion that throws
    const failingTemporal = {
      ...temporalStore,
      activateSuccessorVersion: () => {
        throw new Error("Simulated SQLite constraint failure during version activation");
      },
    };

    // First create baseline using valid temporal store
    const deltaIngestInit = createDeltaIngest({
      db,
      ragStore,
      temporalStore,
      featureRegistry,
      embedder,
    });
    await deltaIngestInit.processDocument({
      projectId: "proj_j",
      fileId: 1001,
      document: `# Data Ingestion Pipeline Architecture\nBaseline text.`,
      approved: true,
    });

    const activeBefore = temporalStore.getActiveFeatureChunks("proj_j", "feat:ingestion_pipeline")[0];

    // Attempt modification using failing temporal store
    const deltaIngestFailing = createDeltaIngest({
      db,
      ragStore,
      temporalStore: failingTemporal,
      featureRegistry,
      embedder,
    });

    const res = await deltaIngestFailing.processDocument({
      projectId: "proj_j",
      fileId: 1002,
      document: `# Data Ingestion Pipeline Architecture\nModified text triggering failure.`,
      approved: true,
    });

    assert.equal(res.status, "error");
    assert.ok(res.errors[0].includes("Simulated SQLite constraint failure"));

    // Predecessor must still be active and unchanged
    const activeAfter = temporalStore.getActiveFeatureChunks("proj_j", "feat:ingestion_pipeline")[0];
    assert.equal(activeAfter.id, activeBefore.id);
    assert.equal(activeAfter.lifecycle_status, "active");
  });

  // -------------------------------------------------------------------------
  // Scenario K: DRY RUN
  // -------------------------------------------------------------------------
  test("Scenario K: Dry-run calculates delta report without writing to DB or invoking embedder", async () => {
    const { db, ragStore, temporalStore, featureRegistry } = setupTestContext();
    const embedder = createMockEmbedder();
    const deltaIngest = createDeltaIngest({ db, ragStore, temporalStore, featureRegistry, embedder });

    const doc = `
# Data Ingestion Pipeline Architecture
Real-time streaming pipeline specification.
`;

    const res = await deltaIngest.processDocument({
      projectId: "proj_k",
      fileId: 1101,
      document: doc,
      approved: true,
      dryRun: true,
    });

    assert.equal(res.status, "dry_run");
    assert.equal(res.summary.new_features, 1);
    assert.equal(res.changes[0].action_taken, "dry_run_proposed");
    assert.equal(embedder.getCallCount(), 0, "Embedder must not be called during dry-run");

    // Zero chunks in DB
    const chunks = temporalStore.getActiveFeatureChunks("proj_k", "feat:ingestion_pipeline");
    assert.equal(chunks.length, 0, "No chunks written to DB during dry-run");
  });

  // -------------------------------------------------------------------------
  // Scenario L: LEGACY COMPATIBILITY
  // -------------------------------------------------------------------------
  test("Scenario L: Legacy chunks with NULL feature_id remain searchable alongside temporal chunks", async () => {
    const { db, ragStore, temporalStore, featureRegistry } = setupTestContext();
    const embedder = createMockEmbedder();
    const deltaIngest = createDeltaIngest({ db, ragStore, temporalStore, featureRegistry, embedder });

    // Insert a legacy chunk directly into copilot_chunks (feature_id = NULL)
    db.prepare(`
      INSERT INTO copilot_chunks (file_id, project_id, ord, text, meta, embed, hash, dims, vec, feature_id, lifecycle_status)
      VALUES (999, 'proj_l', 0, 'Legacy user guide documentation about billing', '{}', 'text', 'hash_legacy', 4, ?, NULL, 'active')
    `).run(Buffer.alloc(16));
    db.prepare(`INSERT INTO copilot_chunks_fts (rowid, text) VALUES (1, 'Legacy user guide documentation about billing')`).run();

    // Now ingest a canonical feature chunk using deltaIngest
    await deltaIngest.processDocument({
      projectId: "proj_l",
      fileId: 1201,
      document: `# Data Ingestion Pipeline Architecture\nIngestion pipeline for billing streams.`,
      approved: true,
    });

    // FTS keyword search finds both legacy and temporal chunks
    const hits = ragStore.keyword("proj_l", "billing");
    assert.ok(hits.length >= 2, "Keyword search must find both legacy and temporal chunks");

    // All chunks count
    assert.equal(ragStore.chunkCount("proj_l"), 2);
  });
});
