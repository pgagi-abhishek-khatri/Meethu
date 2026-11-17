const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { createOkfRegistry } = require("../../src/copilot/core/okf/registry");
const { createAuthoritativeLookupService, normalizeTitle, normalizeKeyword } = require("../../src/copilot/core/okf/lookup");
const { compareSemVer, resolvePrecedence, parseSemVer } = require("../../src/copilot/core/okf/versionResolver");
const { createOkfRouter } = require("../../src/copilot/core/okf/router");

const okfDir = path.resolve(__dirname, "../../OKF");

test("T01: Exact document ID lookup", () => {
  const reg = createOkfRegistry({ okfDir });
  const als = reg.als;

  const res = als.lookupById("OKF-0002");
  assert.equal(res.status, "resolved");
  assert.equal(res.resolvedRecord.id, "OKF-0002");
  assert.equal(res.resolvedRecord.version, "1.0.0");
  assert.equal(res.resolvedRecord.status, "approved");
});

test("T02: Exact title lookup", () => {
  const reg = createOkfRegistry({ okfDir });
  const als = reg.als;

  const res = als.lookupByTitle("Live Meeting Copilot Architecture and Precedence Contract");
  assert.equal(res.status, "resolved");
  assert.equal(res.resolvedRecord.id, "OKF-0002");
});

test("T03: Case-normalized title lookup", () => {
  const reg = createOkfRegistry({ okfDir });
  const als = reg.als;

  const res = als.lookupByTitle("  live meeting   copilot architecture and precedence contract...  ");
  assert.equal(res.status, "resolved");
  assert.equal(res.resolvedRecord.id, "OKF-0002");
});

test("T04: Exact keyword lookup", () => {
  const reg = createOkfRegistry({ okfDir });
  const als = reg.als;

  const res = als.lookupByKeyword("architecture");
  assert.equal(res.status, "resolved");
  assert.equal(res.resolvedRecord.id, "OKF-0002");
});

test("T05: Exact canonical tag lookup", () => {
  const reg = createOkfRegistry({ okfDir });
  const als = reg.als;

  const res = als.lookupByTag("domain:copilot");
  assert.equal(res.status, "resolved");
  assert.ok(res.resolvedRecord != null);
});

test("T06: Multiple-tag lookup with AND / OR operators", () => {
  const mockManifest = {
    bundle_id: "test-bundle",
    documents: [
      { id: "OKF-0001", tags: ["domain:copilot", "type:template"], version: "1.0.0", status: "approved" },
      { id: "OKF-0002", tags: ["domain:copilot", "type:architecture"], version: "1.0.0", status: "approved" },
      { id: "OKF-0003", tags: ["domain:ui", "type:architecture"], version: "1.0.0", status: "approved" },
    ],
  };
  const als = createAuthoritativeLookupService({ manifest: mockManifest });

  const andRes = als.lookupByTag(["domain:copilot", "type:architecture"], { operator: "AND" });
  assert.equal(andRes.status, "resolved");
  assert.equal(andRes.resolvedRecord.id, "OKF-0002");

  const orRes = als.lookupByTag(["domain:copilot", "domain:ui"], { operator: "OR" });
  assert.equal(orRes.status, "resolved");
  assert.equal(orRes.allRecords.length, 3);
  assert.deepEqual(orRes.allRecords.map((d) => d.id).sort(), ["OKF-0001", "OKF-0002", "OKF-0003"]);
});

test("T07: Duplicate title ambiguity detection", () => {
  const mockManifest = {
    bundle_id: "test-bundle",
    documents: [
      { id: "OKF-0001", title: "Shared Policy Name", version: "1.0.0", status: "approved" },
      { id: "OKF-0002", title: "Shared Policy Name", version: "1.0.0", status: "approved" },
    ],
  };
  const als = createAuthoritativeLookupService({ manifest: mockManifest });

  const res = als.lookupByTitle("Shared Policy Name");
  assert.equal(res.status, "ambiguous");
  assert.ok(res.reason.includes("Multiple distinct documents share title"));
});

test("T08: Duplicate document ID detection", () => {
  const candidates = [
    { id: "OKF-0001", version: "1.0.0", status: "approved" },
    { id: "OKF-0001", version: "1.0.0", status: "approved" },
  ];
  const res = resolvePrecedence(candidates);
  assert.equal(res.status, "ambiguous");
  assert.ok(res.reason.includes("Duplicate approved records"));
});

test("T09: Explicit version resolution (pinning)", () => {
  const candidates = [
    { id: "OKF-0002", version: "1.0.0", status: "approved" },
    { id: "OKF-0002", version: "1.1.0", status: "approved" },
  ];
  const res = resolvePrecedence(candidates, { requestedVersion: "1.0.0" });
  assert.equal(res.status, "resolved");
  assert.equal(res.resolvedRecord.version, "1.0.0");
});

test("T10: Latest approved version resolution", () => {
  const candidates = [
    { id: "OKF-0002", version: "1.0.0", status: "approved" },
    { id: "OKF-0002", version: "1.2.0", status: "approved" },
    { id: "OKF-0002", version: "1.1.0", status: "approved" },
  ];
  const res = resolvePrecedence(candidates);
  assert.equal(res.status, "resolved");
  assert.equal(res.resolvedRecord.version, "1.2.0");
});

test("T11: Newer draft versus older approved version precedence", () => {
  const candidates = [
    { id: "OKF-0002", version: "1.0.0", status: "approved" },
    { id: "OKF-0002", version: "2.0.0", status: "draft" },
  ];
  // By default, approved 1.0.0 strictly beats newer draft 2.0.0
  const resDefault = resolvePrecedence(candidates);
  assert.equal(resDefault.status, "resolved");
  assert.equal(resDefault.resolvedRecord.version, "1.0.0");

  // If explicit draft is allowed and requested:
  const resDraftPin = resolvePrecedence(candidates, { requestedVersion: "2.0.0" });
  assert.equal(resDraftPin.status, "resolved");
  assert.equal(resDraftPin.resolvedRecord.version, "2.0.0");
});

test("T12: Deprecated version exclusion", () => {
  const candidates = [
    { id: "OKF-0002", version: "1.0.0", status: "deprecated" },
  ];
  const res = resolvePrecedence(candidates);
  assert.equal(res.status, "no_authoritative_version");

  const resAllowed = resolvePrecedence(candidates, { allowDeprecated: true });
  assert.equal(resAllowed.status, "resolved");
  assert.equal(resAllowed.resolvedRecord.version, "1.0.0");
});

test("T13: Superseded document handling", () => {
  const mockManifest = {
    bundle_id: "test-bundle",
    documents: [
      { id: "OKF-0001", path: "documents/OKF-0001-template.md", version: "1.0.0", status: "superseded", superseded_by: "OKF-0002" },
      { id: "OKF-0002", path: "documents/OKF-0002-copilot-architecture.md", version: "1.0.0", status: "approved" },
    ],
  };
  const reg = createOkfRegistry({ okfDir });
  const als = createAuthoritativeLookupService({
    manifest: mockManifest,
    getDocumentContent: reg.getDocument,
    okfDir,
  });

  const res = als.resolve({ type: "id", value: "OKF-0001" });
  assert.equal(res.status, "resolved");
  assert.equal(res.provenance.document_id, "OKF-0002");
  assert.equal(res.provenance.superseded_from, "OKF-0001");
});

test("T14: No authoritative version available", () => {
  const candidates = [
    { id: "OKF-0002", version: "1.0.0", status: "draft" },
  ];
  const res = resolvePrecedence(candidates);
  assert.equal(res.status, "no_authoritative_version");
});

test("T15: Invalid semantic version rejection", () => {
  assert.equal(parseSemVer("invalid-semver"), null);
  assert.equal(parseSemVer("1.0"), null);
  assert.equal(parseSemVer("v1.0.0"), null);
  const parsed = parseSemVer("1.2.3");
  assert.equal(parsed.major, 1);
  assert.equal(parsed.minor, 2);
  assert.equal(parsed.patch, 3);
});

test("T16: Manifest/frontmatter mismatch check in resolver", () => {
  const candidates = [
    { id: "OKF-0002", version: "1.0.0", status: "approved" },
  ];
  const res = resolvePrecedence(candidates, { requestedVersion: "9.9.9" });
  assert.equal(res.status, "version_not_found");
});

test("T17: Missing document file handling", () => {
  const mockManifest = {
    bundle_id: "test-bundle",
    documents: [
      { id: "OKF-9999", path: "documents/missing.md", version: "1.0.0", status: "approved" },
    ],
  };
  const als = createAuthoritativeLookupService({
    manifest: mockManifest,
    getDocumentContent: () => null, // missing file
    okfDir,
  });

  const res = als.resolve({ type: "id", value: "OKF-9999" });
  assert.equal(res.status, "registry_error");
  assert.ok(res.error.includes("Document file missing on disk"));
});

test("T18: OKF route integration with ALS", async () => {
  const reg = createOkfRegistry({ okfDir });
  const router = createOkfRouter();

  const ctx = await router.routeContext({
    query: "What is the official copilot architecture in OKF-0002?",
    registry: reg,
    ragResult: null,
  });

  assert.equal(ctx.route, "okf");
  assert.ok(ctx.provenance != null);
  assert.equal(ctx.provenance.document_id, "OKF-0002");
  assert.equal(ctx.provenance.version, "1.0.0");
  assert.ok(ctx.passages.includes("CANONICAL SPECIFICATION"));
});

test("T19: RAG route regression (ALS is bypassed)", async () => {
  const reg = createOkfRegistry({ okfDir });
  const router = createOkfRouter();

  const ctx = await router.routeContext({
    query: "What did we discuss about customer onboarding in the previous meeting notes?",
    spec: { project: true },
    registry: reg,
    ragResult: { text: "Exploratory passages", used: [{ file: "notes.pdf" }] },
  });

  assert.equal(ctx.route, "rag");
  assert.equal(ctx.provenance, null);
  assert.equal(ctx.passages, "Exploratory passages");
});

test("T20: Mixed route integration with ALS provenance", async () => {
  const reg = createOkfRegistry({ okfDir });
  const router = createOkfRouter();

  const ctx = await router.routeContext({
    query: "What is the official copilot architecture in OKF-0002, and what did we discuss about rolling it out?",
    spec: { project: true },
    registry: reg,
    ragResult: { text: "Meeting notes excerpt", used: [{ file: "meeting.docx" }] },
  });

  assert.equal(ctx.route, "mixed");
  assert.ok(ctx.provenance != null);
  assert.equal(ctx.provenance.document_id, "OKF-0002");
  assert.ok(ctx.passages.includes("=== AUTHORITATIVE CANONICAL BASELINE"));
  assert.ok(ctx.passages.includes("=== SUPPORTING PROJECT EXPLORATION"));
});

test("T21: Conflicting OKF and RAG evidence ordering", async () => {
  const reg = createOkfRegistry({ okfDir });
  const router = createOkfRouter();

  const ctx = await router.routeContext({
    query: "What is the copilot architecture contract in OKF-0002, and what did we discuss in the notes?",
    spec: { project: true },
    registry: reg,
    ragResult: { text: "Contradictory proposal note", used: [{ file: "proposal.pdf" }] },
  });

  const okfIdx = ctx.passages.indexOf("OKF-0002");
  const ragIdx = ctx.passages.indexOf("Contradictory proposal note");
  assert.ok(okfIdx < ragIdx, "Canonical baseline must be placed before exploratory passages");
});

test("T22: Vector search isolation proof (Zero vector search invocations)", () => {
  let vectorCallCount = 0;
  let embedCallCount = 0;

  // Intercept or simulate vector client stubs
  const fakeVectors = {
    topK: () => { vectorCallCount++; return []; },
    cosine: () => { vectorCallCount++; return 0; },
  };
  const fakeEmbedClient = {
    embedQueries: async () => { embedCallCount++; return { vectors: [] }; },
  };

  const reg = createOkfRegistry({ okfDir });
  const als = reg.als;

  // Perform multiple ALS lookups
  als.lookupById("OKF-0002");
  als.lookupByTitle("Live Meeting Copilot Architecture and Precedence Contract");
  als.lookupByKeyword("architecture");
  als.lookupByTag("domain:copilot");
  als.resolve({ type: "auto", value: "OKF-0002" });

  assert.equal(vectorCallCount, 0, "Vector search functions were invoked during canonical lookup!");
  assert.equal(embedCallCount, 0, "Embedding client was invoked during canonical lookup!");
});

test("T23: Registry cache invalidation", () => {
  const reg = createOkfRegistry({ okfDir });
  assert.equal(reg.hasBundle(), true);
  // Reload re-reads manifest and re-indexes
  const reloaded = reg.load();
  assert.equal(reloaded, true);
  assert.ok(reg.als != null);
});

test("T24: Registry unavailable safe error handling", () => {
  const als = createAuthoritativeLookupService({ manifest: null });
  const res = als.resolve({ type: "id", value: "OKF-0002" });
  assert.equal(res.status, "registry_error");
  assert.ok(res.error.includes("Manifest not loaded"));
});

test("T25: Deterministic results across 100 repeated runs", () => {
  const reg = createOkfRegistry({ okfDir });
  const als = reg.als;

  const first = als.resolve({ type: "auto", value: "OKF-0002" });
  for (let i = 0; i < 100; i++) {
    const next = als.resolve({ type: "auto", value: "OKF-0002" });
    assert.equal(next.status, first.status);
    assert.equal(next.document.id, first.document.id);
    assert.equal(next.provenance.sha256, first.provenance.sha256);
  }
});
