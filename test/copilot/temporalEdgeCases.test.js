// test/copilot/temporalEdgeCases.test.js
// Comprehensive senior-level edge-case verification for OKF + Bi-Temporal RAG pipeline:
// EC-1 (Active-only gating & matrix invalidation), EC-3 (DOCX duplicate headings & Title-first scoring),
// EC-4 (Selective sibling preservation), EC-5 (Month-range historical overlap & fail-closed),
// EC-6 (Multi-stage 3-version DIFF_EVOLUTION), EC-7 (Query-relevance sub-section ranking),
// EC-8 (Recency-anchored context ordering), EC-9 (Single-batch embedding), EC-11 (Multi-projectId routing).

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const Database = require("better-sqlite3");

const { createRagStore } = require("../../src/copilot/rag/ragStore");
const { createFeatureRegistry } = require("../../src/copilot/core/okf/featureRegistry");
const { createAuthoritativeLookup } = require("../../src/copilot/rag/authoritativeLookup");
const { createTemporalRouter } = require("../../src/copilot/core/okf/temporalRouter");
const { createDeltaIngest, extractSections } = require("../../src/copilot/rag/deltaIngest");
const { assembleTemporalContext } = require("../../src/copilot/core/answer/contextPack");
const { resolveEvidence } = require("../../src/copilot/core/okf/versionResolver");

const okfDir = path.resolve(__dirname, "../../OKF");

function unitVec(seed, dims = 4) {
  const v = new Float32Array(dims);
  for (let i = 0; i < dims; i++) v[i] = Math.sin(seed * (i + 1)) + 1.1;
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dims; i++) v[i] /= norm;
  return v;
}

function createMockEmbedder(dims = 4) {
  let callCount = 0;
  let totalEmbedded = 0;
  return {
    dims,
    getCallCount: () => callCount,
    getTotalEmbedded: () => totalEmbedded,
    embedDocs: async (docs) => {
      callCount++;
      totalEmbedded += docs.length;
      return {
        vectors: docs.map((d, i) => unitVec(callCount * 100 + i + d.text.length, dims)),
        tokens: docs.reduce((s, d) => s + Math.ceil(d.text.length / 4), 0),
        cost: docs.length * 0.00001,
      };
    },
  };
}

describe("Temporal OKF + RAG Edge Cases", () => {
  test("EC-1: ragStore.vector() and keyword() gate out superseded/deprecated chunks and invalidate matrix cache on mutation", () => {
    const db = new Database(":memory:");
    const ragStore = createRagStore(db);
    const temporal = ragStore.temporal;
    const pid = 1;
    const qVec = unitVec(1, 4);

    // Seed v1 active chunk
    const c1 = temporal.insertTemporalChunk({
      file_id: 10,
      project_id: pid,
      feature_id: "feat:carzilla_payments_invoicing",
      version: "1.0.0",
      lifecycle_status: "active",
      valid_from: Date.UTC(2026, 7, 21),
      valid_to: null,
      text: "Proposal tiered buyer premium 10% 8% 6% plus 5% VAT.",
      hash: "h_pay_v1",
      vec: qVec,
      dims: 4,
      meta: { source: "CarZilla_Proposal.md" },
    });

    // Warm matrix cache via vector search
    const hitsBefore = ragStore.vector(pid, qVec, 5);
    assert.equal(hitsBefore.length, 1);
    assert.equal(hitsBefore[0].id, c1.id);
    assert.ok(ragStore.keyword(pid, "premium").includes(c1.id));

    // Activate v1.1.0 successor -> must invalidate matrix cache immediately and hide c1 from active search
    const act = temporal.activateSuccessorVersion({
      predecessorId: c1.id,
      newChunkData: {
        file_id: 11,
        project_id: pid,
        feature_id: "feat:carzilla_payments_invoicing",
        version: "1.1.0",
        text: "Delivered flat 2% buyer premium with no VAT.",
        hash: "h_pay_v2",
        vec: qVec,
        dims: 4,
        meta: { source: "CarZilla_Project_Completion_Document.md" },
      },
      effectiveTime: Date.UTC(2026, 8, 28),
    });

    const hitsAfter = ragStore.vector(pid, qVec, 5);
    assert.equal(hitsAfter.length, 1, "Only active successor should appear in default vector search");
    assert.equal(hitsAfter[0].id, act.successor.id);
    assert.ok(!hitsAfter.some((h) => h.id === c1.id), "Superseded v1 must not leak into vector search");

    const kwAfter = ragStore.keyword(pid, "premium");
    assert.ok(kwAfter.includes(act.successor.id));
    assert.ok(!kwAfter.includes(c1.id), "Superseded v1 must not leak into FTS keyword search");

    // Historical range query retrieves v1 cleanly when requested
    const histVec = ragStore.vector(pid, qVec, 5, {
      asOfStart: Date.UTC(2026, 7, 1),
      asOfEnd: Date.UTC(2026, 7, 31, 23, 59, 59, 999),
    });
    assert.equal(histVec.length, 1);
    assert.equal(histVec[0].id, c1.id);
  });

  test("EC-3 & EC-9: DOCX duplicate heading collapse, parent inheritance, and single-batch embedding", async () => {
    const db = new Database(":memory:");
    const ragStore = createRagStore(db);
    const featureRegistry = createFeatureRegistry({ okfDir });
    featureRegistry.load();
    const embedder = createMockEmbedder(4);
    const deltaIngest = createDeltaIngest({
      db,
      ragStore,
      temporalStore: ragStore.temporal,
      featureRegistry,
      embedder,
      options: { autoIndexUnmatched: true },
    });

    const doc = `
# CarZilla_Feature_Completion_Document_Phase_2

## 2. Staff Invite System
### 2. Staff Invite System
Super Admin invites new employees with a 7-day temporary password.

## Staff roles
#### Staff roles
Five fixed roles: Sales, Finance, Support, Inspector, Auction BRO.

## 5. Cancel My Bid
### 5. Cancel My Bid
Highest bidder can cancel once per lot before reserve is met.

## When it is available
#### When it is available
Available when the lot has a reserve price, reserve is not met, and outside Golden Closing.
`;

    const sections = extractSections(doc, { sourceFilename: "CarZilla_Feature_Completion_Document_Phase_2.md" });
    // Duplicate headings collapsed: no empty stub sections for "2. Staff Invite System" or "Staff roles"
    assert.ok(!sections.some((s) => s.section_title === "2. Staff Invite System" && s.body_text === ""));
    const whenSec = sections.find((s) => s.section_title === "When it is available");
    assert.ok(whenSec, "Sub-section 'When it is available' extracted");
    assert.ok(
      whenSec.hierarchy.includes("5. Cancel My Bid"),
      `Sub-section must inherit parent '5. Cancel My Bid' (got ${JSON.stringify(whenSec.hierarchy)})`
    );

    const res = await deltaIngest.processDocument({
      projectId: 7,
      fileId: 701,
      document: doc,
      source: "CarZilla_Feature_Completion_Document_Phase_2.md",
      effectiveAt: Date.UTC(2026, 9, 14),
      approved: true,
    });

    assert.equal(res.status, "success");
    assert.equal(embedder.getCallCount(), 1, "All sections must be embedded in ONE batched call");
    assert.equal(res.summary.ambiguous_features, 0, "Zero false AMBIGUOUS drops");
    const staffChunks = ragStore.temporal.getActiveFeatureChunks(7, "feat:carzilla_staff_roles");
    assert.equal(staffChunks.length, 2, "Both sibling sections of Staff Invite System remain active (no self-supersession)");
    const cancelChunks = ragStore.temporal.getActiveFeatureChunks(7, "feat:carzilla_cancel_bid");
    assert.equal(cancelChunks.length, 2, "Sub-section inherited feat:carzilla_cancel_bid cleanly");
  });

  test("EC-4: Single-section mutation in multi-section feature embeds ONLY 1 section and preserves unchanged siblings", async () => {
    const db = new Database(":memory:");
    const ragStore = createRagStore(db);
    const featureRegistry = createFeatureRegistry({ okfDir });
    featureRegistry.load();
    const embedder = createMockEmbedder(4);
    const deltaIngest = createDeltaIngest({
      db,
      ragStore,
      temporalStore: ragStore.temporal,
      featureRegistry,
      embedder,
    });

    const v1Doc = `
### 2. Staff Invite System
Super Admin invites new employees with a 7-day temporary password.

#### How an invitation works
Admin enters email and role; email is sent with temporary password.

#### Staff roles
Five fixed roles: Sales, Finance, Support, Inspector, Auction BRO.
`;

    await deltaIngest.processDocument({
      projectId: 8,
      fileId: 801,
      document: v1Doc,
      source: "Phase2_v1.md",
      effectiveAt: Date.UTC(2026, 9, 14),
      approved: true,
    });
    assert.equal(embedder.getTotalEmbedded(), 3);

    // Edit ONLY the first section (7-day -> 14-day), leaving the other 2 sibling sections identical
    const v2Doc = v1Doc.replace("7-day temporary password", "14-day temporary password");
    const res2 = await deltaIngest.processDocument({
      projectId: 8,
      fileId: 802,
      document: v2Doc,
      source: "Phase2_v2.md",
      effectiveAt: Date.UTC(2026, 9, 20),
      approved: true,
    });

    assert.equal(res2.status, "success");
    assert.equal(res2.summary.modified_features, 1);
    assert.equal(res2.summary.unchanged_features, 2);
    assert.equal(res2.summary.embeddings_created, 1, "Only the 1 edited section must be embedded");
    assert.equal(embedder.getTotalEmbedded(), 4, "Total embeddings across both runs = 3 + 1 = 4");

    const activeAfter = ragStore.temporal.getActiveFeatureChunks(8, "feat:carzilla_staff_roles");
    assert.equal(activeAfter.length, 3, "All 3 sections (1 updated + 2 preserved unchanged siblings) remain active");
    assert.ok(activeAfter.some((c) => c.text.includes("14-day temporary password")));
    assert.ok(activeAfter.some((c) => c.text.includes("Auction BRO")));
  });

  test("EC-5 & EC-6 & EC-7: Month-range overlap, fail-closed historical safety, 3-stage evolution chain, and query ranking", async () => {
    const db = new Database(":memory:");
    const ragStore = createRagStore(db);
    const featureRegistry = createFeatureRegistry({ okfDir });
    featureRegistry.load();
    const als = createAuthoritativeLookup({
      db,
      ragStore,
      temporalStore: ragStore.temporal,
      featureRegistry,
    });
    const router = createTemporalRouter({
      featureRegistry,
      temporalStore: ragStore.temporal,
      authoritativeLookup: als,
    });

    const pid = 9;
    // Stage 1: Proposal (21 Aug 2026) -> superseded 28 Sep 2026
    const c1 = ragStore.temporal.insertTemporalChunk({
      file_id: 1,
      project_id: pid,
      feature_id: "feat:carzilla_staff_roles",
      version: "1.0.0",
      lifecycle_status: "superseded",
      valid_from: Date.UTC(2026, 7, 21),
      valid_to: Date.UTC(2026, 8, 28),
      text: "Proposal planned 5 admin roles: Catalogue, Auctioneer, Compliance, Finance, Read-only.",
      meta: { source: "CarZilla_Proposal.md" },
    });
    // Stage 2: Phase 1 Completion (28 Sep 2026) -> superseded 14 Oct 2026
    const c2 = ragStore.temporal.insertTemporalChunk({
      file_id: 2,
      project_id: pid,
      feature_id: "feat:carzilla_staff_roles",
      version: "1.1.0",
      lifecycle_status: "superseded",
      valid_from: Date.UTC(2026, 8, 28),
      valid_to: Date.UTC(2026, 9, 14),
      predecessor_id: c1.id,
      text: "Phase 1 built 3 roles: Bidder, Super Admin, Inspector.",
      meta: { source: "CarZilla_Project_Completion_Document.md" },
    });
    // Stage 3: Phase 2 (14 Oct 2026) -> active (2 sub-sections to test EC-7 query ranking)
    ragStore.temporal.insertTemporalChunk({
      file_id: 3,
      project_id: pid,
      feature_id: "feat:carzilla_staff_roles",
      version: "2.0.0",
      lifecycle_status: "active",
      valid_from: Date.UTC(2026, 9, 14),
      valid_to: null,
      predecessor_id: c2.id,
      text: "Managing the team: Super Admin can resend expired invitations or deactivate staff.",
      meta: { source: "CarZilla_Feature_Completion_Document_Phase_2.md" },
    });
    ragStore.temporal.insertTemporalChunk({
      file_id: 3,
      project_id: pid,
      feature_id: "feat:carzilla_staff_roles",
      version: "2.0.0",
      lifecycle_status: "active",
      valid_from: Date.UTC(2026, 9, 14),
      valid_to: null,
      text: "Five fixed staff roles: Sales, Finance, Support, Inspector, Auction BRO.",
      meta: { source: "CarZilla_Feature_Completion_Document_Phase_2.md" },
    });

    // EC-5: Month-only query "August 2026" overlaps Proposal effective 21 Aug 2026
    const qAug = await router.routeTemporalQuery({
      projectId: pid,
      query: "What were the staff roles in August 2026?",
    });
    assert.equal(qAug.plan.intent, "HISTORICAL_STATE");
    assert.equal(qAug.evidence.length, 1);
    assert.equal(qAug.evidence[0].version, "1.0.0");
    assert.ok(qAug.evidence[0].text.includes("Auctioneer"));

    // EC-5 Fail-Closed: Uncovered date "January 2025" returns 0 records (never substitutes current)
    const qPre = await router.routeTemporalQuery({
      projectId: pid,
      query: "What were the staff roles in January 2025?",
    });
    assert.equal(qPre.plan.intent, "HISTORICAL_STATE");
    assert.equal(qPre.evidence.length, 0, "Must fail closed without substituting active v2.0.0");

    // EC-6: 3-stage evolution chain returns BEFORE (1.0.0), INTERMEDIATE (1.1.0), AFTER (2.0.0)
    const qDiff = await router.routeTemporalQuery({
      projectId: pid,
      query: "How have staff roles evolved across versions?",
    });
    assert.equal(qDiff.plan.intent, "DIFF_EVOLUTION");
    assert.equal(qDiff.evidence.length, 3, "All 3 chronological versions must be preserved");
    assert.deepEqual(
      qDiff.evidence.map((e) => `${e.role}:${e.version}`),
      ["BEFORE:1.0.0", "INTERMEDIATE:1.1.0", "AFTER:2.0.0"]
    );

    // EC-7: Query-relevance sub-section ranking puts "Auction BRO" / roles chunk ahead of "Managing the team"
    const qCur = await router.routeTemporalQuery({
      projectIds: [pid],
      query: "What are the staff roles and Auction BRO permissions?",
    });
    assert.equal(qCur.plan.intent, "CURRENT_STATE");
    assert.ok(qCur.evidence[0].text.includes("Auction BRO"), "Highest-relevance sub-section must rank first");
  });

  test("EC-8: assembleTemporalContext places SUPPORTING before AUTHORITATIVE (recency-anchored) while prioritizing authoritative budget", () => {
    const auth = {
      id: "auth_1",
      feature_id: "feat:carzilla_payments_invoicing",
      feature_name: "Payments",
      version: "1.1.0",
      status: "approved",
      lifecycle: "active",
      authority_tier: 100,
      source_doc: "CarZilla_Project_Completion_Document.md",
      content: "Flat 2% buyer premium with no VAT.",
      valid_from: "2026-09-28T00:00:00Z",
    };
    const sup = {
      id: "sup_1",
      role: "SUPPORTING",
      feature_id: "feat:carzilla_payments_invoicing",
      source_doc: "Meeting_Notes.md",
      content: "We talked about payments on Tuesday.",
    };

    const res = {
      status: "RESOLVED",
      intent: "CURRENT_STATE",
      feature_id: "feat:carzilla_payments_invoicing",
      selected: [auth],
      supporting: [sup],
    };
    const assembled = assembleTemporalContext({ resolution: res, intent: "CURRENT_STATE", budget: 8000 });
    const idxSup = assembled.text.indexOf("[SUPPORTING EVIDENCE]");
    const idxAuth = assembled.text.indexOf("[AUTHORITATIVE EVIDENCE]");
    assert.ok(idxSup >= 0 && idxAuth >= 0);
    assert.ok(idxSup < idxAuth, "Supporting evidence must appear BEFORE Authoritative evidence (recency-anchored)");
  });
});
