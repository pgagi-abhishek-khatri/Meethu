// Auto-derives domain-level feature groupings from directory layout, routes, IPC/API namespaces,
// dependency clusters, and docs, merging optional user overrides (features.yaml / .json).
const path = require("path");

const CONTAINER_DIRS = new Set([
  "src", "app", "apps", "lib", "core", "utils", "helpers", "shared", "common",
  "main", "renderer", "preload", "index", "components", "services", "models",
  "schemas", "routes", "api", "controllers", "hooks", "stores", "views",
  "pages", "screens", "modals", "types", "constants", "ui", "internal",
  "pkg", "cmd", "modules", "features", "domains", "packages", "test", "tests", "__tests__", "scripts",
]);

const NOISY_COMMENT_RE = /^(?:eslint|@ts-|Copyright|Licensed|SPDX|TODO|FIXME|HACK|NOTE:|iOS\s+\d+|Android\s+\d+|Workaround|See\s+http|https?:\/\/|Generated file\b|Do not edit\b|Split\s+query|Drop\s+bundled\b|Container:|A\s+span\b|<[a-z]+>)/i;

function isUsefulDocSentence(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (s.length < 20 || s.length > 200) return false;
  if (NOISY_COMMENT_RE.test(s) || /^[a-z]/.test(s)) return false;
  if (/^UI component in /i.test(s)) return false;
  if (/\b(?:span|div|inline-block|flexbox|padding|margin|z-index|tailwindcss)\b|<\/?[a-z]+>/i.test(s)) return false;
  if (/[{}();]{3,}/.test(s)) return false;
  return /^[A-Z0-9`"]/.test(s);
}

function normalizeDomainSegment(rawSeg) {
  const seg = String(rawSeg || "").trim();
  if (!seg || seg.startsWith(".") || /^\[.*\]$/.test(seg)) return "";
  // Strip Expo/Next route group parentheses: (account) -> account
  const unwrapped = seg.replace(/^\((.+)\)$/, "$1").trim();
  return unwrapped;
}

function inferFeatureKey(mod) {
  const parts = String(mod.relPath || "").replace(/\\/g, "/").split("/");
  const dirs = parts.slice(0, -1);

  // Walk forward so architectural domain roots win over leaf helper subfolders (prevents 1-folder-1-feature explosion).
  for (let i = 0; i < dirs.length; i++) {
    const clean = normalizeDomainSegment(dirs[i]);
    if (!clean) continue;
    const low = clean.toLowerCase();
    if (CONTAINER_DIRS.has(low)) continue;
    // Skip top-level workspace/package wrapper names like apps/mobile when a deeper domain exists
    if ((dirs[i - 1] === "apps" || dirs[i - 1] === "packages") && i + 1 < dirs.length) {
      continue;
    }
    return low;
  }

  const stem = path.basename(mod.relPath || "", path.extname(mod.relPath || ""));
  const cleanedStem = stem
    .replace(/\.(?:test|spec|stories)$/i, "")
    .replace(/(?:Service|Controller|Store|Panel|Page|Modal|Screen|Router|Utils|Helper|Helpers|Hook|Types)$/i, "");
  return (cleanedStem || "core").toLowerCase();
}

function matchOverrideKey(relPath, overrides) {
  if (!overrides || typeof overrides !== "object") return null;
  const norm = String(relPath || "").replace(/\\/g, "/").toLowerCase();
  for (const [k, ov] of Object.entries(overrides)) {
    const prefixes = Array.isArray(ov?.paths) ? ov.paths : ov?.pathPrefix ? [ov.pathPrefix] : [];
    for (const p of prefixes) {
      const clean = String(p || "").replace(/^\.\//, "").toLowerCase();
      if (clean && (norm.startsWith(clean) || norm.includes(`/${clean}`))) return k;
    }
  }
  return null;
}

function buildFeatureMap({
  modules = [],
  docFacts = [],
  contracts = [],
  mismatches = [],
  graph = null,
  overrides = null,
} = {}) {
  const groups = new Map();

  const ensure = (key, name = null) => {
    const k = String(key || "core").toLowerCase();
    if (!groups.has(k)) {
      groups.set(k, {
        id: k,
        name: name || k.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        source: "derived",
        confidence: "derived",
        status: "live",
        description: "",
        roles: "",
        limits: [],
        notCovered: "",
        files: [],
        docs: [],
        contracts: [],
        mismatches: [],
      });
    }
    return groups.get(k);
  };

  // Group modules into initial domains
  const rawBucket = new Map();
  for (const mod of modules) {
    const ovKey = matchOverrideKey(mod.relPath, overrides);
    const key = ovKey || inferFeatureKey(mod);
    if (!rawBucket.has(key)) rawBucket.set(key, []);
    rawBucket.get(key).push(mod);
  }

  // Collapse tiny singleton/2-file orphan buckets into connected neighbor domains or "core"
  const fileToKey = new Map();
  for (const [k, mods] of rawBucket.entries()) {
    for (const m of mods) fileToKey.set(m.relPath, k);
  }
  for (const [k, mods] of [...rawBucket.entries()]) {
    if (mods.length <= 2 && !matchOverrideKey(mods[0]?.relPath, overrides)) {
      const hasDoc = docFacts.some((d) => d.relPath.toLowerCase().includes(k));
      const hasRoute = contracts.some((c) => mods.some((m) => m.relPath === c.handlerFile));
      if (!hasDoc && !hasRoute) {
        let targetKey = "core";
        if (graph) {
          const neighborCounts = new Map();
          for (const m of mods) {
            for (const dep of [...(graph.outEdges.get(m.relPath) || []), ...(graph.inEdges.get(m.relPath) || [])]) {
              const dk = fileToKey.get(dep);
              if (dk && dk !== k && (rawBucket.get(dk)?.length || 0) >= 3) {
                neighborCounts.set(dk, (neighborCounts.get(dk) || 0) + 1);
              }
            }
          }
          const best = [...neighborCounts.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0];
          if (best) targetKey = best[0];
        }
        if (targetKey !== k) {
          if (!rawBucket.has(targetKey)) rawBucket.set(targetKey, []);
          rawBucket.get(targetKey).push(...mods);
          for (const m of mods) fileToKey.set(m.relPath, targetKey);
          rawBucket.delete(k);
        }
      }
    }
  }

  for (const [key, mods] of rawBucket.entries()) {
    const feat = ensure(key);
    for (const mod of mods) {
      const role = mod.structure?.role || "module";
      const isTest = role === "test" || role === "script";
      const fanIn = graph?.inEdges?.get(mod.relPath)?.size || 0;
      const estTokens = Math.max(1, Math.round((mod.rawCodeChars || (mod.structure?.totalLines || 10) * 36) / 4));
      const syms = [
        ...(mod.structure?.classes || []).slice(0, 3).map((c) => `${c.name} L${c.line}-L${c.endLine || c.line}`),
        ...(mod.structure?.functions || []).filter((f) => f.exported !== false).slice(0, 4).map((f) => `${f.name} L${f.line}-L${f.endLine || f.line}`),
      ];
      const isUiPrimitive = /(?:^|\/)(?:components\/ui|ui\/primitives)\//i.test(mod.relPath);
      const rawPurpose = mod.structure?.purpose || mod.purpose || "";
      feat.files.push({
        relPath: mod.relPath,
        role,
        estTokens,
        purpose: rawPurpose || `${role} (${path.basename(mod.relPath)})`,
        rawPurpose,
        parseStatus: mod.structure?.parseStatus || "full",
        language: mod.language || mod.structure?.language || "",
        todoCount: mod.todos?.length || 0,
        dirty: Boolean(mod.dirty),
        slices: syms,
        priorityScore: (isTest ? 0 : isUiPrimitive ? 4 : 10) + fanIn * (isUiPrimitive ? 0.5 : 2) + (role === "service/API client" || role === "route/page" || role === "entry point" ? 5 : 0),
        isPrimary: !isTest && role !== "utility" && !isUiPrimitive,
      });
    }
  }

  for (const doc of docFacts) {
    const lowPath = doc.relPath.toLowerCase();
    const isNestedSubmoduleDoc = /(?:^|\/)modules\/[^/]+\//i.test(lowPath) || /(?:fixtures?|examples?|__tests__)\//i.test(lowPath);
    let matched = false;
    for (const [k, feat] of groups.entries()) {
      if (isNestedSubmoduleDoc && !k.includes("module")) continue;
      if (lowPath.startsWith(`${k}/`) || lowPath.includes(`/${k}/`) || doc.title.toLowerCase() === k) {
        feat.docs.push(doc);
        matched = true;
      }
    }
    if (!matched && doc.isPriority && !doc.excludeFromRules && !isNestedSubmoduleDoc) {
      ensure("architecture", "Architecture & System Docs").docs.push(doc);
    }
  }

  for (const c of contracts) {
    for (const feat of groups.values()) {
      if (feat.files.some((f) => f.relPath === c.handlerFile || c.callers.some((cl) => cl.startsWith(`${f.relPath}:`)))) {
        feat.contracts.push(c);
      }
    }
  }

  for (const m of mismatches) {
    for (const feat of groups.values()) {
      if (feat.files.some((f) => m.detail?.includes(f.relPath))) {
        feat.mismatches.push(m);
      }
    }
  }

  if (overrides && typeof overrides === "object") {
    for (const [k, ov] of Object.entries(overrides)) {
      const feat = ensure(k, ov.name || k);
      feat.source = "overridden";
      feat.confidence = "stated";
      if (ov.description) feat.description = ov.description;
      if (ov.status) feat.status = ov.status;
      if (ov.roles) feat.roles = ov.roles;
      if (Array.isArray(ov.limits)) feat.limits = ov.limits;
      if (ov.notCovered) feat.notCovered = ov.notCovered;
      if (Array.isArray(ov.primaryFiles)) {
        for (const pf of ov.primaryFiles) {
          const hit = feat.files.find((f) => f.relPath === pf);
          if (hit) {
            hit.isPrimary = true;
            hit.priorityScore += 50;
          }
        }
      }
    }
  }

  const features = [];
  for (const feat of groups.values()) {
    feat.files.sort((a, b) => b.priorityScore - a.priorityScore || a.relPath.localeCompare(b.relPath));
    const primary = feat.files.filter((f) => f.isPrimary).slice(0, 6);
    const primarySet = new Set(primary.map((f) => f.relPath));
    const supporting = feat.files.filter((f) => !primarySet.has(f.relPath));
    const primaryTokens = primary.reduce((s, f) => s + f.estTokens, 0);

    const closure = new Set();
    if (graph) {
      for (const pf of primary) {
        for (const dep of graph.outEdges.get(pf.relPath) || []) {
          if (!primarySet.has(dep)) closure.add(dep);
        }
      }
    }

    if (feat.source !== "overridden") {
      const hasTodos = feat.files.reduce((s, f) => s + (f.todoCount || 0), 0);
      const hasDirty = feat.files.some((f) => f.dirty);
      const hasMethodMismatch = feat.mismatches.some((m) => m.type === "method_mismatch");
      if (hasTodos >= 4 && feat.contracts.length === 0 && primary.length <= 2 && hasDirty) {
        feat.status = "wip";
      } else if (hasMethodMismatch) {
        feat.status = "partial";
      } else if (primary.length === 0 && feat.docs.length > 0) {
        feat.status = "docs-only";
      } else {
        feat.status = "live";
      }
    }

    if (!feat.description) {
      feat.docs.sort((a, bD) => (a.docTier ?? 2) - (bD.docTier ?? 2) || a.relPath.split("/").length - bD.relPath.split("/").length || a.relPath.localeCompare(bD.relPath));
      const rootDoc = feat.docs.find((d) => !d.excludeFromRules && (d.docTier ?? 2) <= 2 && d.relPath.split("/").length <= 3 && isUsefulDocSentence(d.summary));
      if (rootDoc) {
        feat.description = rootDoc.summary;
      } else {
        const cleanPrimaryLead = primary.find((f) => !f.role.includes("UI") && isUsefulDocSentence(f.rawPurpose) && !f.rawPurpose.includes(".."))?.rawPurpose;
        const routes = feat.contracts.slice(0, 2).map((c) => `${c.method} ${c.path}`);
        const topNames = primary.slice(0, 3).map((f) => path.basename(f.relPath));
        const roles = [...new Set(primary.map((f) => f.role))].slice(0, 3).join(", ") || "modules";
        if (cleanPrimaryLead && primary.length <= 6) {
          feat.description = cleanPrimaryLead;
        } else if (routes.length > 0) {
          feat.description = `${feat.name} domain (${feat.files.length} files: ${topNames.join(", ")}); exposes ${routes.join(", ")}.`;
        } else {
          feat.description = `${feat.name} domain covering ${feat.files.length} files (${roles}${topNames.length ? `; key: ${topNames.join(", ")}` : ""}).`;
        }
      }
    }

    if (!feat.notCovered) {
      const testCount = feat.files.filter((f) => f.role === "test").length;
      const parts = [];
      if (supporting.length > 0) parts.push(`${supporting.length} supporting file(s)`);
      if (testCount === 0) parts.push("no colocated tests detected");
      parts.push("exact validation thresholds, error branches, and step-by-step control flow");
      feat.notCovered = `${parts.join("; ")}.`;
    }

    features.push({
      ...feat,
      primary,
      supporting,
      primaryTokens,
      closureNeighbors: [...closure].slice(0, 8),
    });
  }

  features.sort((a, b) => (b.primary.length - a.primary.length) || b.files.length - a.files.length || a.name.localeCompare(b.name));
  return features;
}

module.exports = {
  inferFeatureKey,
  buildFeatureMap,
};
