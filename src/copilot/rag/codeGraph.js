// src/copilot/rag/codeGraph.js
// Directed Import/Symbol Dependency Graph + Personalized PageRank + Directory Authority Tiers
// with tsconfig/jsconfig path alias resolution. Zero vectors, zero external API calls.

const fs = require("fs");
const path = require("path");

function directoryAuthority(relPath, queryLower = "") {
  const p = String(relPath || "").toLowerCase();

  const wantsMigrations = /\b(?:alembic|migration|migrate|schema\s+upgrade|0\d\d_)\b/.test(queryLower);
  const wantsTests = /\b(?:test|tests|spec|pytest|mocha|assert)\b/.test(queryLower);
  const wantsDocs = /\b(?:readme|docs|documentation|changelog|guide|proposal)\b/.test(queryLower);
  const wantsScripts = /\b(?:script|scripts|eval|bench|benchmark|cli)\b/.test(queryLower);

  if (/^(?:alembic|migrations)\//.test(p) || /\/migrations\//.test(p)) {
    return wantsMigrations ? 1.45 : 0.45;
  }
  if (/^(?:test|tests|__tests__)\//.test(p) || /\.(?:test|spec)\.[a-z]+$/.test(p)) {
    return wantsTests ? 1.4 : 0.55;
  }
  if (/^(?:scripts)\//.test(p)) {
    return wantsScripts ? 1.35 : 0.55;
  }
  if (/^(?:docs|carzilla-docs|examples)\//.test(p) || p.endsWith(".md")) {
    return wantsDocs ? 1.4 : 0.65;
  }
  if (/^(?:src\/copilot|src\/services|src\/helpers|app\/api|app\/services|app\/ai|app\/core)\//.test(p)) {
    return 1.35;
  }
  if (/^(?:app\/models|app\/schemas|app\/db|src\/stores|src\/utils)\//.test(p)) {
    return 1.15;
  }
  return 1.0;
}

function loadPathAliases(rootDir) {
  const aliases = []; // { prefix, targetPrefix }
  if (!rootDir) return aliases;
  for (const cfgName of ["tsconfig.json", "jsconfig.json"]) {
    const cfgPath = path.join(rootDir, cfgName);
    if (!fs.existsSync(cfgPath)) continue;
    try {
      // Strip single-line comments before parsing JSON
      const raw = fs.readFileSync(cfgPath, "utf8").replace(/^\s*\/\/.*$/gm, "");
      const parsed = JSON.parse(raw);
      const baseUrl = parsed.compilerOptions?.baseUrl ? parsed.compilerOptions.baseUrl.replace(/^\.\//, "") : "";
      const pathsObj = parsed.compilerOptions?.paths || {};
      for (const [pat, targets] of Object.entries(pathsObj)) {
        if (!Array.isArray(targets) || !targets.length) continue;
        const prefix = pat.replace(/\*$/, "");
        const targetPrefix = path.posix.join(baseUrl, targets[0].replace(/\*$/, "").replace(/^\.\//, ""));
        aliases.push({ prefix, targetPrefix });
      }
    } catch {}
  }
  return aliases;
}

function extractImportTargets(imports = []) {
  const targets = [];
  for (const imp of imports) {
    const pyFrom = /^\s*from\s+([a-zA-Z0-9_.]+)\s+import\b(.*)$/.exec(imp);
    if (pyFrom) {
      const spec = pyFrom[1];
      if (!spec.startsWith(".")) {
        targets.push(spec.replace(/\./g, "/"));
      } else {
        const dots = spec.match(/^\.+/)[0].length;
        const rest = spec.slice(dots).replace(/\./g, "/");
        const prefix = dots === 1 ? "./" : "../".repeat(dots - 1);
        if (rest) targets.push(prefix + rest);
        else {
          const first = /^\s*([A-Za-z0-9_]+)/.exec(pyFrom[2]);
          if (first) targets.push(prefix + first[1]);
        }
      }
      continue;
    }
    const pyImp = /^\s*import\s+([a-zA-Z0-9_.]+)/.exec(imp);
    if (pyImp) {
      targets.push(pyImp[1].replace(/\./g, "/"));
      continue;
    }
    const jsImp = /(?:from|require\()\s*['"]([^'"]+)['"]/.exec(imp);
    if (jsImp) {
      targets.push(jsImp[1]);
    }
  }
  return targets;
}

function buildCodeGraph(modules = [], { rootDir = null } = {}) {
  const aliases = loadPathAliases(rootDir);
  const nodePaths = modules.map((m) => m.relPath);
  const nodeSet = new Set(nodePaths);

  const byBasenameNoExt = new Map();
  const byPathNoExt = new Map();
  for (const m of modules) {
    const noExt = m.relPath.replace(/\.[^.]+$/, "");
    byPathNoExt.set(noExt, m.relPath);
    const base = path.basename(noExt);
    if (!byBasenameNoExt.has(base)) byBasenameNoExt.set(base, []);
    byBasenameNoExt.get(base).push(m.relPath);
  }

  const outEdges = new Map();
  const inEdges = new Map();
  for (const p of nodePaths) {
    outEdges.set(p, new Set());
    inEdges.set(p, new Set());
  }

  const symbolDefs = new Map();
  for (const m of modules) {
    for (const c of m.structure?.classes || []) {
      if (!symbolDefs.has(c.name)) symbolDefs.set(c.name, new Set());
      symbolDefs.get(c.name).add(m.relPath);
    }
    for (const f of m.structure?.functions || []) {
      if (f.name.length >= 4 && !["main", "init", "__init__", "setup"].includes(f.name)) {
        if (!symbolDefs.has(f.name)) symbolDefs.set(f.name, new Set());
        symbolDefs.get(f.name).add(m.relPath);
      }
    }
  }

  const resolveLookup = (candidate) =>
    byPathNoExt.get(candidate) ||
    byPathNoExt.get(`${candidate}/index`) ||
    byPathNoExt.get(`${candidate}/__init__`) ||
    (nodeSet.has(candidate) ? candidate : null);

  for (const m of modules) {
    const fromDir = path.dirname(m.relPath);
    const targets = extractImportTargets(m.structure?.imports || []);
    for (let rawTarget of targets) {
      let resolved = null;

      // Apply tsconfig/jsconfig path alias if matching
      for (const al of aliases) {
        if (rawTarget.startsWith(al.prefix)) {
          const mapped = path.posix.normalize(al.targetPrefix + rawTarget.slice(al.prefix.length));
          resolved = resolveLookup(mapped);
          if (resolved) break;
        }
      }

      if (!resolved && rawTarget.startsWith(".")) {
        const joined = path.posix.normalize(path.posix.join(fromDir === "." ? "" : fromDir, rawTarget));
        resolved = resolveLookup(joined);
      } else if (!resolved) {
        resolved = resolveLookup(rawTarget) || resolveLookup(`src/${rawTarget}`);
        if (!resolved) {
          const base = path.posix.basename(rawTarget);
          const candidates = byBasenameNoExt.get(base);
          if (candidates && candidates.length === 1) resolved = candidates[0];
        }
      }

      if (resolved && resolved !== m.relPath) {
        outEdges.get(m.relPath).add(resolved);
        inEdges.get(resolved).add(m.relPath);
      }
    }
  }

  const globalRank = runPageRank(nodePaths, outEdges, inEdges);

  return {
    nodeCount: nodePaths.length,
    edgeCount: [...outEdges.values()].reduce((s, set) => s + set.size, 0),
    outEdges,
    inEdges,
    symbolDefs,
    globalRank,
    personalizedRank(seedWeights = new Map(), iterations = 12) {
      return runPageRank(nodePaths, outEdges, inEdges, seedWeights, iterations);
    },
  };
}

function runPageRank(nodes, outEdges, inEdges, seedWeights = null, iterations = 12, damping = 0.85) {
  const N = nodes.length;
  const scores = new Map();
  if (N === 0) return scores;

  const personal = new Map();
  let seedSum = 0;
  if (seedWeights && seedWeights.size > 0) {
    for (const [n, w] of seedWeights.entries()) {
      if (w > 0 && outEdges.has(n)) seedSum += w;
    }
  }

  for (const n of nodes) {
    const pVal = seedSum > 0 ? (seedWeights.get(n) || 0) / seedSum : 1 / N;
    personal.set(n, pVal);
    scores.set(n, 1 / N);
  }

  for (let it = 0; it < iterations; it++) {
    const next = new Map();
    for (const n of nodes) next.set(n, (1 - damping) * personal.get(n));

    for (const u of nodes) {
      const s = scores.get(u);
      const outs = outEdges.get(u);
      const ins = inEdges.get(u);
      const totalDeg = outs.size * 2 + ins.size;
      if (totalDeg === 0) continue;

      const outShare = (damping * s * 2) / totalDeg;
      for (const v of outs) next.set(v, next.get(v) + outShare);
      const inShare = (damping * s) / totalDeg;
      for (const v of ins) next.set(v, next.get(v) + inShare);
    }

    for (const [k, v] of next.entries()) scores.set(k, v);
  }

  let maxS = 0;
  for (const v of scores.values()) if (v > maxS) maxS = v;
  if (maxS > 0) {
    for (const [k, v] of scores.entries()) scores.set(k, v / maxS);
  }

  return scores;
}

module.exports = {
  directoryAuthority,
  loadPathAliases,
  extractImportTargets,
  buildCodeGraph,
  runPageRank,
};
