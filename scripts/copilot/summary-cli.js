#!/usr/bin/env node
// Offline CLI for Context Summary v2 generation and --check staleness validation.
// Usage:
//   node scripts/copilot/summary-cli.js <repoDir> [--out <dir>] [--single] [--check]
const fs = require("fs");
const path = require("path");
const { createLocalCodeIndexAsync } = require("../../src/copilot/rag/vectorlessCodeSearch");
const gitLocalAdapter = require("../../src/helpers/connectors/gitLocalAdapter");

function parseArgs(argv) {
  const args = { repoDir: process.cwd(), outDir: null, single: false, check: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--out" && rest[i + 1]) {
      args.outDir = path.resolve(rest[++i]);
    } else if (a === "--single") {
      args.single = true;
    } else if (a === "--check") {
      args.check = true;
    } else if (!a.startsWith("-")) {
      args.repoDir = path.resolve(a);
    }
  }
  return args;
}

async function runCli(argv = process.argv) {
  const opts = parseArgs(argv);
  const outDir = opts.outDir || path.join(opts.repoDir, "summary");
  const idx = await createLocalCodeIndexAsync(opts.repoDir, {
    maxFiles: 5000,
    useCache: !opts.check,
    outputDir: outDir,
  });
  const commits = gitLocalAdapter.getGitLog({ count: 15 }, { cwd: opts.repoDir });
  const bundle = idx.getSummaryBundle({ recentCommits: commits });

  if (opts.check) {
    const manifestPath = path.join(outDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      console.error(`STALE: missing ${manifestPath}`);
      return 1;
    }
    const prev = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const curComp = JSON.stringify(bundle.manifest.components.map((c) => ({ id: c.id, revision: c.revision, dirtyCount: c.dirtyCount })));
    const prevComp = JSON.stringify((prev.components || []).map((c) => ({ id: c.id, revision: c.revision, dirtyCount: c.dirtyCount })));
    const curHashes = JSON.stringify(bundle.manifest.files.map((f) => [f.relPath, f.hash]));
    const prevHashes = JSON.stringify((prev.files || []).map((f) => [f.relPath, f.hash]));
    if (curComp !== prevComp || curHashes !== prevHashes) {
      console.error("STALE: repository summary differs from current disk/git state.");
      return 1;
    }
    console.log("OK: summary is up to date.");
    return 0;
  }

  if (opts.single) {
    const singleFile = idx.generateSingleFileContextMarkdown({ recentCommits: commits });
    fs.mkdirSync(path.dirname(outDir), { recursive: true });
    const target = outDir.endsWith(".md") ? outDir : path.join(outDir, `${path.basename(opts.repoDir)}-context.md`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, singleFile.markdown, "utf8");
    console.log(`Wrote ${target} (${singleFile.metrics.markdownChars} chars)`);
    return 0;
  }

  const written = idx.writeSummaryBundle(outDir, { recentCommits: commits });
  console.log(`Wrote tiered summary bundle to ${written} (Layer A: ${bundle.layerATokens} est tokens, ${bundle.manifest.counts.codeModules} modules, ${bundle.manifest.counts.docs} docs)`);
  return 0;
}

if (require.main === module) {
  runCli().then((code) => process.exit(code));
}

module.exports = { parseArgs, runCli };
