// src/copilot/rag/vectorlessCodeSearch.js
// 100% Vectorless Local Codebase Scanner, Code-to-MD RepoMap Generator, and BM25 + PageRank Search Engine.
// Zero vector embeddings, zero external API calls, zero GitHub calls.
// Combines cAST syntax chunking + Code-to-MD + Dependency PageRank Graph + Incremental Cache + Okapi BM25.

const fs = require("fs");
const path = require("path");
const { classify } = require("./config");
const {
  extractCodeStructure,
  convertCodeToMarkdown,
  chunkCodeAst,
} = require("./codeExtract");
const { createCodeCacheStore } = require("./codeCacheStore");
const { buildCodeGraph, directoryAuthority } = require("./codeGraph");
const { redactSecrets } = require("./secretScan");
const { gitAllowedFiles } = require("./gitAllowedFiles");

// Bump when the extractor or token shape changes: cached entries from an older version are re-parsed.
const EXTRACTOR_VERSION = 4;
const MAX_FILE_BYTES = 512 * 1024;
const SLICE_MS = 8; // the async driver yields to the event loop after this much work

const DEFAULT_IGNORE_DIRS = new Set([
  ".git",
  ".venv",
  "venv",
  "node_modules",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  "copilot-logs",
  "carzilla-docs",
  "agent-skills",
  "Pods",
  ".expo",
  ".gradle",
  "target",
  "out",
  ".turbo",
  ".vercel",
  ".cache",
]);

const CORE_PRIORITY_DIRS = new Set([
  "src",
  "app",
  "apps",
  "packages",
  "core",
  "server",
  "backend",
  "api",
  "services",
  "helpers",
  "lib",
  "copilot",
  "main",
  "components",
  "rag",
  "okf",
  "trigger",
  "answer",
]);

const LOW_PRIORITY_DIRS = new Set([
  "scripts",
  "test",
  "tests",
  "__tests__",
  "docs",
  "examples",
  "alembic",
  "migrations",
  "locales",
  "i18n",
  "openwhispr-mobile",
  "android",
  "ios",
]);

const CODE_STOP_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "with", "from", "into",
  "this", "that", "what", "which", "when", "where", "why", "how", "does",
  "show", "find", "check", "analyze", "explain", "code", "file", "files",
]);

// A light suffix stemmer, applied to documents and queries alike so "redact", "redacted" and "redaction" meet.
// It only has to be consistent, not linguistically right: "caches", "cached" and "cache" all become "cach".
function stem(t) {
  if (t.length <= 3 || /^[0-9]+$/.test(t)) return t;
  let w = t;
  if (w.endsWith("ies") && w.length > 4) w = w.slice(0, -3) + "y";
  else if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("ing") && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith("ion") && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith("ed") && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith("es") && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith("s") && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (w.endsWith("e") && w.length > 4) w = w.slice(0, -1);
  if (/([bdgmnprt])\1$/.test(w) && w.length > 4) w = w.slice(0, -1); // "embedd" -> "embed"
  return w;
}

function tokenize(text, { stemmed = true } = {}) {
  const raw = String(text || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2") // split camelCase into tokens
    .replace(/[_./:-]+/g, " ")           // split snake_case and file paths
    .toLowerCase()
    .match(/[a-z0-9]{2,}/g) || [];
  const kept = raw.filter((t) => !CODE_STOP_WORDS.has(t));
  return stemmed ? kept.map(stem) : kept;
}

function classifyDirTier(name, parentTier = 1) {
  const low = String(name || "").toLowerCase();
  if (LOW_PRIORITY_DIRS.has(low)) return 2;
  if (parentTier >= 2) return 2;
  if (CORE_PRIORITY_DIRS.has(low)) return 0;
  return parentTier === 0 ? 0 : 1;
}

/**
 * Recursively collects source code and documentation files via Priority BFS,
 * guaranteeing core source directories (src/, app/, copilot/) are never starved
 * by docs, scripts, tests, or sub-projects when maxFiles is bounded.
 */
function* walkSteps(
  rootDir,
  { maxFiles = 250, ignoreDirs = DEFAULT_IGNORE_DIRS, includeDocs = true, allowFiles = null, meta = null } = {}
) {
  if (!rootDir || !fs.existsSync(rootDir)) return [];

  const codeFiles = [];
  const docFiles = [];
  const maxDocs = includeDocs ? Math.max(12, Math.floor(maxFiles * 0.12)) : 0;
  const maxCodeTarget = maxFiles;

  // Priority queues: 0 = core source dirs, 1 = standard dirs, 2 = scripts/tests/migrations/mobile
  const queues = [[rootDir], [], []];
  const queueTiers = new Map([[rootDir, 1]]);

  while (
    (queues[0].length > 0 || queues[1].length > 0 || queues[2].length > 0) &&
    codeFiles.length < maxCodeTarget
  ) {
    const tier = queues[0].length > 0 ? 0 : queues[1].length > 0 ? 1 : 2;
    const dir = queues[tier].shift();
    const currentTier = queueTiers.get(dir) ?? tier;

    yield; // one directory per slice
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (ignoreDirs.has(entry.name)) continue;
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const subTier = classifyDirTier(entry.name, currentTier);
        queueTiers.set(fullPath, subTier);
        queues[subTier].push(fullPath);
      } else if (entry.isFile()) {
        const kind = classify(entry.name);
        const isDoc = includeDocs && (entry.name.endsWith(".md") || entry.name.endsWith(".txt"));
        if (kind !== "code" && (!isDoc || docFiles.length >= maxDocs)) continue;

        const relPath = path.relative(rootDir, fullPath).replace(/\\/g, "/");
        if (allowFiles && !allowFiles.has(relPath)) continue; // .gitignore'd (or otherwise not part of the repo)
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > MAX_FILE_BYTES && meta) meta.skippedLarge += 1;
          if (stat.size > 0 && stat.size <= MAX_FILE_BYTES) {
            const rec = {
              absPath: fullPath,
              relPath,
              name: entry.name,
              kind: kind === "code" ? "code" : "doc",
              bytes: stat.size,
              mtimeMs: stat.mtimeMs,
            };
            if (rec.kind === "code") {
              if (codeFiles.length < maxCodeTarget) codeFiles.push(rec);
              else if (meta) meta.truncated = true; // a file was dropped because the cap was reached
            } else if (docFiles.length < maxDocs) {
              docFiles.push(rec);
            }
          }
        } catch {
          if (meta) meta.unreadable += 1; // vanished or forbidden between listing and stat: counted, not hidden
        }
      }
    }
  }

  if (meta && (queues[0].length > 0 || queues[1].length > 0 || queues[2].length > 0)) meta.truncated = true;
  const remainingForDocs = Math.max(0, maxFiles - codeFiles.length);
  const selectedDocs = docFiles.slice(0, Math.min(maxDocs, remainingForDocs || maxDocs));
  return [...codeFiles, ...selectedDocs].slice(0, maxFiles);
}

// Runs a generator to completion on the calling thread (the original synchronous behaviour).
function drain(gen) {
  for (;;) {
    const step = gen.next();
    if (step.done) return step.value;
  }
}

function walkCodebase(rootDir, opts) {
  return drain(walkSteps(rootDir, opts));
}

/**
 * Builds a 100% vectorless in-memory Code-to-MD + cAST + BM25 index for a local directory.
 */
function* indexSteps(
  rootDir,
  { maxFiles = 250, chunkChars = 900, useCache = true, cacheDir, db = null, allowFiles = null, log = () => {} } = {}
) {
  const t0 = Date.now();
  const absRoot = path.resolve(String(rootDir || ""));
  const walkMeta = { skippedLarge: 0, truncated: false, unreadable: 0 };
  const scanned = yield* walkSteps(absRoot, { maxFiles, allowFiles, meta: walkMeta });
  let secretsRedacted = 0;
  const cacheStore = useCache ? createCodeCacheStore({ db, cacheDir, log }) : null;
  const cachedEntries = cacheStore ? cacheStore.loadRepoCache(absRoot) : new Map();

  const modules = []; // { relPath, kind, structure, markdown, chunks }
  const documents = []; // flat chunks & module profiles for BM25
  const dirtyEntries = new Map();
  const fullCacheEntries = new Map();
  const seenRelPaths = new Set();

  let rawCodeChars = 0;
  let cachedFiles = 0;
  let parsedFiles = 0;

  const absPathByRel = new Map();

  for (const file of scanned) {
    yield; // one file per slice
    seenRelPaths.add(file.relPath);
    absPathByRel.set(file.relPath, file.absPath);
    const cached = cachedEntries.get(file.relPath);
    const isFresh =
      cached &&
      Math.abs(cached.mtimeMs - file.mtimeMs) < 0.01 &&
      cached.sizeBytes === file.bytes &&
      cached.module &&
      cached.module.v === EXTRACTOR_VERSION;

    if (file.kind === "code") {
      let modData;
      if (isFresh && cached.module.kind === "code" && Array.isArray(cached.module.profileTokens)) {
        modData = cached.module;
        cachedFiles++;
        fullCacheEntries.set(file.relPath, cached);
      } else {
        let content = "";
        try {
          content = fs.readFileSync(file.absPath, "utf8");
        } catch {
          continue;
        }
        const redacted = redactSecrets(content);
        content = redacted.text;
        secretsRedacted += redacted.count;
        parsedFiles++;
        const structure = extractCodeStructure(content, file.relPath);
        const markdown = convertCodeToMarkdown(content, file.relPath);
        const rawBodyUnique = [...new Set(tokenize(content))].slice(0, 1200);
        const symbolPathTokens = tokenize(
          `${file.relPath} ${file.relPath} ${structure.classes.map((c) => c.name).join(" ")} ${structure.functions.map((f) => f.name).join(" ")} ${markdown}`
        );
        const profileTokens = [...symbolPathTokens, ...rawBodyUnique];
        modData = {
          v: EXTRACTOR_VERSION,
          relPath: file.relPath,
          kind: "code",
          rawCodeChars: content.length,
          language: structure.language,
          structure,
          markdown,
          profileTokens,
        };
        const cacheRecord = { mtimeMs: file.mtimeMs, sizeBytes: file.bytes, module: modData };
        dirtyEntries.set(file.relPath, cacheRecord);
        fullCacheEntries.set(file.relPath, cacheRecord);
      }

      rawCodeChars += modData.rawCodeChars || 0;
      const mod = {
        relPath: modData.relPath,
        kind: "code",
        language: modData.language,
        structure: modData.structure,
        markdown: modData.markdown,
      };
      modules.push(mod);

      documents.push({
        id: `mod:${file.relPath}`,
        type: "module_md",
        relPath: file.relPath,
        heading: file.name,
        text: modData.markdown,
        tokens: modData.profileTokens,
        length: modData.profileTokens.length,
        structure: modData.structure,
      });
    } else {
      // Local .md / .txt docs (README, architecture notes)
      let docData;
      if (isFresh && cached.module.kind === "doc" && Array.isArray(cached.module.docTokens)) {
        docData = cached.module;
        cachedFiles++;
        fullCacheEntries.set(file.relPath, cached);
      } else {
        let content = "";
        try {
          content = fs.readFileSync(file.absPath, "utf8");
        } catch {
          continue;
        }
        const redacted = redactSecrets(content);
        content = redacted.text;
        secretsRedacted += redacted.count;
        parsedFiles++;
        const docTokens = tokenize(`${file.relPath} ${content.slice(0, 8000)}`);
        docData = {
          v: EXTRACTOR_VERSION,
          relPath: file.relPath,
          kind: "doc",
          text: content.slice(0, 3000),
          docTokens,
        };
        const cacheRecord = { mtimeMs: file.mtimeMs, sizeBytes: file.bytes, module: docData };
        dirtyEntries.set(file.relPath, cacheRecord);
        fullCacheEntries.set(file.relPath, cacheRecord);
      }

      documents.push({
        id: `doc:${file.relPath}`,
        type: "markdown_doc",
        relPath: file.relPath,
        heading: file.name,
        text: docData.text,
        tokens: docData.docTokens,
        length: docData.docTokens.length,
      });
    }
  }

  const deleteStaleRelPaths = [];
  for (const prevRel of cachedEntries.keys()) {
    if (!seenRelPaths.has(prevRel)) deleteStaleRelPaths.push(prevRel);
  }
  if (cacheStore && (dirtyEntries.size > 0 || deleteStaleRelPaths.length > 0)) {
    cacheStore.saveRepoCache(absRoot, fullCacheEntries, {
      dirtyEntries,
      deleteStaleRelPaths,
    });
  }

  // Precompute Okapi BM25 inverted index statistics + module doc lookup
  const N = documents.length || 1;
  const avgdl = documents.reduce((acc, d) => acc + d.length, 0) / N || 1;
  const df = new Map();
  const tfPerDoc = new Map();
  const moduleDocByRelPath = new Map();

  let tallied = 0;
  for (const doc of documents) {
    if (++tallied % 200 === 0) yield;
    if (doc.type === "module_md") moduleDocByRelPath.set(doc.relPath, doc);
    const tf = new Map();
    for (const tok of doc.tokens) {
      tf.set(tok, (tf.get(tok) || 0) + 1);
    }
    tfPerDoc.set(doc.id, tf);
    for (const uniqueTok of tf.keys()) {
      df.set(uniqueTok, (df.get(uniqueTok) || 0) + 1);
    }
  }

  // Build structural dependency graph + global PageRank + lowercase symbol map
  const graph = buildCodeGraph(modules);
  const symbolDefsLower = new Map();
  for (const [sym, defs] of graph.symbolDefs.entries()) {
    const low = sym.toLowerCase();
    if (!symbolDefsLower.has(low)) symbolDefsLower.set(low, new Set());
    for (const p of defs) symbolDefsLower.get(low).add(p);
  }

  const indexMs = Date.now() - t0;

  /**
   * Executes Okapi BM25 + Personalized PageRank Graph RRF + Directory Authority search (0 vectors).
   */
  function search(query, { topK = 8, includeChunks = true } = {}) {
    const tSearch = Date.now();
    const qTokens = [...new Set(tokenize(query))];
    const qWords = [...new Set(tokenize(query, { stemmed: false }))]; // exact symbol names are not stemmed
    if (!qTokens.length) return { hits: [], ms: Date.now() - tSearch, vectorCalls: 0, embeddingTokens: 0 };

    const queryLower = String(query || "").toLowerCase();
    const k1 = 1.5;
    const b = 0.75;
    const bm25Candidates = [];
    const bm25ById = new Map();

    for (const doc of documents) {
      if (!includeChunks && doc.type === "ast_chunk") continue;
      const tf = tfPerDoc.get(doc.id);
      let score = 0;
      const matchedTerms = [];

      for (const term of qTokens) {
        const freq = tf.get(term) || 0;
        if (freq === 0) continue;
        matchedTerms.push(term);
        const docFreq = df.get(term) || 0;
        const idf = Math.log(1 + (N - docFreq + 0.5) / (docFreq + 0.5));
        const denom = freq + k1 * (1 - b + b * (doc.length / avgdl));
        score += idf * ((freq * (k1 + 1)) / denom);
      }

      if (score > 0) {
        const pathLower = doc.relPath.toLowerCase();
        if (queryLower.includes(pathLower)) score *= 3.0;
        let pathTokenMatches = 0;
        for (const term of qTokens) {
          if (pathLower.includes(term)) pathTokenMatches++;
        }
        if (pathTokenMatches > 0) score *= Math.min(2.4, Math.pow(1.3, pathTokenMatches));
        if (doc.type === "module_md") score *= 1.1;

        const item = { doc, bm25Raw: score, matchedTerms };
        bm25Candidates.push(item);
        bm25ById.set(doc.id, item);
      }
    }

    bm25Candidates.sort((a, b) => b.bm25Raw - a.bm25Raw);
    bm25Candidates.forEach((item, idx) => {
      item.bm25Rank = idx + 1;
    });

    // Seed Personalized PageRank from top BM25 modules + exact symbol definition hits
    const seedWeights = new Map();
    for (const item of bm25Candidates.slice(0, 15)) {
      if (graph.outEdges.has(item.doc.relPath)) {
        seedWeights.set(item.doc.relPath, (seedWeights.get(item.doc.relPath) || 0) + item.bm25Raw);
      }
    }
    for (const term of qWords) {
      const symFiles = symbolDefsLower.get(term);
      if (symFiles) {
        for (const p of symFiles) {
          seedWeights.set(p, (seedWeights.get(p) || 0) + 2.0);
        }
      }
    }

    const prScores =
      seedWeights.size > 0 ? graph.personalizedRank(seedWeights, 12) : graph.globalRank;

    const graphRankedModules = [...prScores.entries()]
      .map(([relPath, pr]) => ({
        relPath,
        weightedPr: pr * directoryAuthority(relPath, queryLower),
      }))
      .sort((a, b) => b.weightedPr - a.weightedPr);

    const graphRankByPath = new Map();
    graphRankedModules.forEach((m, idx) => graphRankByPath.set(m.relPath, idx + 1));

    // Candidate union: top BM25 candidates + top graph neighbor hubs (structural discovery)
    const pool = [...bm25Candidates.slice(0, Math.max(45, topK * 6))];
    if (seedWeights.size > 0) {
      for (const m of graphRankedModules.slice(0, 10)) {
        const modDoc = moduleDocByRelPath.get(m.relPath);
        if (modDoc && !bm25ById.has(modDoc.id)) {
          const item = {
            doc: modDoc,
            bm25Raw: 0,
            bm25Rank: null,
            matchedTerms: [],
          };
          bm25ById.set(modDoc.id, item);
          pool.push(item);
        }
      }
    }

    const RRF_K = 20;
    const fused = pool.map((entry) => {
      const doc = entry.doc;
      const gRank = graphRankByPath.get(doc.relPath) || null;
      const bm25Term = entry.bm25Rank ? 1 / (RRF_K + entry.bm25Rank) : 0;
      const graphTerm = gRank ? 0.65 / (RRF_K + gRank) : 0;
      const auth = directoryAuthority(doc.relPath, queryLower);

      let pathBoost = 1.0;
      const pathLower = doc.relPath.toLowerCase();
      if (queryLower.includes(pathLower)) pathBoost *= 2.4;
      let pathMatches = 0;
      for (const term of qTokens) {
        if (pathLower.includes(term)) pathMatches++;
      }
      if (pathMatches > 0) pathBoost *= Math.min(2.2, Math.pow(1.25, pathMatches));

      const score = (bm25Term + graphTerm) * auth * pathBoost * 100;
      return {
        id: doc.id,
        type: doc.type,
        relPath: doc.relPath,
        heading: doc.heading,
        lineStart: doc.lineStart || 1,
        lineEnd: doc.lineEnd || doc.lineStart || 1,
        score: Number(score.toFixed(3)),
        bm25Raw: Number(entry.bm25Raw.toFixed(3)),
        graphRank: gRank,
        authority: auth,
        matchedTerms: entry.matchedTerms,
        text: doc.text,
        structure: doc.structure || null,
      };
    });

    fused.sort((a, b) => b.score - a.score);

    // Diversity-aware selection + Stage-2 Lazy cAST Chunk Refinement on Top-K winners
    const picked = [];
    const seenFiles = new Set();
    for (const item of fused) {
      if (picked.length >= topK) break;
      if (!seenFiles.has(item.relPath)) {
        seenFiles.add(item.relPath);
        if (includeChunks && item.type === "module_md" && absPathByRel.has(item.relPath)) {
          try {
            const rawSrc = redactSecrets(fs.readFileSync(absPathByRel.get(item.relPath), "utf8")).text;
            const fileChunks = chunkCodeAst(rawSrc, item.relPath, {
              targetChars: chunkChars,
              minChars: 60,
            });
            let bestChunk = null;
            let bestOverlap = 0;
            for (const ch of fileChunks) {
              const lowerChunk = ch.text.toLowerCase();
              const lowerHeading = String(ch.meta?.heading || "").toLowerCase();
              let overlap = 0;
              for (const t of qTokens) {
                if (lowerChunk.includes(t)) overlap += 1;
                if (lowerHeading.includes(t)) overlap += 1.5;
              }
              if (overlap > bestOverlap) {
                bestOverlap = overlap;
                bestChunk = ch;
              }
            }
            if (bestChunk && bestOverlap >= 1) {
              picked.push({
                ...item,
                type: "ast_chunk",
                heading: bestChunk.meta?.heading || item.heading,
                lineStart: bestChunk.meta?.page || 1,
                lineEnd: bestChunk.meta?.endLine || bestChunk.meta?.page || 1,
                text: bestChunk.text,
              });
              continue;
            }
          } catch (error) {
            // The file changed or went away since it was indexed: answer from the indexed module instead.
            log({ event: "code_chunk_read_failed", relPath: item.relPath, error: error.message });
          }
        }
        picked.push(item);
      }
    }

    return {
      hits: picked,
      totalCandidates: fused.length,
      ms: Date.now() - tSearch,
      vectorCalls: 0,
      embeddingTokens: 0,
    };
  }

  /**
   * Generates a consolidated Claude Code style RepoMap Markdown document sorted by structural PageRank.
   */
  function generateRepoMapMarkdown({ maxModules = 40 } = {}) {
    const lines = [
      `# Local Codebase RepoMap (Vectorless Code-to-MD + PageRank)`,
      `- **Root Directory**: \`${absRoot}\``,
      `- **Indexed Code Modules**: ${modules.length} (Dependency Edges: ${graph.edgeCount})`,
      `- **Total AST/MD Chunks**: ${documents.length}`,
      `- **Vector Embeddings Used**: 0 (100% Lexical BM25 + PageRank Graph + AST)`,
      "",
      "## Architectural Hubs (PageRank-Sorted)",
    ];

    const sorted = [...modules].sort((a, b) => {
      const rankA = (graph.globalRank.get(a.relPath) || 0) * directoryAuthority(a.relPath);
      const rankB = (graph.globalRank.get(b.relPath) || 0) * directoryAuthority(b.relPath);
      if (Math.abs(rankB - rankA) > 1e-6) return rankB - rankA;
      return (
        b.structure.classes.length +
        b.structure.functions.length -
        (a.structure.classes.length + a.structure.functions.length)
      );
    });

    for (const mod of sorted.slice(0, maxModules)) {
      const clsNames = mod.structure.classes.map((c) => c.name).slice(0, 5).join(", ");
      const fnNames = mod.structure.functions.map((f) => f.name).slice(0, 6).join(", ");
      const inDeg = graph.inEdges.get(mod.relPath)?.size || 0;
      lines.push(
        `- **\`${mod.relPath}\`** (${mod.language}, ${mod.structure.totalLines} lines, ${inDeg} dependents)` +
          (clsNames ? ` | Classes: \`${clsNames}\`` : "") +
          (fnNames ? ` | Functions: \`${fnNames}\`` : "")
      );
    }

    return lines.join("\n");
  }

  /**
   * Compiles the entire repository into a SINGLE Claude Code-style Markdown context file
   * (architecture, directory tree, git history, and all module Code-to-MD schemas).
   * Ideal for feeding complete repository awareness to AI agents in a single compact artifact.
   */
  function generateSingleFileContextMarkdown({
    activeBranch = null,
    branchesCount = 0,
    recentCommits = [],
    maxModules = 200,
    maxChars = 180000,
  } = {}) {
    const repoName = path.basename(rootDir) || "Repository";
    const sorted = [...modules].sort((a, b) => a.relPath.localeCompare(b.relPath));

    const headerLines = [
      `# Repository Context: ${repoName}`,
      `> Generated offline as a single unified Code-to-MD context file for AI reasoning & future actions (0 vector calls, 0 GitHub API calls).`,
      "",
      `- **Root Path**: \`${rootDir}\``,
      ...(activeBranch ? [`- **Active Git Branch**: \`${activeBranch}\` (${branchesCount} branches tracked)`] : []),
      `- **Code Modules Indexed**: ${modules.length}`,
      `- **Total AST/MD Chunks**: ${documents.length}`,
      `- **Raw Source Size**: ${rawCodeChars.toLocaleString()} chars (~${Math.round(rawCodeChars / 4).toLocaleString()} tokens)`,
      "",
    ];

    if (recentCommits.length > 0) {
      headerLines.push(`## Recent Local Git Commits`);
      for (const c of recentCommits.slice(0, 12)) {
        headerLines.push(`- **\`${c.sha}\`** (${c.date}, ${c.author}): ${c.message}`);
      }
      headerLines.push("");
    }

    // Directory Summary
    const dirMap = new Map();
    for (const m of sorted) {
      const dir = path.dirname(m.relPath) === "." ? "(root)" : path.dirname(m.relPath);
      if (!dirMap.has(dir)) dirMap.set(dir, []);
      dirMap.get(dir).push(m);
    }
    headerLines.push(`## Directory & Module Tree`);
    for (const [dir, list] of dirMap.entries()) {
      headerLines.push(`- **\`${dir}/\`** (${list.length} files): ${list.map((x) => `\`${path.basename(x.relPath)}\``).slice(0, 8).join(", ")}${list.length > 8 ? ` (+${list.length - 8} more)` : ""}`);
    }
    headerLines.push("");
    headerLines.push(`## Module-by-Module Code-to-MD Specifications`);
    headerLines.push("");

    let body = headerLines.join("\n");
    let includedModules = 0;

    for (const mod of sorted.slice(0, maxModules)) {
      const block = mod.markdown.replace(/^# Module:/, `### Module: \`${mod.relPath}\` (`) + "\n---\n\n";
      const cleanBlock = `### \`${mod.relPath}\`\n` + mod.markdown.split("\n").slice(1).join("\n") + "\n\n";
      if (body.length + cleanBlock.length > maxChars) break;
      body += cleanBlock;
      includedModules++;
    }

    const mdChars = body.length;
    const compressionPct =
      rawCodeChars > 0 ? Number((((rawCodeChars - mdChars) / rawCodeChars) * 100).toFixed(1)) : 0;

    return {
      markdown: body.trim(),
      metrics: {
        repoName,
        totalModules: modules.length,
        includedModules,
        rawCodeChars,
        markdownChars: mdChars,
        estRawTokens: Math.round(rawCodeChars / 4),
        estMarkdownTokens: Math.round(mdChars / 4),
        compressionPct,
        vectorCalls: 0,
        githubApiCalls: 0,
      },
    };
  }

  return {
    rootDir: absRoot,
    stats: {
      filesScanned: scanned.length,
      codeModules: modules.length,
      indexedDocuments: documents.length,
      rawCodeChars,
      indexMs,
      cachedFiles,
      parsedFiles,
      cacheHit: cachedFiles > 0 && parsedFiles === 0,
      cacheBackend: cacheStore ? cacheStore.backend : "none",
      graphNodes: graph.nodeCount,
      graphEdges: graph.edgeCount,
      vectorCalls: 0,
      embeddingTokens: 0,
      secretsRedacted,
      skippedLarge: walkMeta.skippedLarge,
      unreadable: walkMeta.unreadable,
      truncated: walkMeta.truncated,
    },
    modules,
    graph,
    search,
    generateRepoMapMarkdown,
    generateSingleFileContextMarkdown,
  };
}

function createLocalCodeIndex(rootDir, opts) {
  return drain(indexSteps(rootDir, opts));
}

// Same build, but yields to the event loop every few ms so a cold index of a big repo never freezes the app.
// Also honours .gitignore (via `git ls-files`) when the folder is a git repo.
async function createLocalCodeIndexAsync(rootDir, opts = {}) {
  const absRoot = path.resolve(String(rootDir || ""));
  const allowFiles = opts.allowFiles ?? (await gitAllowedFiles(absRoot));
  const gen = indexSteps(absRoot, { ...opts, allowFiles });
  let sliceStart = Date.now();
  for (;;) {
    const step = gen.next();
    if (step.done) return step.value;
    if (Date.now() - sliceStart >= SLICE_MS) {
      await new Promise((resolve) => setImmediate(resolve));
      sliceStart = Date.now();
    }
  }
}

module.exports = {
  DEFAULT_IGNORE_DIRS,
  EXTRACTOR_VERSION,
  tokenize,
  walkCodebase,
  createLocalCodeIndex,
  createLocalCodeIndexAsync,
};
