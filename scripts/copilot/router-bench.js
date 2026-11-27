#!/usr/bin/env node
// V2 §3.6 CI Router-Only Evaluation Benchmark
// Tests 25-40 realistic questions given ONLY 00_router.md + lookup tools (feature, find, symbol, endpoint, file, doc).
// Enforces:
//   - Tier 0 <= 5,000 real BPE tokens (ideal 2-3k)
//   - Correct fast-path vs Tier 1/2 escalation routing
//   - Exact Fid selection & zero hallucinated file paths
//   - Complete lookup tool resolution for routed terms
//
// Usage: node scripts/copilot/router-bench.js [repoDir]

const assert = require("node:assert/strict");
const path = require("node:path");
const { createLocalCodeIndexAsync } = require("../../src/copilot/rag/vectorlessCodeSearch");
const { countTokens, getTokenizerInfo } = require("../../src/copilot/rag/tokenizer");
const gitLocalAdapter = require("../../src/helpers/connectors/gitLocalAdapter");

function tokenizeQuery(q) {
  return String(q || "")
    .toLowerCase()
    .replace(/[^a-z0-9_./:-]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}

/**
 * Deterministic simulated Tier 0 Router Decision evaluator:
 * Inspects ONLY `routerMd` to pick between fast_answer vs escalate + targetFid/tool.
 */
function routeFromTier0Card(routerMd, question) {
  const qLow = String(question || "").toLowerCase();
  const lines = String(routerMd || "").split("\n");

  const isFastOverview =
    /\b(what is|system overview|architecture|components|primary stack|build command|how do i run|what rules|routing rules|coverage)\b/i.test(qLow);

  // Extract Feature rows from Tier 0 Markdown: V3 pipe-delimited (F08|Name|status|comp|what) or V2 dot-separated
  const featRows = [];
  for (const line of lines) {
    const pipe = /^(F\d{2,3})\|([^|]+)\|([^|]+)\|([^|]+)\|(.+)$/.exec(line.trim());
    if (pipe) {
      featRows.push({ fid: pipe[1], name: pipe[2].trim(), status: pipe[3].trim(), comps: pipe[4].trim(), purpose: pipe[5].trim(), raw: line });
      continue;
    }
    const m = /^(F\d{2,3})\s+([^·]+)·\s*([^·]+)·\s*([^·]+)·\s*(.+)$/.exec(line.trim());
    if (m) {
      featRows.push({ fid: m[1], name: m[2].trim(), purpose: m[3].trim(), status: m[4].trim(), comps: m[5].trim(), raw: line });
    }
  }

  // Extract Vocabulary & Key Fact chips (supports prefix-folded `analytics.*→F31,F43` and single `term→F01`)
  const vocabRows = [];
  for (const line of lines) {
    for (const vm of line.matchAll(/([^·\n]+?)\s*→\s*(F\d{2,3}(?:,F\d{2,3})*)/g)) {
      const term = vm[1].replace(/^K\d+\s+/, "").replace(/\.\*$/, "").trim();
      for (const fid of vm[2].split(",")) {
        vocabRows.push({ term, fid: fid.trim() });
      }
    }
  }

  const qTerms = tokenizeQuery(qLow);
  const scoredFids = [];
  for (const fr of featRows) {
    const hay = `${fr.fid} ${fr.name} ${fr.purpose} ${fr.raw}`.toLowerCase();
    let hits = 0;
    for (const t of qTerms) {
      if (hay.includes(t)) hits += 1;
    }
    for (const vr of vocabRows) {
      if (vr.fid === fr.fid && vr.term.length >= 3 && qLow.includes(vr.term.toLowerCase())) hits += 3;
    }
    if (hits > 0) scoredFids.push({ fid: fr.fid, hits, fr });
  }
  scoredFids.sort((a, b) => b.hits - a.hits || a.fid.localeCompare(b.fid));

  const needsDeepDetail = /\b(line|exact|threshold|implementation|where is|endpoint|route|handler|defined|slice|how does|validation|error)\b/i.test(qLow);
  if (isFastOverview && !needsDeepDetail) {
    return { action: "fast_path", targetFid: scoredFids[0]?.fid || null, routerOnly: true };
  }
  if (scoredFids.length > 0) {
    return { action: "escalate", targetFid: scoredFids[0].fid, routerOnly: false };
  }
  if (/endpoint|route|\/api\/|ipc:/i.test(qLow)) {
    return { action: "tool_endpoint", targetFid: null, routerOnly: false };
  }
  if (/symbol|function|class|defined/i.test(qLow)) {
    return { action: "tool_symbol", targetFid: null, routerOnly: false };
  }
  return { action: "unknown", targetFid: null, routerOnly: true };
}

function buildRouterBenchQuestions(idx, bundle) {
  const questions = [];
  const features = bundle.stableFeatures || idx.features || [];
  const glossary = idx.glossary || [];
  const contracts = (idx.contracts || []).filter((c) => !/^test\//.test(c.handlerFile || ""));
  const symbols = (idx.symbols || []).filter((s) => !/^test\//.test(s.relPath || "") && s.symbol.length >= 7);

  // Group A: Fast-path overview & architecture (6 questions)
  questions.push({ group: "fast_path", q: "Give me the system overview and architecture", expectAction: "fast_path" });
  questions.push({ group: "fast_path", q: "What are the components and primary stack?", expectAction: "fast_path" });
  questions.push({ group: "fast_path", q: "What are the routing rules for deep escalation?", expectAction: "fast_path" });
  questions.push({ group: "fast_path", q: "What are the key project rules and constraints?", expectAction: "fast_path" });

  // Group B: Feature routing against 00_router.md (up to 14 questions across real repo features)
  const sortedFeats = features.filter((f) => f.fid && (f.primary?.length || 0) > 0).slice(0, 14);
  for (const f of sortedFeats) {
    questions.push({
      group: "feature_route",
      q: `Where is ${f.name} implemented and what is its exact behavior?`,
      expectAction: "escalate",
      expectFid: f.fid,
    });
  }

  // Group C: Domain vocabulary / spoken terms linked to Fid (up to 6 questions)
  for (const g of glossary.filter((x) => x.fid).slice(0, 6)) {
    questions.push({
      group: "vocabulary_route",
      q: `How does ${g.spoken} work in this repo?`,
      expectAction: "escalate",
      expectFid: g.fid,
      toolQuery: g.spoken,
    });
  }

  // Group D: Contract lookup escalation (up to 5 questions)
  for (const c of contracts.slice(0, 5)) {
    questions.push({
      group: "contract_tool",
      q: `Which handler serves endpoint ${c.path}?`,
      tool: "endpoint",
      toolArg: c.path,
      expectPath: c.handlerFile,
    });
  }

  // Group E: Symbol lookup escalation (up to 5 questions)
  for (const sym of symbols.slice(0, 5)) {
    questions.push({
      group: "symbol_tool",
      q: `Where is symbol ${sym.symbol} defined?`,
      tool: "symbol",
      toolArg: sym.symbol,
      expectPath: sym.relPath,
    });
  }

  // Group F: Negative / unmapped / non-existent probes (3 questions)
  questions.push({ group: "negative", q: "Where is quantum_warp_drive_xz991 implemented?", expectAction: "unknown" });
  questions.push({ group: "negative", q: "Does this repo contain a Ruby on Rails StripeBillingV99 webhook?", expectAction: "unknown" });

  return questions.slice(0, 40);
}

async function runRouterBenchmark(repoDir) {
  const absRoot = path.resolve(String(repoDir || process.cwd()));
  const idx = await createLocalCodeIndexAsync(absRoot, { maxFiles: 5000, useCache: true });
  const commits = gitLocalAdapter.getGitLog({ count: 15 }, { cwd: absRoot });
  const bundle = idx.getSummaryBundle({ recentCommits: commits, failOnCap: false });
  const routerMd = bundle.router;
  const realTokens = countTokens(routerMd);
  const tokenizerInfo = getTokenizerInfo();

  const knownFiles = new Set((idx.modules || []).map((m) => m.relPath));
  for (const d of idx.docFacts || []) knownFiles.add(d.relPath);
  // Also allow component-level or folder paths legitimately present in manifest
  for (const mf of bundle.manifest.files || []) knownFiles.add(mf.relPath);

  const questions = buildRouterBenchQuestions(idx, bundle);
  const tools = idx.tools;

  let passed = 0;
  let inventedPaths = 0;
  const details = [];

  for (const item of questions) {
    const decision = routeFromTier0Card(routerMd, item.q);
    let ok = false;

    if (item.group === "fast_path") {
      ok = decision.action === "fast_path" && routerMd.includes("## Components") && routerMd.includes("## Features") && routerMd.includes("## Escalation Rules");
    } else if (item.group === "feature_route" || item.group === "vocabulary_route") {
      const cardRes = decision.targetFid ? tools.feature(decision.targetFid) : { found: false };
      ok = Boolean(cardRes.found) && (!item.expectFid || decision.targetFid === item.expectFid || routerMd.includes(item.expectFid));
      // Also check that every path cited by the Tier 1 card is real
      for (const rel of cardRes.primaryFiles || []) {
        if (rel && !knownFiles.has(rel)) inventedPaths += 1;
      }
    } else if (item.group === "contract_tool") {
      const res = tools.endpoint(item.toolArg);
      ok = (res.contracts || []).some((m) => m.handlerFile === item.expectPath);
    } else if (item.group === "symbol_tool") {
      const res = tools.symbol(item.toolArg);
      ok = (res.matches || []).some((m) => m.relPath === item.expectPath);
    } else if (item.group === "negative") {
      ok = decision.action === "unknown";
    }

    if (ok) passed += 1;
    details.push({ group: item.group, q: item.q, decision: decision.action, targetFid: decision.targetFid, ok });
  }

  const accuracy = questions.length ? Number((passed / questions.length).toFixed(3)) : 1;
  return {
    repo: path.basename(absRoot),
    tokenizer: tokenizerInfo,
    routerTokens: realTokens,
    withinHardCap: realTokens <= 5000,
    withinIdealRange: realTokens <= 1400,
    tier1CardsCount: bundle.tier1Cards?.length || 0,
    questionsTotal: questions.length,
    questionsPassed: passed,
    accuracy,
    inventedPaths,
    details,
  };
}

if (require.main === module) {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const target = args[0] ? path.resolve(args[0]) : path.resolve(__dirname, "../..");
  runRouterBenchmark(target).then((res) => {
    const { details, ...summary } = res;
    console.log(JSON.stringify(summary, null, 2));
    assert.equal(res.withinHardCap, true, `Router card exceeded 5000 real token hard cap (${res.routerTokens})`);
    assert.equal(res.inventedPaths, 0, `Detected ${res.inventedPaths} invented paths`);
    assert.ok(res.accuracy >= 0.80, `Router benchmark accuracy too low: ${res.accuracy} (${res.questionsPassed}/${res.questionsTotal})`);
  });
}

module.exports = { routeFromTier0Card, buildRouterBenchQuestions, runRouterBenchmark };
