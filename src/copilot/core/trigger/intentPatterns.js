// src/copilot/core/trigger/intentPatterns.js
// Curated deterministic and lexical intent patterns for the When-to-Call Router.
// 100% Vectorless for local code analysis and local git commit/branch inspection.
// Zero remote GitHub API routing.

// Queries that do NOT require repo, OKF, or document retrieval.
// Parametric LLM knowledge is sufficient (algorithms, syntax, math, greetings).
const DIRECT_PATTERNS = [
  /^(?:hi|hello|hey|greetings|good\s+(?:morning|afternoon|evening))\b/i,
  /^(?:thank\s+you|thanks|cheers|bye|goodbye)\b/i,
  /\b(?:what\s+is|explain|how\s+to\s+write|implement)\s+(?:a|an)?\s*(?:binary\s+search|quick\s*sort|merge\s*sort|regex|linked\s*list|fibonacci|debounce|throttle)\b/i,
  /\b(?:difference\s+between)\s+(?:let\s+and\s+const|null\s+and\s+undefined|interface\s+and\s+type|async\s+and\s+promise)\b/i,
  /^(?:calculate|compute|math|what\s+is\s+\d+\s*[\+\-\*\/])\b/i,
  /\b(?:write|generate)\s+(?:a\s+unit\s+test|python\s+code|sql\s+query|bash\s+script)\s+(?:for|to\s+calculate|to\s+reverse)\b/i,
];

// Queries targeting deterministic local Git / OKF canonical entities.
// Routes to OKF (< 2ms, zero token cost, 100% precision) with zero vectors.
const GIT_CANONICAL_PATTERNS = [
  /\b(?:current|active|present)\s+branch\b/i,
  /\b(?:which|what)\s+branch\s+(?:are\s+we\s+on|is\s+checked\s+out|is\s+this)\b/i,
  /\b(?:git\s+branch|git\s+status|git\s+remote(?:\s+-v)?)\b/i,
  /\b(?:list|show|all)\s+(?:local\s+)?branches\b/i,
  /\b(?:latest|current|head)\s+commit(?:\s+hash|\s+sha)?\b/i,
  /\b(?:commit|sha)\s+[0-9a-f]{7,40}\b/i,
  /\b(?:git\s+tag|latest\s+tag|release\s+version)\b/i,
];

// Queries targeting local source code, symbols, diffs, or local commit history.
// Strictly VECTORLESS (BM25 + FTS5 + AST Code-to-MD + offline local .git).
const LOCAL_CODE_VECTORLESS_PATTERNS = [
  /\b(?:compare|diff)\s+(?:branch\s+)?([a-z0-9_\-\.\/]+)\s+(?:with|to|against)\s+(?:branch\s+)?([a-z0-9_\-\.\/]+)/i,
  /\b(?:what\s+changed\s+in\s+(?:branch|commit))\s+([a-z0-9_\-\.\/]+)/i,
  /\b(?:why\s+did\s+we|what\s+was\s+the\s+reason\s+(?:for|to))\s+(?:change|revert|remove|add|update)\b/i,
  /\b(?:find|search|look\s+for|show)\s+(?:all\s+places|commits?|files?|functions?|classes?|symbols?|endpoints?)\s+(?:where|about|related\s+to|for|in)\b/i,
  /\b(?:analyze|inspect|summarize|explain)\s+(?:the\s+)?(?:code|codebase|repo|repository|architecture|module|service|endpoint|commit\s+history)\b/i,
  /\b(?:where\s+is|locate)\s+(?:the\s+definition|the\s+implementation|the\s+logic)\s+of\b/i,
  /\b(?:how\s+does|explain\s+how)\s+(?:the\s+)?[a-z0-9_.\-/]+\.(?:js|ts|jsx|tsx|py|go|rs|cpp|c|sh)\b/i,
  /\b(?:local\s+)?(?:commit|git)\s+(?:log|history)\b/i,
];

// Queries for non-code project documents (meeting notes, transcripts, PDFs).
const RAG_SEMANTIC_PATTERNS = [
  /\b(?:meeting\s+notes|transcript|discussed\s+in\s+meeting|who\s+said)\b/i,
  /\b(?:how\s+does|explain\s+how)\s+(?:the\s+ingestion|the\s+audio|the\s+decider|the\s+router|the\s+okf)\s+(?:work|pipeline\s+works)\b/i,
];

module.exports = {
  DIRECT_PATTERNS,
  GIT_CANONICAL_PATTERNS,
  LOCAL_CODE_VECTORLESS_PATTERNS,
  RAG_SEMANTIC_PATTERNS,
};
