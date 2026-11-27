#!/usr/bin/env node
// Section 16 Generic Evaluation Harness for Context Summary Generator.
// Evaluates 100% file accounting, zero silent truncation parity, secret safety, Layer A token budget,
// two-run P8 determinism, unique anchors, and auto-generated retrieval probes across ALL 6 query groups.
// Usage: node scripts/copilot/summary-eval.js [repoDir] [--live]

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { createScientistSynthesizerAsync } = require("../../src/copilot/core/answer/scientistSynthesizer");

function hashBundleFiles(files) {
  const out = {};
  for (const [k, v] of Object.entries(files || {})) {
    out[k] = crypto.createHash("sha256").update(String(v || "")).digest("hex").slice(0, 12);
  }
  return out;
}

function buildGenericProbes(idx) {
  const probes = [];
  const modules = (idx.modules || []).filter((m) => m.structure?.role !== "test" && !/^test\//.test(m.relPath));
  const contracts = (idx.contracts || []).filter((c) => !/^test\//.test(c.handlerFile || ""));
  const features = idx.features || [];
  const glossary = (idx.glossary || []).filter((g) => !/^[+_]/.test(g.spoken || ""));
  const graph = idx.graph;

  // 1. Fast overview (evaluated against 00_index.md alone)
  probes.push({ group: "fast_overview", q: "System overview, primary stack, and rules in Layer A", expectLayerA: true });

  // 2. Deep escalation (requires escalating past Layer A to Layer B + bounded readFileSlices)
  const deepSymMod = modules.find((m) => (m.structure?.functions || []).some((f) => f.exported !== false && (f.endLine || f.line) >= f.line));
  if (deepSymMod) {
    const fn = deepSymMod.structure.functions.find((f) => f.exported !== false && (f.endLine || f.line) >= f.line);
    probes.push({
      group: "deep_escalation",
      q: `exact control flow of ${fn.name}`,
      expectPath: deepSymMod.relPath,
      lineStart: fn.line,
      lineEnd: fn.endLine || fn.line,
    });
  }

  // 3. Locate: distinctive non-test exported symbol (prefer core src/ over scripts if available)
  let pickedLocate = null;
  for (const m of modules) {
    const fn = (m.structure?.functions || []).find((f) => f.exported !== false && f.name.length >= 8 && !/^use[A-Z]/.test(f.name));
    if (fn) {
      pickedLocate = { group: "locate", q: `where is ${fn.name} defined?`, expectPath: m.relPath };
      break;
    }
  }
  if (pickedLocate) probes.push(pickedLocate);

  // 4. Route (feature -> primary files)
  const featWithPrimary = features.find((f) => f.id !== "core" && (f.primary?.length || 0) > 0) || features.find((f) => (f.primary?.length || 0) > 0);
  if (featWithPrimary) {
    probes.push({ group: "route", q: `which files handle ${featWithPrimary.name}?`, expectAnyOf: featWithPrimary.primary.map((p) => p.relPath) });
  }

  // 5. Contract: first production HTTP/IPC contract
  if (contracts.length > 0) {
    const c = contracts[0];
    probes.push({ group: "contract", q: `where is ${c.method} ${c.path} handled?`, expectPath: c.handlerFile });
  }

  // 6. Impact: highest fan-in non-barrel module
  if (graph) {
    let bestMod = null;
    let bestIn = 0;
    for (const [rel, deps] of graph.inEdges.entries()) {
      if (path.basename(rel).startsWith("index.")) continue;
      if (deps.size > bestIn) {
        bestIn = deps.size;
        bestMod = { rel, deps: [...deps] };
      }
    }
    if (bestMod) {
      probes.push({
        group: "impact",
        q: `what depends on ${path.basename(bestMod.rel)}?`,
        expectAnyOf: bestMod.deps,
      });
    }
  }

  // 7. Spoken name: glossary entry pointing to a file/feature (+ simulated ASR phrase)
  const glItem = glossary.find((g) => (g.targetType === "file" || g.targetType === "feature") && !g.target.includes("+"));
  if (glItem) {
    const spokenQuery = glItem.mishearings?.[0] || glItem.spoken;
    probes.push({ group: "spoken_name", q: `where is ${spokenQuery}?`, expectPath: glItem.target, glossaryTerm: glItem.spoken });
  }

  // 8. Negative / Hallucination resistance
  probes.push({ group: "negative", q: "where is the quantum_hyper_blockchain_xyz_99881 located?", expectMissing: true });
  return probes;
}

function verifyTruncationParity(bundle) {
  const issues = [];
  const ts = bundle.manifest.truncatedSections || {};
  const mapFiles = {
    index: "00_index.md",
    features: "10_features.md",
    contracts: "20_contracts.md",
    files: "30_files.md",
    symbols: "40_symbols.md",
    docs: "50_docs.md",
    config: "60_config.md",
    data: "70_data.md",
  };
  for (const [secKey, fileName] of Object.entries(mapFiles)) {
    const meta = ts[secKey];
    if (!meta) continue;
    if (meta.truncated) {
      const content = bundle.files[fileName] || "";
      if (!content.includes("> TRUNCATED")) {
        issues.push(`${fileName} marked truncated (${meta.shown}/${meta.total}) without > TRUNCATED banner`);
      }
    }
  }
  return issues;
}

function checkDuplicateAnchors(filesMd) {
  const anchors = [];
  const re = /<a id="([^"]+)"><\/a>/g;
  let m;
  while ((m = re.exec(filesMd || "")) !== null) anchors.push(m[1]);
  const uniq = new Set(anchors);
  return anchors.length - uniq.size;
}

async function evaluateRepo(repoDir, { checkDeterminism = true } = {}) {
  const t0 = Date.now();
  const synth = await createScientistSynthesizerAsync({
    repoDir,
    maxFiles: 5000,
    useCache: false,
  });
  const idx = synth.codeIndex;
  const bundle = synth.compileSummaryBundle();
  const indexMs = Date.now() - t0;

  // 1. Strict 100% Accounting (no Math.min masking!)
  const accounted =
    idx.stats.codeModules +
    idx.stats.docsIndexed +
    (idx.stats.configsIndexed || 0) +
    idx.coverage.skipped.length +
    idx.coverage.failed.length;
  const discovered = idx.coverage.filesFound;
  const accountingExact = accounted === discovered;

  // 2. Security & Privacy checks
  const fullText = Object.values(bundle.files).join("\n") + "\n" + JSON.stringify(bundle.manifest);
  const secretLeakRe = /(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
  const secretsLeaked = secretLeakRe.test(fullText) ? 1 : 0;
  const absRootLeaked = Boolean(bundle.manifest.absRoot);

  // 3. Layer A token budget + Truncation parity + Unique anchors
  const layerATokens = bundle.layerATokens;
  const truncationParityIssues = verifyTruncationParity(bundle);
  const duplicateAnchors = checkDuplicateAnchors(bundle.files["30_files.md"]);

  // 4. Determinism check (second run comparison)
  let deterministic = null;
  if (checkDeterminism) {
    const synth2 = await createScientistSynthesizerAsync({ repoDir, maxFiles: 5000, useCache: false });
    const bundle2 = synth2.compileSummaryBundle();
    const h1 = hashBundleFiles(bundle.files);
    const h2 = hashBundleFiles(bundle2.files);
    deterministic = Object.keys(h1).every((k) => h1[k] === h2[k]);
  }

  // 5. Generic Dynamic Query Probes across all 8 Section 16 groups
  const probes = buildGenericProbes(idx);
  const layerA = bundle.files["00_index.md"] || "";
  let passed = 0;
  const details = [];
  for (const p of probes) {
    if (p.expectLayerA) {
      const ok =
        layerA.includes("## System Overview") &&
        layerA.includes("## Feature Catalogue") &&
        layerA.includes("Escalate to Deep");
      if (ok) passed += 1;
      details.push({ group: p.group, q: p.q, ok, top3: ["00_index.md"] });
      continue;
    }
    if (p.group === "deep_escalation") {
      const slices = idx.readFileSlices([{ relPath: p.expectPath, lineStart: p.lineStart, lineEnd: p.lineEnd }], { maxTokens: 1500 });
      const ok = slices.length === 1 && slices[0].relPath === p.expectPath && slices[0].text.length > 0 && layerA.includes("Escalate to Deep");
      if (ok) passed += 1;
      details.push({ group: p.group, q: p.q, ok, top3: [`${p.expectPath}:L${p.lineStart}-L${p.lineEnd}`] });
      continue;
    }
    const res = synth.analyze(p.q, { topK: 5, deep: p.group === "route" });
    const hits = res.evidence.codeHits.map((h) => h.relPath);
    const glossaryMatch = p.glossaryTerm && layerA.toLowerCase().includes(p.glossaryTerm.toLowerCase());
    const ok = p.expectMissing
      ? hits.length === 0 || res.evidence.codeHits[0].score < 5
      : p.expectAnyOf
        ? p.expectAnyOf.some((exp) => hits.includes(exp))
        : hits.includes(p.expectPath) || Boolean(glossaryMatch);
    if (ok) passed += 1;
    details.push({ group: p.group, q: p.q, ok, top3: hits.slice(0, 3) });
  }
  const queryResults = {
    passed,
    total: probes.length,
    accuracy: probes.length ? Number((passed / probes.length).toFixed(2)) : 1,
    details,
  };

  // Quality telemetry on generated summaries
  const filesMd = bundle.files["30_files.md"] || "";
  const purposeLines = [...filesMd.matchAll(/^Purpose:\s*(.+)$/gm)].map((m) => m[1]);
  const genericPurposes = purposeLines.filter((p) => /^[a-z/ ]+ in [^\s.]+\.?$/i.test(p)).length;
  const revMatches = [...filesMd.matchAll(/· rev ([0-9a-f]+)/g)].map((m) => m[1]);
  const headRev = bundle.manifest.components?.[0]?.revision || "";
  const nonHeadRevs = revMatches.filter((r) => r && r !== headRev).length;

  return {
    repo: path.basename(path.resolve(repoDir)),
    indexMs,
    discovered,
    accounted,
    accountingExact,
    coveragePct: discovered ? Number(((accounted / discovered) * 100).toFixed(1)) : 100,
    secretsLeaked,
    absRootLeaked,
    secretsNotRead: idx.coverage.secretsNotRead.length,
    secretsRedacted: idx.stats.secretsRedacted,
    layerATokens,
    layerAWithinCap: layerATokens <= 10500,
    duplicateAnchors,
    truncationParityIssues,
    deterministic,
    qualityMetrics: {
      purposeTotal: purposeLines.length,
      genericPurposes,
      revTagsTotal: revMatches.length,
      nonHeadRevs,
      layerBFilesShown: bundle.manifest.truncatedSections?.files?.shown || 0,
    },
    truncated: bundle.manifest.truncated,
    truncatedSections: bundle.manifest.truncatedSections,
    counts: bundle.manifest.counts,
    queryResults,
  };
}

if (require.main === module) {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const target = args[0] ? path.resolve(args[0]) : path.resolve(__dirname, "../..");
  evaluateRepo(target).then((res) => {
    console.log(JSON.stringify(res, null, 2));
    assert.equal(res.accountingExact, true, `Accounting mismatch: ${res.accounted} !== ${res.discovered}`);
    assert.equal(res.secretsLeaked, 0, "Zero secrets allowed in output");
    assert.equal(res.absRootLeaked, false, "Machine absRoot must not appear in manifest.json");
    assert.equal(res.duplicateAnchors, 0, "Anchors must be collision-free");
    assert.deepEqual(res.truncationParityIssues, [], "Every truncated section must have explicit marker");
    assert.equal(res.deterministic, true, "Two identical runs must match byte-for-byte");
    assert.equal(res.layerAWithinCap, true, "Layer A must respect token cap");
  });
}

module.exports = { evaluateRepo, buildGenericProbes, verifyTruncationParity, checkDuplicateAnchors };
