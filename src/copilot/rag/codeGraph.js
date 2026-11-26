// src/copilot/rag/codeGraph.js
// Directed Import/Symbol Dependency Graph + Personalized PageRank + Directory Authority Tiers.
// Implements RepoGraph / LocAgent / Aider RepoMap topological ranking in pure JS (< 5ms).
// Zero vector embeddings, zero external API calls.

const path = require("path");

/**
 * Directory authority multipliers prevent migrations, tests, and docs
 * from outscoring core production modules unless explicitly requested.
 */
function directoryAuthority(relPath, queryLower = "") {
  const p = String(relPath || "").toLowerCase();

  // Explicit intent overrides
  const wantsMigrations = /\b(?:alembic|migration|migrate|schema\s+upgrade|0\d\d_)\b/.test(queryLower);
  const wantsTests = /\b(?:test|tests|spec|pytest|mocha|assert)\b/.test(queryLower);
  const wantsDocs = /\b(?:readme|docs|documentation|changelog|guide|proposal)\b/.test(queryLower);

  if (/^(?:alembic|migrations)\//.test(p) || /\/migrations\//.test(p)) {
    return wantsMigrations ? 1.45 : 0.45;
  }
  if (/^(?:test|tests|__tests__)\//.test(p) || /\.(?:test|spec)\.[a-z]+$/.test(p)) {
    return wantsTests ? 1.4 : 0.65;
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

/**
 * Extracts normalized module stem / import targets from raw import strings.
 */
function extractImportTargets(imports = []) {
  const targets = [];
  for (const imp of imports) {
    // Python: from app.services.credit_service import ... OR import app.config
    const pyFrom = /^\s*from\s+([a-zA-Z0-9_.]+)\s+import\b(.*)$/.exec(imp);
    if (pyFrom) {
      const spec = pyFrom[1];
      if (!spec.startsWith(".")) {
        targets.push(spec.replace(/\./g, "/"));
      } else {
        // Relative: one dot is this package, each further dot is one level up. `from . import util` names the module.
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
    // JS/TS: require("./foo") or import ... from "../bar/baz"
    const jsImp = /(?:from|require\()\s*['"]([^'"]+)['"]/.exec(imp);
    if (jsImp) {
      targets.push(jsImp[1]);
    }
  }
  return targets;
}

/**
 * Builds a directed repository dependency graph G = (V, E) over parsed modules.
 */
function buildCodeGraph(modules = []) {
  const nodePaths = modules.map((m) => m.relPath);
  const nodeSet = new Set(nodePaths);

  // Fast stem/suffix lookup for resolving relative & dotted imports
  const byBasenameNoExt = new Map();
  const byPathNoExt = new Map();
  for (const m of modules) {
    const noExt = m.relPath.replace(/\.[^.]+$/, "");
    byPathNoExt.set(noExt, m.relPath);
    const base = path.basename(noExt);
    if (!byBasenameNoExt.has(base)) byBasenameNoExt.set(base, []);
    byBasenameNoExt.get(base).push(m.relPath);
  }

  // Adjacency lists: outEdges (A -> B), inEdges (B <- A)
  const outEdges = new Map();
  const inEdges = new Map();
  for (const p of nodePaths) {
    outEdges.set(p, new Set());
    inEdges.set(p, new Set());
  }

  // Symbol definition map: symbolName -> Set<relPath>
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

  // Resolve import edges
  for (const m of modules) {
    const fromDir = path.dirname(m.relPath);
    const targets = extractImportTargets(m.structure?.imports || []);
    for (const rawTarget of targets) {
      let resolved = null;

      if (rawTarget.startsWith(".")) {
        const joined = path.posix.normalize(path.posix.join(fromDir === "." ? "" : fromDir, rawTarget));
        resolved =
          byPathNoExt.get(joined) ||
          byPathNoExt.get(`${joined}/index`) ||
          byPathNoExt.get(`${joined}/__init__`) ||
          (nodeSet.has(joined) ? joined : null);
      } else {
        resolved =
          byPathNoExt.get(rawTarget) ||
          byPathNoExt.get(`${rawTarget}/__init__`) ||
          byPathNoExt.get(`${rawTarget}/index`) ||
          null;
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

  // Precompute global architectural PageRank (unseeded) in ~2ms
  const globalRank = runPageRank(nodePaths, outEdges, inEdges);

  return {
    nodeCount: nodePaths.length,
    edgeCount: [...outEdges.values()].reduce((s, set) => s + set.size, 0),
    outEdges,
    inEdges,
    symbolDefs,
    globalRank,
    /**
     * Computes Personalized PageRank seeded around query-matched modules.
     */
    personalizedRank(seedWeights = new Map(), iterations = 12) {
      return runPageRank(nodePaths, outEdges, inEdges, seedWeights, iterations);
    },
  };
}

/**
 * Fast power-iteration PageRank (undirected + directed import boost).
 */
function runPageRank(nodes, outEdges, inEdges, seedWeights = null, iterations = 12, damping = 0.85) {
  const N = nodes.length;
  const scores = new Map();
  if (N === 0) return scores;

  // Build normalized personalization vector
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
    for (const n of nodes) {
      next.set(n, (1 - damping) * personal.get(n));
    }

    for (const u of nodes) {
      const s = scores.get(u);
      // Propagate mostly to imported dependencies (what u depends on gets authority!)
      const outs = outEdges.get(u);
      const ins = inEdges.get(u);
      const totalDeg = outs.size * 2 + ins.size;
      if (totalDeg === 0) continue;

      const outShare = (damping * s * 2) / totalDeg;
      for (const v of outs) {
        next.set(v, next.get(v) + outShare);
      }
      const inShare = (damping * s) / totalDeg;
      for (const v of ins) {
        next.set(v, next.get(v) + inShare);
      }
    }

    for (const [k, v] of next.entries()) scores.set(k, v);
  }

  // Normalize to [0, 1]
  let maxS = 0;
  for (const v of scores.values()) if (v > maxS) maxS = v;
  if (maxS > 0) {
    for (const [k, v] of scores.entries()) scores.set(k, v / maxS);
  }

  return scores;
}

module.exports = {
  directoryAuthority,
  extractImportTargets,
  buildCodeGraph,
  runPageRank,
};
