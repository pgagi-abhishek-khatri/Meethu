// src/copilot/core/trigger/whenToCallRouter.js
// Perplexity-style When-to-Call Intent Classifier & Dynamic Gating Router.
// Electron-free, sub-50ms execution, zero-throw policy.
// Enforces 100% vectorless execution for local code analysis and local git commits/branches.

const {
  DIRECT_PATTERNS,
  GIT_CANONICAL_PATTERNS,
  LOCAL_CODE_VECTORLESS_PATTERNS,
  RAG_SEMANTIC_PATTERNS,
} = require("./intentPatterns");

const ROUTES = Object.freeze({
  DIRECT_ANSWER: "DIRECT_ANSWER",                 // Parametric LLM knowledge; 0 retrieval cost & latency
  OKF_CANONICAL: "OKF_CANONICAL",                 // Deterministic local Git/OKF registry; <2ms, 0 tokens
  LOCAL_CODE_VECTORLESS: "LOCAL_CODE_VECTORLESS", // 100% vectorless BM25 + cAST Code-to-MD + local .git
  RAG_SEMANTIC: "RAG_SEMANTIC",                   // Non-code docs/meeting transcripts only
});

const ROUTER_VERSION = "2.0.0";

function normalizeQuery(input) {
  return String(input || "")
    .replace(/\b(?:USER|OTHER-?\d*|NEARBY-?\d*)\s*:/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Tier 1: Deterministic Symbol & Pattern Matcher (< 2ms)
 */
function fastPatternMatch(query) {
  // 1. Canonical Local Git / OKF Entities (<2ms, 0 tokens, 0 vectors)
  for (const pattern of GIT_CANONICAL_PATTERNS) {
    if (pattern.test(query)) {
      return {
        matched: true,
        route: ROUTES.OKF_CANONICAL,
        confidence: 1.0,
        tier: "tier1_regex",
        rationale: "Matched deterministic local Git/canonical entity pattern",
      };
    }
  }

  // 2. Local Code, Commit History & Diff Analysis (100% Vectorless BM25 + AST + local .git)
  for (const pattern of LOCAL_CODE_VECTORLESS_PATTERNS) {
    if (pattern.test(query)) {
      return {
        matched: true,
        route: ROUTES.LOCAL_CODE_VECTORLESS,
        confidence: 0.97,
        tier: "tier1_regex",
        rationale: "Matched local code / commit / diff pattern (vectorless BM25 + AST path)",
      };
    }
  }

  // 3. Direct Answers (no retrieval needed)
  for (const pattern of DIRECT_PATTERNS) {
    if (pattern.test(query)) {
      return {
        matched: true,
        route: ROUTES.DIRECT_ANSWER,
        confidence: 0.95,
        tier: "tier1_regex",
        rationale: "Matched general conversational or algorithmic pattern (no external knowledge needed)",
      };
    }
  }

  // 4. Non-code Document / Meeting RAG Patterns
  for (const pattern of RAG_SEMANTIC_PATTERNS) {
    if (pattern.test(query)) {
      return {
        matched: true,
        route: ROUTES.RAG_SEMANTIC,
        confidence: 0.92,
        tier: "tier1_regex",
        rationale: "Matched non-code document / meeting transcript pattern",
      };
    }
  }

  return { matched: false };
}

/**
 * Tier 2: Heuristic Signal Classifier (< 15ms)
 */
function semanticSignalMatch(query, context = {}) {
  const qLower = query.toLowerCase();
  const signals = [];
  let scoreCanonical = 0;
  let scoreLocalCode = 0;
  let scoreDocRag = 0;
  let scoreDirect = 0;

  // Local Git keywords
  if (/\b(?:git|branch|commit|sha|diff|merge|repo|repository)\b/.test(qLower)) {
    signals.push("signal:local_git_keyword");
    scoreLocalCode += 2.0;
  }

  // Code file paths or extensions
  if (/\b[a-z0-9_\-\/]+\.(?:js|ts|jsx|tsx|py|rs|go|cpp|c|h|sh|sql|yaml|yml)\b/.test(qLower)) {
    signals.push("signal:code_file_path");
    scoreLocalCode += 2.5;
  }

  // Code architecture / symbol terms or camelCase / snake_case identifiers
  if (
    /\b(?:function|class|method|endpoint|route|service|module|import|export|schema|api|ast|bug)\b/.test(qLower) ||
    /\b[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*\b/.test(query) ||
    /\b[a-z0-9]+_[a-z0-9_]+\b/.test(query)
  ) {
    signals.push("signal:code_symbol");
    scoreLocalCode += 2.0;
  }

  // Canonical state terms
  if (/\b(?:status|state|version|active|approved|current|spec)\b/.test(qLower)) {
    signals.push("signal:canonical_cue");
    scoreCanonical += 1.5;
  }

  // Meeting / transcript / PDF cues
  if (/\b(?:meeting|notes|transcript|discussed|pdf|slide|recording|said)\b/.test(qLower)) {
    signals.push("signal:meeting_doc_cue");
    scoreDocRag += 2.0;
  }

  // General coding questions without repo context
  if (/\b(?:how\s+to|implement|example|syntax|algorithm)\b/.test(qLower) && scoreLocalCode === 0) {
    signals.push("signal:general_coding");
    scoreDirect += 2.0;
  }

  if (scoreLocalCode >= 1.8) {
    return {
      route: ROUTES.LOCAL_CODE_VECTORLESS,
      confidence: 0.92,
      tier: "tier2_signals",
      signals,
      rationale: "Local code or commit query: routing strictly to vectorless BM25 + AST + local git",
    };
  }

  if (scoreCanonical > scoreDocRag && scoreCanonical >= 1.5) {
    return {
      route: ROUTES.OKF_CANONICAL,
      confidence: 0.90,
      tier: "tier2_signals",
      signals,
      rationale: "Dominant canonical metadata cues",
    };
  }

  if (scoreDocRag >= 1.8) {
    return {
      route: ROUTES.RAG_SEMANTIC,
      confidence: 0.85,
      tier: "tier2_signals",
      signals,
      rationale: "Dominant meeting/document memory cues",
    };
  }

  if (scoreDirect >= 2.0) {
    return {
      route: ROUTES.DIRECT_ANSWER,
      confidence: 0.85,
      tier: "tier2_signals",
      signals,
      rationale: "General programming inquiry without repo specificity",
    };
  }

  if (context.localCodeMode) {
    return {
      route: ROUTES.LOCAL_CODE_VECTORLESS,
      confidence: 0.75,
      tier: "tier2_local_fallback",
      signals,
      rationale: "Active local code analysis context: routing to vectorless local search",
    };
  }

  const hasProject = Boolean(context.projectFiles?.length || context.hasIndex);
  return {
    route: hasProject ? ROUTES.RAG_SEMANTIC : ROUTES.DIRECT_ANSWER,
    confidence: 0.65,
    tier: "tier2_fallback",
    signals,
    rationale: hasProject
      ? "Ambiguous query with active project files: defaulting to RAG_SEMANTIC"
      : "Ambiguous query without project files: defaulting to DIRECT_ANSWER",
  };
}

function classifyIntent(inputQuery, context = {}) {
  const start = Date.now();
  const query = normalizeQuery(inputQuery);

  if (!query) {
    return {
      route: ROUTES.DIRECT_ANSWER,
      confidence: 1.0,
      tier: "empty_guard",
      latencyMs: Date.now() - start,
      rationale: "Empty query",
      routerVersion: ROUTER_VERSION,
    };
  }

  const tier1 = fastPatternMatch(query);
  if (tier1.matched) {
    return {
      route: tier1.route,
      confidence: tier1.confidence,
      tier: tier1.tier,
      rationale: tier1.rationale,
      latencyMs: Date.now() - start,
      routerVersion: ROUTER_VERSION,
    };
  }

  const tier2 = semanticSignalMatch(query, context);
  return {
    route: tier2.route,
    confidence: tier2.confidence,
    tier: tier2.tier,
    signals: tier2.signals,
    rationale: tier2.rationale,
    latencyMs: Date.now() - start,
    routerVersion: ROUTER_VERSION,
  };
}

module.exports = {
  ROUTES,
  ROUTER_VERSION,
  classifyIntent,
  normalizeQuery,
};
