const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { createOkfRegistry } = require("../../src/copilot/core/okf/registry");
const { createOkfRouter } = require("../../src/copilot/core/okf/router");

const okfDir = path.resolve(__dirname, "../../OKF");

test("Registry loads manifest and indexes documents correctly", () => {
  const reg = createOkfRegistry({ okfDir });
  assert.equal(reg.hasBundle(), true);
  const manifest = reg.getManifest();
  assert.equal(manifest.bundle_id, "openwhispr-canonical-v1");
  const docs = reg.getDocuments();
  assert.ok(docs.length >= 2);

  const doc = reg.getDocument("OKF-0002");
  assert.ok(doc != null);
  assert.equal(doc.id, "OKF-0002");
  assert.equal(doc.status, "approved");
  assert.ok(doc.body.includes("Live Meeting Copilot Architecture"));
});

test("Test 1: Query answerable exclusively from canonical OKF documentation -> okf", () => {
  const reg = createOkfRegistry({ okfDir });
  const router = createOkfRouter();

  const res = router.classifyQuery({
    query: "What is the official copilot architecture in OKF-0002?",
    registry: reg,
  });

  assert.equal(res.route, "okf");
  assert.ok(res.confidence >= 0.95);
  assert.ok(res.matched_doc_ids.includes("OKF-0002"));
});

test("Test 2: Query answerable exclusively from existing RAG sources -> rag", () => {
  const reg = createOkfRegistry({ okfDir });
  const router = createOkfRouter();

  const res = router.classifyQuery({
    query: "What did we discuss about customer onboarding in the previous meeting notes?",
    spec: { project: true },
    registry: reg,
  });

  assert.equal(res.route, "rag");
  assert.ok(res.confidence >= 0.9);
  assert.equal(res.matched_doc_ids.length, 0);
});

test("Test 3: Query requiring both canonical OKF and broader RAG knowledge -> mixed", () => {
  const reg = createOkfRegistry({ okfDir });
  const router = createOkfRouter();

  const res = router.classifyQuery({
    query: "What is the official copilot architecture in OKF-0002, and what did we discuss about rolling it out?",
    spec: { project: true },
    registry: reg,
  });

  assert.equal(res.route, "mixed");
  assert.ok(res.confidence >= 0.9);
  assert.ok(res.matched_doc_ids.includes("OKF-0002"));
  assert.ok(res.matched_signals.includes("intent:canonical"));
  assert.ok(res.matched_signals.includes("intent:exploratory"));
});

test("Test 4: Ambiguous query -> defined deterministic fallback behavior (rag)", () => {
  const reg = createOkfRegistry({ okfDir });
  const router = createOkfRouter();

  const res = router.classifyQuery({
    query: "Tell me about the system status.",
    spec: { project: true },
    registry: reg,
  });

  assert.equal(res.route, "rag");
  assert.equal(res.confidence, 0.8);
});

test("Test 5: Empty OKF registry -> falls back to rag cleanly", async () => {
  const emptyReg = createOkfRegistry({
    okfDir: "/nonexistent/directory",
  });
  const router = createOkfRouter();

  const res = router.classifyQuery({
    query: "What is the official copilot architecture?",
    spec: { project: true },
    registry: emptyReg,
  });

  // Since registry is empty, no entity matches exist; canonical intent without entity defaults to mixed or rag fallback
  assert.ok(["mixed", "rag"].includes(res.route));

  // Context routing with empty registry and RAG text returns rag
  const ctx = await router.routeContext({
    query: "What is the official copilot architecture?",
    registry: emptyReg,
    ragResult: { text: "Passages from files", used: [{ file: "doc.txt" }] },
  });

  assert.equal(ctx.passages.includes("Passages from files"), true);
});

test("Test 6: OKF retrieval failure -> safe fallback with explicit source availability", async () => {
  const mockReg = {
    lookup: () => [{ id: "OKF-9999", status: "approved" }],
    getDocument: () => null, // simulates missing file on disk
  };
  const router = createOkfRouter();

  const ctx = await router.routeContext({
    query: "What is OKF-9999?",
    registry: mockReg,
    ragResult: { text: "Fallback RAG passages", used: [{ file: "notes.pdf" }] },
  });

  assert.equal(ctx.route, "rag");
  assert.equal(ctx.fallback, "okf_doc_unavailable_fallback_to_rag");
  assert.equal(ctx.passages, "Fallback RAG passages");
});

test("Test 7: RAG retrieval failure -> OKF-only fallback when relevant evidence exists", async () => {
  const reg = createOkfRegistry({ okfDir });
  const router = createOkfRouter();

  const ctx = await router.routeContext({
    query: "What is the official copilot architecture in OKF-0002 and what did we discuss?",
    registry: reg,
    ragResult: null, // RAG failed or empty
  });

  assert.equal(ctx.route, "mixed");
  assert.ok(ctx.passages.includes("CANONICAL SPECIFICATION"));
  assert.ok(ctx.passages.includes("OKF-0002"));
});

test("Test 8: Both sources unavailable -> safe failure without fabricated evidence", async () => {
  const emptyReg = {
    lookup: () => [],
    getDocument: () => null,
  };
  const router = createOkfRouter();

  const ctx = await router.routeContext({
    query: "Random question",
    registry: emptyReg,
    ragResult: null,
  });

  assert.equal(ctx.passages, "");
  assert.equal(ctx.files.length, 0);
});

test("Test 9: Conflicting OKF and RAG evidence -> canonical precedence enforced in mixed mode", async () => {
  const reg = createOkfRegistry({ okfDir });
  const router = createOkfRouter();

  const passages = router.assemblePassages({
    route: "mixed",
    okfDoc: reg.getDocument("OKF-0002"),
    ragText: "Older proposal says relevance floor is 0.50.",
    budget: 2800,
  });

  assert.ok(passages.includes("=== AUTHORITATIVE CANONICAL BASELINE"));
  assert.ok(passages.includes("=== SUPPORTING PROJECT EXPLORATION"));
  // Canonical baseline must appear before supporting exploration
  const okfIndex = passages.indexOf("AUTHORITATIVE CANONICAL BASELINE");
  const ragIndex = passages.indexOf("SUPPORTING PROJECT EXPLORATION");
  assert.ok(okfIndex < ragIndex, "Authoritative baseline must precede supporting exploration");
});

test("Test 10: Existing decider regression -> decider function intact", () => {
  const { decide } = require("../../src/copilot/core/decision");
  assert.equal(typeof decide, "function");
});

test("Test 11: Mixed retrieval context sizing respects character budget", async () => {
  const reg = createOkfRegistry({ okfDir });
  const router = createOkfRouter();

  const budget = 500;
  const passages = router.assemblePassages({
    route: "mixed",
    okfDoc: reg.getDocument("OKF-0002"),
    ragText: "A".repeat(1000),
    budget,
  });

  assert.ok(passages.length <= budget + 20, `Passages length ${passages.length} exceeded budget ${budget}`);
});

test("Test 12: Router execution latency is < 5ms", async () => {
  const reg = createOkfRegistry({ okfDir });
  const router = createOkfRouter();

  const t0 = performance.now();
  for (let i = 0; i < 50; i++) {
    router.classifyQuery({
      query: "What is the official copilot architecture in OKF-0002?",
      registry: reg,
    });
  }
  const avgMs = (performance.now() - t0) / 50;
  assert.ok(avgMs < 5.0, `Average classification took ${avgMs}ms, expected < 5ms`);
});
