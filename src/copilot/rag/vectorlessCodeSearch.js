// src/copilot/rag/vectorlessCodeSearch.js
// 100% Vectorless Local Codebase Scanner, Two-Layer Summary Compiler, and BM25 + PageRank Search Engine.
// Zero vector embeddings, zero external API calls, zero GitHub calls.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { classify } = require("./config");
const {
  extractCodeStructure,
  convertCodeToMarkdown,
  formatCompactFileEntry,
  chunkCodeAst,
} = require("./codeExtract");
const { createCodeCacheStore } = require("./codeCacheStore");
const { buildCodeGraph, directoryAuthority } = require("./codeGraph");
const { redactSecrets } = require("./secretScan");
const {
  isSecretFilePath,
  readSafeText,
  isLfsPointer,
  detectGeneratedHeader,
  parseShebangLanguage,
  parseLockfileVersions,
  extractNotebookSummary,
  summarizeTranslationFile,
} = require("./specialFiles");
const { discoverRepoSteps, DEFAULT_IGNORE_DIRS } = require("./repoDiscovery");
const { loadSummaryConfig } = require("./summaryConfig");
const { extractDocFacts, findStaleDocReferences } = require("./extractors/docExtractor");
const { extractFileContractSignals, correlateContractSignals } = require("./extractors/contractMap");
const { buildSymbolIndex } = require("./extractors/symbolIndex");
const { buildFeatureMap } = require("./extractors/featureMap");
const { buildGlossary } = require("./extractors/glossaryBuilder");
const { extractFileConfigSignals, extractDataAndConfig } = require("./extractors/dataAndConfig");
const { compileSummaryBundle, writeSummaryBundleAtomic } = require("./summaryCompiler");
const { applyModelFeatureSummaries } = require("./modelSummaries");
const { assignStableFeatureIds } = require("./featureIds");
const { createSummaryTools } = require("./summaryTools");

// Bump when the extractor or token shape changes: cached entries from an older version are re-parsed.
const EXTRACTOR_VERSION = 11;
const MAX_FILE_BYTES = 512 * 1024;
const SLICE_MS = 8;

const CODE_STOP_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "with", "from", "into",
  "this", "that", "what", "which", "when", "where", "why", "how", "does",
  "show", "find", "check", "analyze", "explain", "code", "file", "files",
  "is", "in", "on", "of", "to", "it", "as", "at", "by", "or", "an", "be",
  "do", "if", "no", "so", "up", "we", "me", "my",
  "module", "modules", "located", "locate", "defined", "define",
  "implemented", "implement", "handled", "handles", "handle", "works", "work",
  "depends", "depend", "dependent", "dependents", "handler",
]);

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
  if (/([bdgmnprt])\1$/.test(w) && w.length > 4) w = w.slice(0, -1);
  return w;
}

function tokenize(text, { stemmed = true } = {}) {
  const raw = String(text || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_./:-]+/g, " ")
    .toLowerCase()
    .match(/[a-z0-9]{2,}/g) || [];
  const kept = raw.filter((t) => !CODE_STOP_WORDS.has(t));
  return stemmed ? kept.map(stem) : kept;
}

function walkCodebase(rootDir, opts = {}) {
  const disc = (() => {
    const gen = discoverRepoSteps(rootDir, opts);
    for (;;) {
      const s = gen.next();
      if (s.done) return s.value;
    }
  })();
  return disc.files.filter((f) => f.specialKind === "code" || f.specialKind === "doc");
}

function extractInlineTodos(sourceText, relPath) {
  const todos = [];
  const lines = String(sourceText || "").split("\n");
  for (let i = 0; i < lines.length && todos.length < 5; i++) {
    const m = /(?:\/\/|#|\/\*)\s*(TODO|FIXME|XXX)\b[:\s-]*(.+)/i.exec(lines[i]);
    if (m) {
      const txt = m[2].replace(/\*\/\s*$/, "").trim().slice(0, 140);
      if (txt.length >= 6) todos.push({ tag: m[1].toUpperCase(), text: txt, relPath, line: i + 1 });
    }
  }
  return todos;
}

function* indexSteps(
  rootDir,
  {
    maxFiles = 250,
    chunkChars = 900,
    useCache = true,
    cacheDir,
    db = null,
    allowFiles = null,
    outputDir = null,
    log = () => {},
  } = {}
) {
  const t0 = Date.now();
  const absRoot = path.resolve(String(rootDir || ""));
  const { config: sumCfg, featuresOverride, aliasesOverride } = loadSummaryConfig(absRoot);

  const discovery = yield* discoverRepoSteps(absRoot, {
    extraRoots: sumCfg.roots || [],
    extraExcludes: sumCfg.exclude || [],
    extraIncludes: sumCfg.include || [],
    extraSecretPatterns: sumCfg.secret_patterns_extra || [],
    outputDir: outputDir || sumCfg.output?.dir || null,
    maxFiles: Math.max(maxFiles * 2, 1500),
  });

  const cacheStore = useCache ? createCodeCacheStore({ db, cacheDir, log }) : null;
  const cachedEntries = cacheStore ? cacheStore.loadRepoCache(absRoot) : new Map();

  const modules = [];
  const documents = [];
  const docFacts = [];
  const contractSignalEntries = [];
  const configSignalEntries = [];
  const tsAliases = [];
  const lockfileVersions = new Map();
  const binaryByDir = new Map();
  const translationFiles = [];
  const dirtyEntries = new Map();
  const fullCacheEntries = new Map();
  const indexedDocsMeta = [];
  const indexedConfigsMeta = [];
  const seenRelPaths = new Set();
  const absPathByRel = new Map();

  let rawCodeChars = 0;
  let cachedFiles = 0;
  let parsedFiles = 0;
  let configsIndexed = 0;
  let secretsRedacted = 0;
  let skippedLarge = 0;
  const redactionTypes = {};
  const redactionLocations = [];
  let codeCount = 0;
  let truncated = discovery.coverage.skipped.some((s) => s.reason === "max_files_cap");
  const extraSecretPatterns = sumCfg.secret_patterns_extra || [];

  const recordSkip = (file, reason) => {
    discovery.coverage.skipped.push({
      relPath: file.relPath,
      reason,
      kind: file.specialKind,
      componentId: file.componentId,
    });
  };

  for (const file of discovery.files) {
    yield;
    if (allowFiles && !allowFiles.has(file.relPath)) {
      recordSkip(file, "excluded_by_allowlist");
      continue;
    }

    // Binary / media aggregation without reading bytes
    if (file.specialKind === "binary") {
      const dir = path.dirname(file.relPath) === "." ? "(root)" : path.dirname(file.relPath);
      if (!binaryByDir.has(dir)) binaryByDir.set(dir, { dir, count: 0, bytes: 0, exts: new Set() });
      const b = binaryByDir.get(dir);
      b.count += 1;
      b.bytes += file.bytes;
      b.exts.add(path.extname(file.name).toLowerCase() || "bin");
      recordSkip(file, "binary_asset");
      continue;
    }

    if (file.specialKind === "minified" || file.specialKind === "sourcemap" || file.specialKind === "empty") {
      recordSkip(file, file.specialKind);
      continue;
    }

    if (file.bytes > MAX_FILE_BYTES && file.specialKind !== "lockfile") {
      skippedLarge += 1;
      recordSkip(file, "exceeds_max_bytes");
      continue;
    }

    // Lockfiles: extract dependency versions only, never emit as modules
    if (file.specialKind === "lockfile") {
      const readRes = readSafeText(file.absPath, 6 * 1024 * 1024);
      if (readRes.ok) {
        for (const [k, v] of parseLockfileVersions(file.relPath, readRes.text).entries()) {
          lockfileVersions.set(k, v);
        }
      }
      recordSkip(file, "lockfile_versions_only");
      continue;
    }

    if (file.specialKind === "vendored" || file.specialKind === "personal_data" || file.specialKind === "data_asset") {
      recordSkip(file, file.specialKind === "personal_data" ? "personal_data_excluded" : file.specialKind);
      continue;
    }

    const isMigrationCode =
      file.specialKind === "repetitive" &&
      /(?:^|\/)(?:migrations?|alembic\/versions)\//i.test(file.relPath) &&
      classify(file.name) === "code";
    const isCodeLike = file.specialKind === "code" || file.specialKind === "notebook" || isMigrationCode;
    const isDoc = file.specialKind === "doc";
    const isConfig = file.specialKind === "config";

    if (isCodeLike && codeCount >= maxFiles) {
      truncated = true;
      recordSkip(file, "max_files_cap");
      continue;
    }

    seenRelPaths.add(file.relPath);
    absPathByRel.set(file.relPath, file.absPath);

    const cached = cachedEntries.get(file.relPath);
    const isFresh =
      cached &&
      Math.abs(cached.mtimeMs - file.mtimeMs) < 0.01 &&
      cached.sizeBytes === file.bytes &&
      cached.module &&
      cached.module.v === EXTRACTOR_VERSION;

    if (isCodeLike) {
      codeCount += 1;
      let modData;
      if (isFresh && cached.module.kind === "code" && Array.isArray(cached.module.profileTokens)) {
        modData = cached.module;
        cachedFiles++;
        fullCacheEntries.set(file.relPath, cached);
        secretsRedacted += modData.secretsRedacted || 0;
        for (const [k, v] of Object.entries(modData.redactionTypes || {})) {
          redactionTypes[k] = (redactionTypes[k] || 0) + v;
        }
        for (const loc of modData.redactionLocations || []) {
          redactionLocations.push({ type: loc.type, relPath: file.relPath, line: loc.line });
        }
        if (modData.contractSignals) {
          contractSignalEntries.push({ relPath: file.relPath, signals: modData.contractSignals });
        }
        if (modData.configSignals) {
          configSignalEntries.push(modData.configSignals);
        }
      } else {
        const readRes = readSafeText(file.absPath, MAX_FILE_BYTES);
        if (!readRes.ok) {
          if (readRes.isBinary) recordSkip(file, "binary_null_bytes");
          else discovery.coverage.failed.push({ relPath: file.relPath, reason: readRes.reason, componentId: file.componentId });
          continue;
        }
        if (isLfsPointer(readRes.text)) {
          recordSkip(file, "git_lfs_pointer");
          continue;
        }

        let sourceText = readRes.text;
        let nbHeadings = [];
        if (file.specialKind === "notebook") {
          const nb = extractNotebookSummary(sourceText);
          sourceText = nb.codeText;
          nbHeadings = nb.headings;
        }

        const redacted = redactSecrets(sourceText, { extraPatterns: extraSecretPatterns });
        sourceText = redacted.text;
        secretsRedacted += redacted.count;
        for (const [k, v] of Object.entries(redacted.types || {})) {
          redactionTypes[k] = (redactionTypes[k] || 0) + v;
        }
        for (const loc of redacted.locations || []) {
          redactionLocations.push({ type: loc.type, relPath: file.relPath, line: loc.line });
        }
        parsedFiles++;

        const genHeader = detectGeneratedHeader(sourceText);
        const shebangLang = !path.extname(file.name) ? parseShebangLanguage(sourceText) : null;
        const structure = extractCodeStructure(sourceText, shebangLang ? `${file.relPath}.${shebangLang}` : file.relPath);
        if (genHeader) {
          structure.role = "generated";
          structure.purpose = `Generated file (${genHeader.marker})${genHeader.sourceHint ? ` from ${genHeader.sourceHint}` : ""}.`;
        } else if (nbHeadings.length > 0 && !structure.purpose) {
          structure.purpose = `Notebook covering: ${nbHeadings.slice(0, 3).map((h) => h.replace(/^#+\s*/, "")).join("; ")}`;
        }
        const markdown = convertCodeToMarkdown(sourceText, file.relPath);
        const contentHash = crypto.createHash("sha256").update(sourceText).digest("hex").slice(0, 16);

        const rawBodyUnique = [...new Set(tokenize(sourceText))].slice(0, 1200);
        const symbolPathTokens = tokenize(
          `${file.relPath} ${file.relPath} ${structure.classes.map((c) => c.name).join(" ")} ${structure.functions.map((f) => f.name).join(" ")} ${markdown}`
        );
        const profileTokens = [...symbolPathTokens, ...rawBodyUnique];
        const todos = extractInlineTodos(sourceText, file.relPath);
        const contractSignals = extractFileContractSignals({ relPath: file.relPath, text: sourceText, structure });
        const configSignals = extractFileConfigSignals({ relPath: file.relPath, text: sourceText, specialKind: file.specialKind, componentId: file.componentId, lockfileVersions });
        modData = {
          v: EXTRACTOR_VERSION,
          relPath: file.relPath,
          kind: "code",
          rawCodeChars: sourceText.length,
          contentHash,
          secretsRedacted: redacted.count,
          redactionTypes: redacted.types || {},
          redactionLocations: redacted.locations || [],
          todos,
          contractSignals,
          configSignals,
          language: structure.language,
          structure,
          markdown,
          profileTokens,
        };
        const cacheRecord = { mtimeMs: file.mtimeMs, sizeBytes: file.bytes, module: modData };
        dirtyEntries.set(file.relPath, cacheRecord);
        fullCacheEntries.set(file.relPath, cacheRecord);
        contractSignalEntries.push({ relPath: file.relPath, signals: contractSignals });
        configSignalEntries.push(configSignals);
      }

      rawCodeChars += modData.rawCodeChars || 0;
      const mod = {
        relPath: modData.relPath,
        componentId: file.componentId,
        packageId: file.packageId,
        dirty: file.dirty,
        kind: "code",
        rawCodeChars: modData.rawCodeChars || 0,
        contentHash: modData.contentHash || null,
        todos: modData.todos || [],
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
    } else if (isDoc || isConfig || file.specialKind === "translation" || file.specialKind === "patch") {
      if (isFresh && cached?.module && cached.module.kind === "non_code_v3") {
        const cm = cached.module;
        cachedFiles++;
        fullCacheEntries.set(file.relPath, cached);
        secretsRedacted += cm.secretsRedacted || 0;
        for (const [k, v] of Object.entries(cm.redactionTypes || {})) {
          redactionTypes[k] = (redactionTypes[k] || 0) + v;
        }
        for (const loc of cm.redactionLocations || []) {
          redactionLocations.push({ type: loc.type, relPath: file.relPath, line: loc.line });
        }
        if (cm.subKind === "translation") {
          if (cm.translationSummary) translationFiles.push({ relPath: file.relPath, ...cm.translationSummary });
          recordSkip(file, "translation_summary_only");
          continue;
        }
        if (cm.subKind === "config" || cm.subKind === "patch") {
          configsIndexed += 1;
          indexedConfigsMeta.push({ ...cm.meta, dirty: Boolean(file.dirty), componentId: file.componentId });
          if (cm.contractSignals) contractSignalEntries.push({ relPath: file.relPath, signals: cm.contractSignals });
          if (cm.configSignals) configSignalEntries.push(cm.configSignals);
          for (const al of cm.tsAliases || []) tsAliases.push(al);
        }
        if (cm.subKind === "doc") {
          docFacts.push(cm.facts);
          indexedDocsMeta.push({ ...cm.meta, dirty: Boolean(file.dirty), componentId: file.componentId });
          documents.push(cm.docRecord);
        }
        continue;
      }

      const readRes = readSafeText(file.absPath, MAX_FILE_BYTES);
      if (!readRes.ok) {
        if (readRes.isBinary) recordSkip(file, "binary_null_bytes");
        else discovery.coverage.failed.push({ relPath: file.relPath, reason: readRes.reason, componentId: file.componentId });
        continue;
      }
      if (isLfsPointer(readRes.text)) {
        recordSkip(file, "git_lfs_pointer");
        continue;
      }
      const redacted = redactSecrets(readRes.text, {
        extraPatterns: extraSecretPatterns,
        includePii: file.specialKind === "personal_data",
      });
      const content = redacted.text;
      secretsRedacted += redacted.count;
      for (const [k, v] of Object.entries(redacted.types || {})) {
        redactionTypes[k] = (redactionTypes[k] || 0) + v;
      }
      for (const loc of redacted.locations || []) {
        redactionLocations.push({ type: loc.type, relPath: file.relPath, line: loc.line });
      }

      if (file.specialKind === "translation") {
        const tSum = summarizeTranslationFile(file.relPath, content);
        if (tSum) translationFiles.push({ relPath: file.relPath, ...tSum });
        const cacheRec = {
          mtimeMs: file.mtimeMs,
          sizeBytes: file.bytes,
          module: {
            v: EXTRACTOR_VERSION,
            kind: "non_code_v3",
            subKind: "translation",
            translationSummary: tSum,
            secretsRedacted: redacted.count,
            redactionTypes: redacted.types || {},
            redactionLocations: redacted.locations || [],
          },
        };
        dirtyEntries.set(file.relPath, cacheRec);
        fullCacheEntries.set(file.relPath, cacheRec);
        recordSkip(file, "translation_summary_only");
        continue;
      }

      if (isConfig || file.specialKind === "patch") {
        configsIndexed += 1;
        const cfgHash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
        const cfgMeta = {
          relPath: file.relPath,
          componentId: file.componentId,
          dirty: Boolean(file.dirty),
          estTokens: Math.max(1, Math.round(content.length / 4)),
          hash: cfgHash,
        };
        indexedConfigsMeta.push(cfgMeta);
        const contractSignals = extractFileContractSignals({ relPath: file.relPath, text: content, structure: null });
        const configSignals = extractFileConfigSignals({ relPath: file.relPath, text: content, specialKind: file.specialKind, componentId: file.componentId, lockfileVersions });
        contractSignalEntries.push({ relPath: file.relPath, signals: contractSignals });
        configSignalEntries.push(configSignals);
        const fileTsAliases = [];
        if (/(?:^|\/)(?:tsconfig|jsconfig)(?:\.[^.]+)?\.json$/i.test(file.relPath)) {
          try {
            const cleanJson = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
            const parsed = JSON.parse(cleanJson);
            const pathsObj = parsed?.compilerOptions?.paths || {};
            const baseDir = path.posix.join(path.posix.dirname(file.relPath) === "." ? "" : path.posix.dirname(file.relPath), parsed?.compilerOptions?.baseUrl || "");
            for (const [aliasKey, targets] of Object.entries(pathsObj)) {
              const prefix = aliasKey.replace(/\*$/, "");
              const targetBase = Array.isArray(targets) && targets[0] ? String(targets[0]).replace(/\*$/, "").replace(/^\.\//, "") : "";
              const al = { prefix, targetRoot: path.posix.normalize(path.posix.join(baseDir, targetBase)) };
              fileTsAliases.push(al);
              tsAliases.push(al);
            }
          } catch {}
        }
        const cacheRec = {
          mtimeMs: file.mtimeMs,
          sizeBytes: file.bytes,
          module: {
            v: EXTRACTOR_VERSION,
            kind: "non_code_v3",
            subKind: isConfig ? "config" : "patch",
            meta: cfgMeta,
            contractSignals,
            configSignals,
            tsAliases: fileTsAliases,
            secretsRedacted: redacted.count,
            redactionTypes: redacted.types || {},
            redactionLocations: redacted.locations || [],
          },
        };
        dirtyEntries.set(file.relPath, cacheRec);
        fullCacheEntries.set(file.relPath, cacheRec);
      }

      if (isDoc) {
        parsedFiles++;
        const docHash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
        const docMeta = {
          relPath: file.relPath,
          componentId: file.componentId,
          dirty: Boolean(file.dirty),
          estTokens: Math.max(1, Math.round(content.length / 4)),
          hash: docHash,
        };
        indexedDocsMeta.push(docMeta);
        const facts = extractDocFacts(file.relPath, content);
        docFacts.push(facts);
        const docTokens = tokenize(`${file.relPath} ${content.slice(0, 8000)}`);
        const docRecord = {
          id: `doc:${file.relPath}`,
          type: "markdown_doc",
          relPath: file.relPath,
          heading: file.name,
          text: content.slice(0, 3000),
          tokens: docTokens,
          length: docTokens.length,
        };
        documents.push(docRecord);
        const cacheRec = {
          mtimeMs: file.mtimeMs,
          sizeBytes: file.bytes,
          module: {
            v: EXTRACTOR_VERSION,
            kind: "non_code_v3",
            subKind: "doc",
            meta: docMeta,
            facts,
            docRecord,
            secretsRedacted: redacted.count,
            redactionTypes: redacted.types || {},
            redactionLocations: redacted.locations || [],
          },
        };
        dirtyEntries.set(file.relPath, cacheRec);
        fullCacheEntries.set(file.relPath, cacheRec);
      } else if (!isConfig && file.specialKind !== "patch") {
        recordSkip(file, file.specialKind || "unindexed_other");
      }
    } else {
      recordSkip(file, file.specialKind || "unindexed_other");
    }
  }

  const deleteStaleRelPaths = [];
  for (const prevRel of cachedEntries.keys()) {
    if (!seenRelPaths.has(prevRel)) deleteStaleRelPaths.push(prevRel);
  }
  if (cacheStore && (dirtyEntries.size > 0 || deleteStaleRelPaths.length > 0)) {
    cacheStore.saveRepoCache(absRoot, fullCacheEntries, { dirtyEntries, deleteStaleRelPaths });
  }

  // BM25 inverted index
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
    for (const tok of doc.tokens) tf.set(tok, (tf.get(tok) || 0) + 1);
    tfPerDoc.set(doc.id, tf);
    for (const uniqueTok of tf.keys()) df.set(uniqueTok, (df.get(uniqueTok) || 0) + 1);
  }

  // Resolve internal Uses: import specifiers (relative & tsconfig paths aliases) to canonical repo-relative paths (#20)
  const CODE_EXT_TRY = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".swift", "/index.ts", "/index.tsx", "/index.js", "/index.jsx"];
  const resolveImportTarget = (fromRel, spec) => {
    if (!spec) return spec;
    const candidates = [];
    if (spec.startsWith(".")) {
      const base = path.posix.dirname(fromRel.replace(/\\/g, "/"));
      candidates.push(path.posix.normalize(path.posix.join(base, spec)));
    } else if (spec.startsWith("@/") || spec.startsWith("~/")) {
      const trimmed = spec.slice(2);
      for (const al of tsAliases) {
        if (spec.startsWith(al.prefix)) {
          candidates.push(path.posix.normalize(path.posix.join(al.targetRoot, spec.slice(al.prefix.length))));
        }
      }
      candidates.push(trimmed, `src/${trimmed}`);
    } else {
      for (const al of tsAliases) {
        if (spec.startsWith(al.prefix)) {
          candidates.push(path.posix.normalize(path.posix.join(al.targetRoot, spec.slice(al.prefix.length))));
        }
      }
      candidates.push(spec.replace(/\./g, "/"));
    }
    for (const c of candidates) {
      const normC = c.replace(/^\.\//, "");
      for (const ext of CODE_EXT_TRY) {
        const hit = `${normC}${ext}`;
        if (seenRelPaths.has(hit)) return hit;
      }
    }
    return spec;
  };

  for (const mod of modules) {
    if (mod.structure?.internalImports?.length) {
      mod.structure = {
        ...mod.structure,
        internalImports: [...new Set(mod.structure.internalImports.map((imp) => resolveImportTarget(mod.relPath, imp)))],
      };
    }
  }

  // Dependency graph + cross-cutting extractors
  const graph = buildCodeGraph(modules, { rootDir: absRoot });
  const symbolDefsLower = new Map();
  for (const [sym, defs] of graph.symbolDefs.entries()) {
    const low = sym.toLowerCase();
    if (!symbolDefsLower.has(low)) symbolDefsLower.set(low, new Set());
    for (const p of defs) symbolDefsLower.get(low).add(p);
  }

  const contractsRes = correlateContractSignals(contractSignalEntries);
  const { contracts, mismatches, events, unresolvedDynamicCalls = [], selfCheck: contractSelfCheck = null } = contractsRes;
  const dataAndConfig = extractDataAndConfig({ cachedSignals: configSignalEntries, lockfileVersions, modules });
  const symbols = buildSymbolIndex(modules, { contracts, flags: dataAndConfig.featureFlags, graph });
  const features = assignStableFeatureIds({
    features: buildFeatureMap({ modules, docFacts, contracts, mismatches, graph, overrides: featuresOverride }),
    absRoot,
    cacheDir,
    persist: true,
  });
  const glossary = buildGlossary({
    features,
    modules,
    contracts,
    docFacts,
    translationFiles,
    models: dataAndConfig.models,
    manualAliases: aliasesOverride,
  });
  const staleDocRefs = findStaleDocReferences(docFacts, seenRelPaths);

  const indexMs = Date.now() - t0;

  function search(query, { topK = 8, includeChunks = true, maxChunksPerFile = 1 } = {}) {
    const tSearch = Date.now();
    const qTokens = [...new Set(tokenize(query))];
    const rawIdents = String(query || "").match(/[A-Za-z_][A-Za-z0-9_-]{2,}/g) || [];
    const qWords = [...new Set([...tokenize(query, { stemmed: false }), ...rawIdents.map((x) => x.toLowerCase())])];
    if (!qTokens.length) return { hits: [], ms: Date.now() - tSearch, vectorCalls: 0, embeddingTokens: 0 };

    const queryLower = String(query || "").toLowerCase();
    const k1 = 1.5;
    const b = 0.75;
    const bm25Candidates = [];
    const bm25ById = new Map();

    // Check impact/dependents queries: "what depends on X" / "dependents of X"
    const impactMatch = /\b(?:depends\s+on|dependents\s+of|imports|callers\s+of)\s+([A-Za-z0-9_./-]+)/i.exec(String(query || ""));
    const impactDependents = new Set();
    if (impactMatch) {
      const targetHint = impactMatch[1].toLowerCase();
      for (const rel of seenRelPaths) {
        if (rel.toLowerCase() === targetHint || rel.toLowerCase().endsWith(`/${targetHint}`) || path.basename(rel).toLowerCase() === targetHint) {
          for (const dep of graph.inEdges.get(rel) || []) impactDependents.add(dep);
        }
      }
    }

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

      if (impactDependents.has(doc.relPath)) {
        score = Math.max(score, 25) * 4.0;
        matchedTerms.push("dependent");
      }

      if (score > 0) {
        const pathLower = doc.relPath.toLowerCase();
        if (queryLower.includes(pathLower)) score *= 3.0;
        let pathTokenMatches = 0;
        for (const term of qTokens) if (pathLower.includes(term)) pathTokenMatches++;
        if (pathTokenMatches > 0) score *= Math.min(2.4, Math.pow(1.3, pathTokenMatches));
        if (doc.type === "module_md") score *= 1.1;

        // Exact identifier / symbol definition boost
        const textLower = String(doc.text || "").toLowerCase();
        for (const ident of rawIdents) {
          const low = ident.toLowerCase();
          if (CODE_STOP_WORDS.has(low) || low.length < 4) continue;
          if (pathLower.includes(low)) score *= 1.8;
          else if (textLower.includes(low)) score *= 1.5;
          if (symbolDefsLower.get(low)?.has(doc.relPath)) score = Math.max(score, 12) * 3.5;
        }

        const item = { doc, bm25Raw: score, matchedTerms };
        bm25Candidates.push(item);
        bm25ById.set(doc.id, item);
      }
    }

    // Inject exact symbol-definition modules even if raw BM25 missed them
    for (const ident of rawIdents) {
      const low = ident.toLowerCase();
      if (CODE_STOP_WORDS.has(low) || low.length < 4) continue;
      for (const relPath of symbolDefsLower.get(low) || []) {
        const modDoc = moduleDocByRelPath.get(relPath);
        if (modDoc && !bm25ById.has(modDoc.id)) {
          const item = { doc: modDoc, bm25Raw: 42, matchedTerms: [low] };
          bm25Candidates.push(item);
          bm25ById.set(modDoc.id, item);
        }
      }
    }

    // If query contains an explicit snake_case or unusual identifier token and NO candidate matched it, treat as miss
    const rareTokens = rawIdents.filter((t) => t.includes("_") && t.length >= 8);
    if (rareTokens.length > 0 && bm25Candidates.every((c) => rareTokens.every((rt) => !String(c.doc.text || "").toLowerCase().includes(rt.toLowerCase()) && !c.doc.relPath.toLowerCase().includes(rt.toLowerCase())))) {
      return { hits: [], totalCandidates: 0, ms: Date.now() - tSearch, vectorCalls: 0, embeddingTokens: 0 };
    }

    bm25Candidates.sort((a, bItem) => bItem.bm25Raw - a.bm25Raw);
    bm25Candidates.forEach((item, idx) => { item.bm25Rank = idx + 1; });

    // Seed Personalized PageRank from top BM25 modules + exact symbol & contract hits
    const seedWeights = new Map();
    for (const c of contracts) {
      const pLow = c.path.toLowerCase();
      if (pLow.length >= 4 && queryLower.includes(pLow)) {
        if (c.handlerFile) {
          seedWeights.set(c.handlerFile, (seedWeights.get(c.handlerFile) || 0) + 4.0);
          const hDoc = moduleDocByRelPath.get(c.handlerFile);
          if (hDoc && !bm25ById.has(hDoc.id)) {
            const item = { doc: hDoc, bm25Raw: 8.0, bm25Rank: 1, matchedTerms: [c.path] };
            bm25ById.set(hDoc.id, item);
            bm25Candidates.push(item);
          } else if (hDoc && bm25ById.has(hDoc.id)) {
            bm25ById.get(hDoc.id).bm25Raw *= 2.0;
          }
        }
      }
    }
    for (const item of bm25Candidates.slice(0, 15)) {
      if (graph.outEdges.has(item.doc.relPath)) {
        seedWeights.set(item.doc.relPath, (seedWeights.get(item.doc.relPath) || 0) + item.bm25Raw);
      }
    }
    for (const term of qWords) {
      const symFiles = symbolDefsLower.get(term);
      if (symFiles) for (const p of symFiles) seedWeights.set(p, (seedWeights.get(p) || 0) + 2.0);
    }

    const prScores = seedWeights.size > 0 ? graph.personalizedRank(seedWeights, 12) : graph.globalRank;
    const graphRankedModules = [...prScores.entries()]
      .map(([relPath, pr]) => ({ relPath, weightedPr: pr * directoryAuthority(relPath, queryLower) }))
      .sort((a, bItem) => bItem.weightedPr - a.weightedPr);

    const graphRankByPath = new Map();
    graphRankedModules.forEach((m, idx) => graphRankByPath.set(m.relPath, idx + 1));

    const pool = [...bm25Candidates.slice(0, Math.max(45, topK * 6))];
    if (seedWeights.size > 0) {
      for (const m of graphRankedModules.slice(0, 10)) {
        const modDoc = moduleDocByRelPath.get(m.relPath);
        if (modDoc && !bm25ById.has(modDoc.id)) {
          const item = { doc: modDoc, bm25Raw: 0, bm25Rank: null, matchedTerms: [] };
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
      for (const term of qTokens) if (pathLower.includes(term)) pathMatches++;
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

    fused.sort((a, bItem) => bItem.score - a.score);

    const picked = [];
    const seenFiles = new Set();
    for (const item of fused) {
      if (picked.length >= topK) break;
      if (seenFiles.has(item.relPath)) continue;
      seenFiles.add(item.relPath);

      if (includeChunks && item.type === "module_md" && absPathByRel.has(item.relPath)) {
        try {
          const rawSrc = redactSecrets(fs.readFileSync(absPathByRel.get(item.relPath), "utf8"), { extraPatterns: extraSecretPatterns }).text;
          const fileChunks = chunkCodeAst(rawSrc, item.relPath, { targetChars: chunkChars, minChars: 60 });
          const scoredChunks = [];
          for (const ch of fileChunks) {
            const lowerChunk = ch.text.toLowerCase();
            const lowerHeading = String(ch.meta?.heading || "").toLowerCase();
            let overlap = 0;
            for (const t of qTokens) {
              if (lowerChunk.includes(t)) overlap += 1;
              if (lowerHeading.includes(t)) overlap += 1.5;
            }
            if (overlap >= 1) scoredChunks.push({ ch, overlap });
          }
          scoredChunks.sort((a, bC) => bC.overlap - a.overlap);
          const takeCount = Math.min(maxChunksPerFile, Math.max(1, topK - picked.length));
          if (scoredChunks.length > 0) {
            for (const { ch } of scoredChunks.slice(0, takeCount)) {
              if (picked.length >= topK) break;
              picked.push({
                ...item,
                type: "ast_chunk",
                heading: ch.meta?.heading || item.heading,
                lineStart: ch.meta?.page || 1,
                lineEnd: ch.meta?.endLine || ch.meta?.page || 1,
                text: ch.text,
              });
            }
            continue;
          }
        } catch (error) {
          log({ event: "code_chunk_read_failed", relPath: item.relPath, error: error.message });
        }
      }
      picked.push(item);
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
   * Bounded Deep-path slice reader: reads only requested relPath + lineStart..lineEnd ranges
   * after passing secret deny-list and secret redaction.
   */
  function readFileSlices(sliceRequests = [], { maxTokens = 4000 } = {}) {
    const maxChars = maxTokens * 4;
    let usedChars = 0;
    const slices = [];

    for (const req of sliceRequests) {
      const relPath = String(req?.relPath || "").replace(/\\/g, "/");
      if (!relPath || isSecretFilePath(relPath)) continue;
      const absPath = absPathByRel.get(relPath);
      if (!absPath) continue;
      const res = readSafeText(absPath, MAX_FILE_BYTES);
      if (!res.ok) continue;
      const redacted = redactSecrets(res.text, { extraPatterns: extraSecretPatterns });
      const lines = redacted.text.split("\n");
      const start = Math.max(1, Number(req.lineStart) || 1);
      const end = Math.min(lines.length, Number(req.lineEnd) || Math.min(lines.length, start + 80));
      const chunk = lines.slice(start - 1, end).join("\n");
      if (usedChars + chunk.length > maxChars && slices.length > 0) break;
      usedChars += chunk.length;
      slices.push({
        relPath,
        lineStart: start,
        lineEnd: end,
        text: chunk,
        redactedCount: redacted.count,
      });
    }
    return slices;
  }

  let compiledBundleCache = null;
  function getSummaryBundle({ recentCommits = [], budgets = null, failOnCap = true } = {}) {
    if (compiledBundleCache && recentCommits.length === 0 && !budgets && failOnCap) return compiledBundleCache;
    const repoName = path.basename(absRoot) || "Repository";
    const binaries = [...binaryByDir.values()].map((b) => ({ ...b, exts: [...b.exts].sort() }));
    const bundle = compileSummaryBundle({
      absRoot,
      cacheDir,
      repoName,
      components: discovery.components,
      modules,
      docFacts,
      staleDocRefs,
      contracts,
      mismatches,
      events,
      unresolvedDynamicCalls,
      contractSelfCheck,
      symbols,
      features,
      glossary,
      dataAndConfig,
      graph,
      commits: recentCommits,
      coverage: discovery.coverage,
      configsIndexed,
      indexedDocsMeta,
      indexedConfigsMeta,
      specialSummaries: { binaries, translationFiles },
      secretsRedacted,
      redactionTypes,
      redactionLocations,
      budgets: budgets || sumCfg.budgets,
      failOnCap,
      formatCompactFileEntry,
    });
    if (recentCommits.length === 0 && !budgets && failOnCap) compiledBundleCache = bundle;
    return bundle;
  }

  let summaryToolsCache = null;
  function getSummaryTools() {
    if (summaryToolsCache) return summaryToolsCache;
    let tier1Cards = [];
    try {
      tier1Cards = getSummaryBundle({ failOnCap: false })?.tier1Cards || [];
    } catch {}
    summaryToolsCache = createSummaryTools({
      features,
      tier1Cards,
      symbols,
      contracts,
      mismatches,
      events,
      docFacts,
      glossary,
      files: modules,
      readFileSlices,
    });
    return summaryToolsCache;
  }

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

    const sorted = [...modules].sort((a, bItem) => {
      const rankA = (graph.globalRank.get(a.relPath) || 0) * directoryAuthority(a.relPath);
      const rankB = (graph.globalRank.get(bItem.relPath) || 0) * directoryAuthority(bItem.relPath);
      if (Math.abs(rankB - rankA) > 1e-6) return rankB - rankA;
      return (
        bItem.structure.classes.length + bItem.structure.functions.length -
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

  function generateSingleFileContextMarkdown({
    recentCommits = [],
    maxChars = 180000,
    budgets = null,
  } = {}) {
    const repoName = path.basename(absRoot) || "Repository";
    const bundle = getSummaryBundle({ recentCommits, budgets });
    const f = bundle.files;
    let md = bundle.singleMarkdown;
    if (md.length > maxChars) {
      // Priority-preserving single-file assembly: NEVER amputate 90_coverage.md or Tier 0 router.
      const mustKeepOrder = ["00_router.md", "90_coverage.md"];
      const midOrder = ["10_features.md", "20_contracts.md", "50_docs.md", "60_config.md", "70_data.md"];
      const tailOrder = ["30_files.md", "40_symbols.md"];
      const parts = new Map();
      let used = 0;

      for (const name of mustKeepOrder) {
        const chunk = `<!-- SECTION: ${name} -->\n\n${f[name] || ""}`;
        parts.set(name, chunk);
        used += chunk.length + 12;
      }

      const fitSection = (name, text) => {
        const avail = Math.max(0, maxChars - used - 220);
        const header = `<!-- SECTION: ${name} -->\n\n`;
        if (text.length + header.length <= avail) {
          parts.set(name, header + text);
          used += header.length + text.length + 12;
          return;
        }
        if (avail <= header.length + 120) {
          const omit = `${header}> TRUNCATED: omitted ${name} (${text.length} chars) under single-file maxChars=${maxChars}; export tiered folder for complete Layer B maps.`;
          parts.set(name, omit);
          used += omit.length + 12;
          return;
        }
        const cutPos = text.lastIndexOf("\n", avail - header.length - 140);
        const sliceEnd = cutPos > 80 ? cutPos : avail - header.length - 140;
        const trimmed = `${header}${text.slice(0, sliceEnd).trimEnd()}\n\n> TRUNCATED: ${name} trimmed for single-file maxChars=${maxChars}; export tiered folder for full Layer B content.`;
        parts.set(name, trimmed);
        used += trimmed.length + 12;
      };

      for (const name of midOrder) fitSection(name, f[name] || "");
      for (const name of tailOrder) fitSection(name, f[name] || "");

      const orderedNames = [
        "00_router.md",
        "10_features.md",
        "20_contracts.md",
        "30_files.md",
        "40_symbols.md",
        "50_docs.md",
        "60_config.md",
        "70_data.md",
        "90_coverage.md",
      ];
      md = orderedNames.map((n) => parts.get(n)).filter(Boolean).join("\n\n---\n\n");
    }
    const mdChars = md.length;
    const compressionPct =
      rawCodeChars > 0 ? Number((((rawCodeChars - mdChars) / rawCodeChars) * 100).toFixed(1)) : 0;

    return {
      markdown: md,
      bundle,
      metrics: {
        repoName,
        totalModules: modules.length,
        includedModules: modules.length,
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
    config: sumCfg,
    components: discovery.components,
    coverage: discovery.coverage,
    stats: {
      filesScanned: discovery.coverage.filesFound,
      codeModules: modules.length,
      docsIndexed: docFacts.length,
      configsIndexed,
      contractsCount: contracts.length,
      mismatchesCount: mismatches.length,
      symbolsCount: symbols.length,
      featuresCount: features.length,
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
      secretsNotRead: discovery.coverage.secretsNotRead?.length || 0,
      skippedLarge,
      unreadable: discovery.coverage.failed.length,
      truncated,
    },
    modules,
    docFacts,
    contracts,
    mismatches,
    symbols,
    features,
    glossary,
    dataAndConfig,
    graph,
    search,
    readFileSlices,
    getSummaryBundle,
    get tools() {
      return getSummaryTools();
    },
    writeSummaryBundle: (outDir, opts) => writeSummaryBundleAtomic(outDir, getSummaryBundle(opts), opts),
    generateRepoMapMarkdown,
    generateSingleFileContextMarkdown,
    invalidateSummaryCache: () => {
      compiledBundleCache = null;
      summaryToolsCache = null;
    },
  };
}

function drain(gen) {
  for (;;) {
    const step = gen.next();
    if (step.done) return step.value;
  }
}

function createLocalCodeIndex(rootDir, opts) {
  return drain(indexSteps(rootDir, opts));
}

async function createLocalCodeIndexAsync(rootDir, opts = {}) {
  const absRoot = path.resolve(String(rootDir || ""));
  const gen = indexSteps(absRoot, opts);
  let sliceStart = Date.now();
  let result;
  for (;;) {
    const step = gen.next();
    if (step.done) {
      result = step.value;
      break;
    }
    if (Date.now() - sliceStart >= SLICE_MS) {
      await new Promise((resolve) => setImmediate(resolve));
      sliceStart = Date.now();
    }
  }
  if (result?.config?.summaries?.model) {
    const res = await applyModelFeatureSummaries({
      features: result.features,
      model: result.config.summaries.model,
      apiKey: opts.apiKey || process.env.OPENROUTER_API_KEY || "",
      cacheDir: opts.cacheDir,
      fetchImpl: opts.fetchImpl,
      log: opts.log,
    });
    if (res.updated > 0) result.invalidateSummaryCache?.();
  }
  return result;
}

module.exports = {
  DEFAULT_IGNORE_DIRS,
  EXTRACTOR_VERSION,
  tokenize,
  walkCodebase,
  createLocalCodeIndex,
  createLocalCodeIndexAsync,
};
