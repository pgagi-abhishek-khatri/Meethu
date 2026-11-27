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

    // RepoFormer selective gate + Agentless 3-Stage Direct Localization (tools BEFORE brute-force BM25):
    const tools = codeIndex.tools;
    const directHits = [];
    const seenDirect = new Set();
    const modByRel = new Map((codeIndex.modules || []).map((m) => [m.relPath, m]));

    if (tools) {
      // Stage 2a: Exact symbol definitions (fixes exact identifier localization across large repos)
      const idents = String(query || "").match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) || [];
      for (const idTok of idents) {
        if (/^(?:where|what|which|when|does|defined|locate|located|handle|handles|exact|control|flow|files|with|from|this|that|about|system|module|feature|project)$/i.test(idTok)) continue;
        const symRes = tools.symbol(idTok, { limit: 6 });
        for (const m of symRes.matches || []) {
          if (m.symbol.toLowerCase() !== idTok.toLowerCase()) continue;
          if (seenDirect.has(m.relPath)) continue;
          seenDirect.add(m.relPath);
          const modObj = modByRel.get(m.relPath);
          directHits.push({
            id: `sym:${m.relPath}`,
            type: "symbol_direct",
            relPath: m.relPath,
            heading: m.symbol,
            lineStart: m.line || 1,
            lineEnd: m.endLine || m.line || 1,
            score: m.symbol.toLowerCase() === idTok.toLowerCase() ? 250 : 120,
            matchedTerms: [m.symbol],
            text: modObj?.markdown || `Symbol \`${m.symbol}\` (${m.kind}) at ${m.relPath}:L${m.line}`,
          });
        }
      }

      // Stage 2b: Endpoint / IPC route lookup
      const epTokens = String(query || "").match(/(?:\/[A-Za-z0-9_./{}-]{3,}|[a-z0-9_-]+:[a-z0-9_-]+)/gi) || [];
      for (const ep of epTokens) {
        const epRes = tools.endpoint(ep, { limit: 5 });
        for (const c of epRes.contracts || []) {
          if (seenDirect.has(c.handlerFile)) continue;
          seenDirect.add(c.handlerFile);
          const modObj = modByRel.get(c.handlerFile);
          directHits.push({
            id: `ep:${c.handlerFile}`,
            type: "contract_direct",
            relPath: c.handlerFile,
            heading: `${c.method} ${c.path}`,
            lineStart: c.handlerLine || 1,
            lineEnd: (c.handlerLine || 1) + 15,
            score: 220,
            matchedTerms: [c.path],
            text: modObj?.markdown || `${c.method} ${c.path} at ${c.handlerFile}:L${c.handlerLine}`,
          });
        }
      }

      // Stage 2c: Tier 1 Feature card match (resolves domain queries -> exact primary files without BM25 drift)
      for (const f of codeIndex.features || []) {
        const fNameLow = String(f.name || "").toLowerCase();
        if (fNameLow.length >= 4 && qLower.includes(fNameLow)) {
          const cardInfo = tools.feature(f.fid || f.id);
          for (const rel of (cardInfo.primaryFiles || []).slice(0, Math.min(4, topK))) {
            if (seenDirect.has(rel)) continue;
            seenDirect.add(rel);
            const modObj = modByRel.get(rel);
            directHits.push({
              id: `feat:${rel}`,
              type: "tier1_feature",
              relPath: rel,
              heading: `${f.fid || f.id} ${f.name}`,
              lineStart: 1,
              lineEnd: 60,
              score: 180,
              matchedTerms: [f.name],
              text: cardInfo.markdown || modObj?.markdown || `Primary file of ${f.name}: ${rel}`,
            });
          }
        }
      }
    }

    const isOverviewOnly =
      directHits.length === 0 &&
      /\b(?:system overview|primary stack|architecture|what are the components|routing rules)\b/i.test(query) &&
      !/\b[a-z0-9_./-]+\.[a-z]{1,5}\b/i.test(query);

    let bm25Result = { hits: [], ms: 0 };
    if (isOverviewOnly && typeof codeIndex.getSummaryBundle === "function") {
      const bundle = codeIndex.getSummaryBundle({ failOnCap: false });
      directHits.push({
        id: "tier0:router",
        type: "tier0_router",
        relPath: "00_router.md",
        heading: "Tier 0 Router Card",
        lineStart: 1,
        lineEnd: 40,
        score: 300,
        matchedTerms: ["overview"],
        text: bundle.routerStatic || bundle.router || "",
      });
    } else {
      const bm25Need = Math.max(topK, topK - directHits.length + 2);
      bm25Result = codeIndex.search(searchQuery, { topK: bm25Need, maxChunksPerFile: deep ? 2 : 1 });
    }

    codeHits.push(...directHits);
    for (const h of bm25Result.hits || []) {
      if (codeHits.length >= topK) break;
      if (!seenDirect.has(h.relPath)) {
        seenDirect.add(h.relPath);
        codeHits.push(h);
      }
    }
    if (codeHits.length > topK) codeHits.length = topK;

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
