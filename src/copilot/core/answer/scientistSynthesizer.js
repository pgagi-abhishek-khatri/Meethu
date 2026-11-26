// src/copilot/core/answer/scientistSynthesizer.js
// Milestone 5: Scientist-Grade Local Code & Git Synthesis Engine.
// 100% Vectorless, 100% Offline Local Execution (zero GitHub API calls, zero vector embeddings).
// Combines When-to-Call Routing + GitRegistry + gitLocalAdapter + Code-to-MD BM25 Search.

const path = require("path");
const { classifyIntent, ROUTES } = require("../trigger/whenToCallRouter");
const { getGitRegistry } = require("../okf/gitRegistry");
const gitLocalAdapter = require("../../../helpers/connectors/gitLocalAdapter");
const { createLocalCodeIndex, createLocalCodeIndexAsync } = require("../../rag/vectorlessCodeSearch");

/**
 * Extracts branch names from a comparison query like "compare branch credit with main"
 */
function parseBranchCompare(query) {
  const m = /\b(?:compare|diff)\s+(?:branch\s+)?([a-z0-9_\-\.\/]+)\s+(?:with|to|against)\s+(?:branch\s+)?([a-z0-9_\-\.\/]+)/i.exec(
    query
  );
  if (!m) return null;
  return { head: m[1], base: m[2] };
}

/**
 * Creates a reusable Scientist Synthesizer bound to a local repository directory.
 */
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
  // A new synthesizer means the repo moved (or was just added): never reuse a registry cached before that.
  const gitRegistry = getGitRegistry(absRepo, { refresh: true });
  const codeIndex =
    prebuiltIndex || createLocalCodeIndex(absRepo, { maxFiles, useCache, cacheDir, db, log });

  /**
   * Analyzes a user query with full scientist rigor, returning structured Markdown
   * and machine-readable verification telemetry.
   */
  function analyze(query, { topK = 6 } = {}) {
    const t0 = Date.now();
    const intent = classifyIntent(query, { localCodeMode: true });
    const gitFacts = [];
    const codeHits = [];
    let branchComparison = null;
    let commitMatches = [];

    // 1. Canonical Local Git Lookup (OKF)
    const okfGit = gitRegistry.lookup(query);
    if (okfGit.matched) {
      gitFacts.push(okfGit);
    }

    // Fast-path isolation for OKF_CANONICAL: < 2ms deterministic answer without scanning commits/code
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

    // 2. Branch comparison diff if requested
    const cmp = parseBranchCompare(query);
    if (cmp) {
      branchComparison = {
        base: cmp.base,
        head: cmp.head,
        ...gitLocalAdapter.getLocalDiff(cmp.base, cmp.head, { cwd: absRepo, maxChars: 6000 }),
      };
    }

    // 3. Lexical Commit History Search (if query mentions commit/history/why/change/revert/branch)
    if (
      intent.route === ROUTES.LOCAL_CODE_VECTORLESS ||
      /\b(?:commit|history|revert|change|why|added|updated|fix|feat|branch)\b/i.test(query)
    ) {
      commitMatches = gitRegistry.searchCommits(query, { count: 60 }).slice(0, 5);
    }

    // 4. Vectorless BM25 + cAST Code-to-MD Search (0 vectors)
    const bm25Result = codeIndex.search(query, { topK });
    codeHits.push(...bm25Result.hits);

    const totalMs = Date.now() - t0;

    // 5. Render Scientist-Grade Milestone & Evidence Report
    const md = renderScientistReport({
      query,
      repoDir: absRepo,
      intent,
      gitRegistry,
      gitFacts,
      branchComparison,
      commitMatches,
      codeHits,
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

  return {
    repoDir: absRepo,
    gitRegistry,
    codeIndex,
    analyze,
    compileContextFile,
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

  // Section 1: Ground Truth & Git Facts
  lines.push(`## 1. Executive Ground Truth (Deterministic Local Git / OKF)`);
  if (gitFacts.length > 0) {
    for (const fact of gitFacts) {
      lines.push(`- **${fact.type}** (\`${fact.id}\`, authority: ${fact.authority}): \`${JSON.stringify(fact.data)}\``);
    }
  } else {
    lines.push(`- **Active Branch**: \`${gitRegistry.activeBranch}\``);
    lines.push(`- **Indexed Code Modules**: ${codeStats.codeModules} files (${codeStats.indexedDocuments} AST/MD units)`);
  }

  // Section 2: Branch Diff / Commit Timeline
  if (branchComparison || commitMatches.length > 0) {
    lines.push("");
    lines.push(`## 2. Local Commit & Diff Decomposition`);
    if (branchComparison) {
      lines.push(
        `### Branch Comparison: \`${branchComparison.base}\` ... \`${branchComparison.head}\``
      );
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
        lines.push(`- **\`${c.sha}\`** (${c.date}, ${c.author}) [score: ${c.score}]: ${c.message}`);
        if (c.files.length) {
          lines.push(`  - Files: \`${c.files.slice(0, 5).join("`, `")}\``);
        }
      }
    }
  }

  // Section 3: Code-to-MD & AST Evidence Matrix
  lines.push("");
  lines.push(`## 3. Code-to-MD & cAST Evidence Matrix`);
  if (codeHits.length === 0) {
    lines.push(`- No matching source code blocks found for query terms.`);
  } else {
    for (const hit of codeHits) {
      lines.push(
        `### \`${hit.relPath}\` (${hit.type}, BM25 score: ${hit.score}, L${hit.lineStart})`
      );
      lines.push(`- Matched terms: \`${hit.matchedTerms.join("`, `")}\``);
      const preview = hit.text.length > 1500 ? hit.text.slice(0, 1500).trimEnd() + "\n..." : hit.text;
      lines.push("```markdown\n" + preview + "\n```");
    }
  }

  return lines.join("\n");
}

// Builds the index in time slices (see createLocalCodeIndexAsync) so a big repo never freezes the app.
async function createScientistSynthesizerAsync(options = {}) {
  const absRepo = path.resolve(options.repoDir || process.cwd());
  const codeIndex = await createLocalCodeIndexAsync(absRepo, {
    maxFiles: options.maxFiles ?? 250,
    useCache: options.useCache ?? true,
    cacheDir: options.cacheDir,
    db: options.db ?? null,
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
