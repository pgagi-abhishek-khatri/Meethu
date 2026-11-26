// test/copilot/whenToCallRouter.test.js
// Test suite for Perplexity-Style When-to-Call Intent Classifier & Local Vectorless Gating.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  ROUTES,
  classifyIntent,
  normalizeQuery,
} = require("../../src/copilot/core/trigger/whenToCallRouter");

describe("When-to-Call Intent Classifier (Vectorless Local Code & Git)", () => {
  describe("Normalization & Edge Cases", () => {
    test("handles null and empty queries safely", () => {
      const res = classifyIntent(null);
      assert.strictEqual(res.route, ROUTES.DIRECT_ANSWER);
      assert.strictEqual(res.tier, "empty_guard");
    });

    test("strips speaker tags cleanly", () => {
      const normalized = normalizeQuery("USER: what is our current branch?");
      assert.strictEqual(normalized, "what is our current branch?");
    });
  });

  describe("Tier 1 Fast-Path: Direct Answers (Zero Retrieval)", () => {
    const directQueries = [
      "hi there",
      "hello",
      "thank you so much",
      "what is a binary search?",
      "explain quicksort in python",
      "how to write debounce in javascript",
      "difference between let and const",
      "what is 2 + 2",
    ];

    directQueries.forEach((q) => {
      test(`classifies "${q}" as DIRECT_ANSWER`, () => {
        const res = classifyIntent(q);
        assert.strictEqual(res.route, ROUTES.DIRECT_ANSWER);
        assert(res.latencyMs < 10, `Latency ${res.latencyMs}ms should be < 10ms`);
      });
    });
  });

  describe("Tier 1 Fast-Path: Canonical Local Git & OKF (Zero Vector, Zero Tokens)", () => {
    const canonicalQueries = [
      "what is our current branch?",
      "which branch are we on",
      "git branch",
      "git status",
      "list all local branches",
      "what is the latest commit sha",
      "commit 9a3f2b1",
      "what is the latest git tag",
    ];

    canonicalQueries.forEach((q) => {
      test(`classifies "${q}" as OKF_CANONICAL`, () => {
        const res = classifyIntent(q);
        assert.strictEqual(res.route, ROUTES.OKF_CANONICAL);
        assert(res.latencyMs < 10, `Latency ${res.latencyMs}ms should be < 10ms`);
      });
    });
  });

  describe("Tier 1 & Tier 2: Local Code, Diff & Commit Analysis (100% Vectorless)", () => {
    const localCodeQueries = [
      "compare branch Rag_okf with main and explain architectural changes",
      "diff feat/audio against main",
      "why did we revert the model registry in previous commits?",
      "where is the definition of resolvePrecedence located?",
      "analyze app/services/credit_service.py",
      "find commits related to pagination in conversations.py",
      "show local commit history for rag",
    ];

    localCodeQueries.forEach((q) => {
      test(`classifies "${q}" as LOCAL_CODE_VECTORLESS (never RAG_SEMANTIC)`, () => {
        const res = classifyIntent(q, { localCodeMode: true });
        assert.strictEqual(res.route, ROUTES.LOCAL_CODE_VECTORLESS);
      });
    });
  });

  describe("Tier 1: Non-Code Document / Meeting RAG Queries", () => {
    const ragQueries = [
      "who said we need to update sqlite schema in the meeting notes?",
      "what was discussed in meeting transcript?",
    ];

    ragQueries.forEach((q) => {
      test(`classifies "${q}" as RAG_SEMANTIC`, () => {
        const res = classifyIntent(q, { hasIndex: true });
        assert.strictEqual(res.route, ROUTES.RAG_SEMANTIC);
      });
    });
  });

  describe("Performance Benchmarking (< 1ms average)", () => {
    test("runs 500 query classifications in under 100ms total", () => {
      const sampleQueries = [
        "what branch are we on?",
        "what is binary search",
        "why did we remove windows portable?",
        "analyze credit_service.py",
        "compare feat/audio to main",
        "hello assistant",
      ];

      const start = Date.now();
      const iterations = 500;
      for (let i = 0; i < iterations; i++) {
        classifyIntent(sampleQueries[i % sampleQueries.length]);
      }
      const elapsed = Date.now() - start;
      const avgMs = elapsed / iterations;

      assert(elapsed < 100, `500 iterations took ${elapsed}ms (expected < 100ms)`);
      assert(avgMs < 0.5, `Average latency was ${avgMs}ms (expected < 0.5ms)`);
    });
  });
});
