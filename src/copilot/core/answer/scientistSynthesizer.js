// src/copilot/core/answer/scientistSynthesizer.js
// Milestone 5 + Context Summary v2: Scientist-Grade Local Code & Git Synthesis Engine.
// 100% Vectorless, 100% Offline Local Execution (zero GitHub API calls, zero vector embeddings).

const path = require("path");
const { classifyIntent, ROUTES } = require("../trigger/whenToCallRouter");
const { getGitRegistry } = require("../okf/gitRegistry");
const gitLocalAdapter = require("../../../helpers/connectors/gitLocalAdapter");
const { createLocalCodeIndex, createLocalCodeIndexAsync } = require("../../rag/vectorlessCodeSearch");

function parseBranchCompare(query) {
  const m = /\b(?:compare|diff)\s+(?:branch\s+)?([a-z0-9_.\-/]+)\s+(?:with|to|against)\s+(?:branch\s+)?([a-z0-9_.\-/]+)/i.exec(
    query
  );
  if (!m) return null;
  return { head: m[1], base: m[2] };
}

function createScientistSynthesizer({
  repoDir = process.cwd(),
  maxFiles = 250,
  useCache = true,
  cacheDir,
  db = null,
  codeIndex: prebuiltIndex = null,
  log = () => {},
} = {}) {
  const absRepo = path.resolve(repoDir);
  const gitRegistry = getGitRegistry(absRepo, { refresh: true });
  const codeIndex =
    prebuiltIndex || createLocalCodeIndex(absRepo, { maxFiles, useCache, cacheDir, db, log });

  function analyze(query, { topK = 6, deep = false } = {}) {
    const t0 = Date.now();
    const intent = classifyIntent(query, { localCodeMode: true });
    const gitFacts = [];
    const codeHits = [];
    let branchComparison = null;
    let commitMatches = [];

    const okfGit = gitRegistry.lookup(query);
    if (okfGit.matched) gitFacts.push(okfGit);

    if (intent.route === ROUTES.OKF_CANONICAL && okfGit.matched) {
      const totalMs = Date.now() - t0;
      const md = renderScientistReport({
        query,
        repoDir: absRepo,
        intent,
        gitRegistry,
        gitFacts,
        branchComparison: null,
        commitMatches: [],
        codeHits: [],
        codeStats: codeIndex.stats,
        totalMs,
      });
      return {
        query,
        route: intent.route,
        intent,
        markdown: md,
        evidence: { gitFacts, branchComparison: null, commitMatches: [], codeHits: [] },
        telemetry: {
          totalMs,
          indexMs: codeIndex.stats.indexMs,
          searchMs: 0,
          cacheHit: codeIndex.stats.cacheHit,
          cachedFiles: codeIndex.stats.cachedFiles,
          parsedFiles: codeIndex.stats.parsedFiles,
          graphEdges: codeIndex.stats.graphEdges,
          vectorCalls: 0,
          embeddingTokens: 0,
          githubApiCalls: 0,
        },
      };
    }

    const cmp = parseBranchCompare(query);
    if (cmp) {
      branchComparison = {
        base: cmp.base,
        head: cmp.head,
        ...gitLocalAdapter.getLocalDiff(cmp.base, cmp.head, { cwd: absRepo, maxChars: 6000 }),
      };
    }

    if (
      intent.route === ROUTES.LOCAL_CODE_VECTORLESS ||
      /\b(?:commit|history|revert|change|why|added|updated|fix|feat|branch)\b/i.test(query)
    ) {
      commitMatches = gitRegistry.searchCommits(query, { count: 60 }).slice(0, 5);
    }

    // Glossary expansion: if query mentions a spoken alias, include mapped target tokens
    let searchQuery = query;
    const qLower = String(query || "").toLowerCase();
    for (const g of codeIndex.glossary || []) {
      const sp = g.spoken.toLowerCase();
      if (sp.length >= 4 && (qLower.includes(sp) || g.mishearings.some((m) => qLower.includes(m.toLowerCase())))) {
        searchQuery += ` ${g.target}`;
      }
    }

    const bm25Result = codeIndex.search(searchQuery, { topK, maxChunksPerFile: deep ? 2 : 1 });
    codeHits.push(...bm25Result.hits);

    // On Deep path, enrich top hits with bounded Lstart-Lend slices + dependency closure
    let deepSlices = [];
    if (deep && codeHits.length > 0 && typeof codeIndex.readFileSlices === "function") {
      const sliceReqs = codeHits.slice(0, 5).map((h) => ({
        relPath: h.relPath,
        lineStart: h.lineStart,
        lineEnd: Math.max(h.lineEnd || h.lineStart, h.lineStart + 45),
      }));
      // Add direct dependency closure neighbors if budget allows
      const topFile = codeHits[0]?.relPath;
      if (topFile && codeIndex.graph?.outEdges?.has(topFile)) {
        for (const dep of [...codeIndex.graph.outEdges.get(topFile)].slice(0, 2)) {
          sliceReqs.push({ relPath: dep, lineStart: 1, lineEnd: 50 });
        }
      }
      deepSlices = codeIndex.readFileSlices(sliceReqs, { maxTokens: 3200 });
    }

    const totalMs = Date.now() - t0;
    const md = renderScientistReport({
      query,
      repoDir: absRepo,
      intent,
      gitRegistry,
      gitFacts,
      branchComparison,
      commitMatches,
      codeHits,
      deepSlices,
      codeStats: codeIndex.stats,
      totalMs,
    });

    return {
      query,
      route: intent.route,
      intent,
      markdown: md,
      evidence: {
        gitFacts,
        branchComparison,
        commitMatches,
        codeHits,
        deepSlices,
      },
      telemetry: {
        totalMs,
        indexMs: codeIndex.stats.indexMs,
        searchMs: bm25Result.ms,
        cacheHit: codeIndex.stats.cacheHit,
        cachedFiles: codeIndex.stats.cachedFiles,
        parsedFiles: codeIndex.stats.parsedFiles,
        graphEdges: codeIndex.stats.graphEdges,
        vectorCalls: 0,
        embeddingTokens: 0,
        githubApiCalls: 0,
      },
    };
  }

  function compileContextFile(opts = {}) {
    const recentCommits = gitLocalAdapter.getGitLog({ count: 15 }, { cwd: absRepo });
    return codeIndex.generateSingleFileContextMarkdown({
      activeBranch: gitRegistry.activeBranch,
      branchesCount: gitRegistry.branches.size,
      recentCommits,
      ...opts,
    });
  }

  function compileSummaryBundle(opts = {}) {
    const recentCommits = gitLocalAdapter.getGitLog({ count: 15 }, { cwd: absRepo });
    return codeIndex.getSummaryBundle({ recentCommits, ...opts });
  }

  return {
    repoDir: absRepo,
    gitRegistry,
    codeIndex,
    analyze,
    compileContextFile,
    compileSummaryBundle,
  };
}

function renderScientistReport({
  query,
  repoDir,
  intent,
  gitRegistry,
  gitFacts,
  branchComparison,
  commitMatches,
  codeHits,
  deepSlices = [],
  codeStats,
  totalMs,
}) {
  const lines = [];
  lines.push(`# Scientist Code & Repository Analysis`);
  lines.push(`- **Query**: \`${query}\``);
  lines.push(`- **Local Repository**: \`${repoDir}\``);
  lines.push(`- **Active Branch**: \`${gitRegistry.activeBranch}\` (Local Branches Tracked: ${gitRegistry.branches.size})`);
  lines.push(`- **Router Decision**: \`${intent.route}\` (${intent.tier}, ${intent.latencyMs}ms)`);
  lines.push(
    `- **Security & Efficiency Telemetry**: **Vector Calls: \`0\`** | **GitHub API Calls: \`0\`** | **Embedding Tokens: \`0\`** | **Query Time: \`${totalMs}ms\`**`
  );
  lines.push("");

  lines.push(`## 1. Executive Ground Truth (Deterministic Local Git / OKF)`);
  if (gitFacts.length > 0) {
    for (const fact of gitFacts) {
      lines.push(`- **${fact.type}** (\`${fact.id}\`, authority: ${fact.authority}): \`${JSON.stringify(fact.data)}\``);
    }
  } else {
    lines.push(`- **Active Branch**: \`${gitRegistry.activeBranch}\``);
    lines.push(`- **Indexed Code Modules**: ${codeStats.codeModules} files (${codeStats.indexedDocuments} AST/MD units)`);
  }

  if (branchComparison || commitMatches.length > 0) {
    lines.push("");
    lines.push(`## 2. Local Commit & Diff Decomposition`);
    if (branchComparison) {
      lines.push(`### Branch Comparison: \`${branchComparison.base}\` ... \`${branchComparison.head}\``);
      lines.push(
        `- **Files Changed**: ${branchComparison.stats.filesChanged} (Kept: ${branchComparison.stats.keptFiles}, Filtered Noise/Lockfiles: ${branchComparison.stats.droppedFiles.length})`
      );
      if (branchComparison.diffStat) {
        lines.push("```text\n" + branchComparison.diffStat.slice(0, 1200) + "\n```");
      }
    }
    if (commitMatches.length > 0) {
      lines.push(`### Relevant Local Commits (BM25 Lexical Match)`);
      for (const c of commitMatches) {
        lines.push(`- **\`${c.sha}\`** (${c.date}): ${c.message}`);
        if (c.files.length) lines.push(`  - Files: \`${c.files.slice(0, 5).join("`, `")}\``);
      }
    }
  }

  lines.push("");
  lines.push(`## 3. Code-to-MD & cAST Evidence Matrix`);
  if (codeHits.length === 0) {
    lines.push(`- No matching source code blocks found for query terms.`);
  } else {
    for (const hit of codeHits) {
      lines.push(`### \`${hit.relPath}\` (${hit.type}, BM25 score: ${hit.score}, L${hit.lineStart}${hit.lineEnd ? `-L${hit.lineEnd}` : ""})`);
      lines.push(`- Matched terms: \`${hit.matchedTerms.join("`, `")}\``);
      const preview = hit.text.length > 1500 ? hit.text.slice(0, 1500).trimEnd() + "\n..." : hit.text;
      lines.push("```markdown\n" + preview + "\n```");
    }
  }

  if (deepSlices.length > 0) {
    lines.push("", `## 4. Deep Bounded File Slices`);
    for (const sl of deepSlices) {
      lines.push(`### \`${sl.relPath}\` (L${sl.lineStart}-L${sl.lineEnd})`);
      lines.push("```\n" + sl.text.slice(0, 2000) + "\n```");
    }
  }

  return lines.join("\n");
}

async function createScientistSynthesizerAsync(options = {}) {
  const absRepo = path.resolve(options.repoDir || process.cwd());
  const codeIndex = await createLocalCodeIndexAsync(absRepo, {
    maxFiles: options.maxFiles ?? 250,
    useCache: options.useCache ?? true,
    cacheDir: options.cacheDir,
    db: options.db ?? null,
    outputDir: options.outputDir,
    log: options.log,
  });
  return createScientistSynthesizer({ ...options, repoDir: absRepo, codeIndex });
}

module.exports = {
  createScientistSynthesizer,
  createScientistSynthesizerAsync,
  parseBranchCompare,
  renderScientistReport,
};
