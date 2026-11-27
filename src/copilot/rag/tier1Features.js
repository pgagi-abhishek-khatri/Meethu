// Builds Tier 1 Feature Cards (400-1,500 tokens each, NEVER dropped for size)
// matching V2 Spec §4.1 with incremental content-hash caching.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { countTokens } = require("./tokenizer");

function loadCardCache(cacheDir, absRoot) {
  if (!absRoot) return { file: null, cards: {} };
  const dir = cacheDir || path.join(os.tmpdir(), "meethu-code-cache");
  const key = crypto.createHash("sha256").update(path.resolve(absRoot)).digest("hex").slice(0, 16);
  const file = path.join(dir, `tier1-cards-${key}.json`);
  try {
    if (fs.existsSync(file)) return { file, cards: JSON.parse(fs.readFileSync(file, "utf8")) || {} };
  } catch {}
  return { file, cards: {} };
}

function saveCardCache(file, cards) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cards, null, 2), "utf8");
    fs.renameSync(tmp, file);
  } catch {}
}

function collectMultiSymbolSlices(mod) {
  const s = mod?.structure || {};
  const slices = [];
  for (const c of (s.classes || []).filter((x) => x.exported !== false).slice(0, 4)) {
    slices.push(`${c.name} L${c.line}-L${c.endLine || c.line}`);
  }
  for (const f of (s.functions || []).filter((x) => x.exported !== false).slice(0, 8)) {
    slices.push(`${f.name} L${f.line}-L${f.endLine || f.line}`);
  }
  for (const t of (s.types || []).filter((x) => x.exported !== false).slice(0, 3)) {
    slices.push(`${t.name} L${t.line}-L${t.endLine || t.line}`);
  }
  return [...new Set(slices)].slice(0, 10);
}

function buildFeatureFlow(feature, modByRel) {
  const steps = [];
  const routes = feature.primary.filter((f) => f.role === "route/page");
  const ctrls = feature.primary.filter((f) => f.role === "hook/controller" || f.role === "UI component");
  const svcs = feature.primary.filter((f) => f.role === "service/API client" || f.role === "middleware");
  const stores = feature.primary.filter((f) => f.role === "state store" || f.role === "model/schema");

  if (routes.length) steps.push(`1. Entry/Route: \`${routes[0].relPath}\``);
  if (ctrls.length) steps.push(`${steps.length + 1}. UI/Hook: \`${ctrls[0].relPath}\``);
  if (svcs.length) steps.push(`${steps.length + 1}. Service/API: \`${svcs[0].relPath}\``);
  if (stores.length) steps.push(`${steps.length + 1}. State/Data: \`${stores[0].relPath}\``);
  if (steps.length < 2 && feature.contracts?.length) {
    const c = feature.contracts[0];
    steps.push(`${steps.length + 1}. Endpoint \`${c.method} ${c.path}\` handled at \`${c.handlerFile}:L${c.handlerLine}\``);
  }
  if (steps.length === 0 && feature.primary?.length) {
    feature.primary.slice(0, 3).forEach((pf, idx) => {
      const m = modByRel.get(pf.relPath);
      const topSym = m?.structure?.functions?.[0]?.name || m?.structure?.classes?.[0]?.name || pf.role;
      steps.push(`${idx + 1}. \`${pf.relPath}\` (${topSym})`);
    });
  }
  return steps.slice(0, 6);
}

function buildTier1FeatureCards({
  features = [],
  modules = [],
  compIdMap = new Map(),
  compRevMap = new Map(),
  dataAndConfig = {},
  recentCommits = [],
  absRoot = "",
  cacheDir = null,
  maxTokensPerCard = 1500,
} = {}) {
  const modByRel = new Map(modules.map((m) => [m.relPath, m]));
  const slugToFid = new Map(features.map((f) => [f.slug || f.id, f.fid]));
  const fileToFid = new Map();
  for (const f of features) {
    for (const file of f.files || []) fileToFid.set(file.relPath, f.fid);
  }

  const { file: cacheFile, cards: prevCache } = loadCardCache(cacheDir, absRoot);
  const nextCache = {};
  const cards = [];
  let cacheHits = 0;

  const models = dataAndConfig.models || [];

  for (const f of features) {
    const owners = (f.ownerCompIds || []).map((id) => compIdMap.get(id) || id).join(",") || "C1";
    const ownerRevs = (f.ownerCompIds || []).map((id) => compRevMap.get(id)).filter(Boolean);
    const revStr = ownerRevs[0] ? ` · rev ${ownerRevs[0]}` : "";

    const cacheKey = `${f.fid}:${f.contentHash}`;
    if (f.unchanged && prevCache[cacheKey]) {
      cards.push(prevCache[cacheKey]);
      nextCache[cacheKey] = prevCache[cacheKey];
      cacheHits += 1;
      continue;
    }

    const lines = [`# ${f.fid} ${f.name} · ${f.status || "unknown"} · ${owners}${revStr}`];
    const confTag = f.confidence || (f.source === "overridden" ? "stated" : "derived");
    lines.push(`**What** [${confTag}]: ${f.description || `purpose unknown (${f.files?.length || 0} files)`}`);

    if (f.roles || (f.limits && f.limits.length)) {
      lines.push(`**Who / Limits:** ${[f.roles ? `Roles: ${f.roles}` : "", f.limits?.length ? `Limits: ${f.limits.join("; ")}` : ""].filter(Boolean).join(" | ")}`);
    }

    // Rules attached to this feature's docs
    const featRules = [];
    for (const d of f.docs || []) {
      if (d.excludeFromRules) continue;
      for (const r of d.rules || []) {
        featRules.push(`R${featRules.length + 1} ${r.text} (\`${d.relPath}:L${r.line}\`) [${r.confidence || "stated"}]`);
        if (featRules.length >= 6) break;
      }
      if (featRules.length >= 6) break;
    }
    if (featRules.length > 0) {
      lines.push("", "**Rules:**", ...featRules.map((r) => `- ${r}`));
    }

    // Step flow
    const flowSteps = buildFeatureFlow(f, modByRel);
    if (flowSteps.length > 0) {
      lines.push("", "**Flow:**", ...flowSteps);
    }

    // Primary files with multi-symbol line slices (§5.2 #23)
    if ((f.primary || []).length > 0) {
      lines.push("", `**Primary files (read order, ~${f.primaryTokens}t total):**`);
      for (const pf of f.primary) {
        const mod = modByRel.get(pf.relPath);
        const multiSlices = mod ? collectMultiSymbolSlices(mod) : pf.slices || [];
        lines.push(`- \`${pf.relPath}\` · ${pf.role} · ~${pf.estTokens}t${multiSlices.length ? ` · slices: ${multiSlices.join(", ")}` : ""}`);
      }
    }

    if ((f.supporting || []).length > 0) {
      const supSample = f.supporting.slice(0, 12).map((s) => `\`${s.relPath}\``).join(", ");
      const more = f.supporting.length > 12 ? ` (+${f.supporting.length - 12} via find())` : "";
      lines.push(`**Supporting (${f.supporting.length}):** ${supSample}${more}`);
    }

    // Contracts
    if ((f.contracts || []).length > 0) {
      lines.push("", "**Contracts:**");
      for (const c of f.contracts.slice(0, 12)) {
        const callerText = c.callers?.length ? `callers: ${c.callers.slice(0, 3).join(", ")}` : `callers: none (${c.confidence || "likely"})`;
        lines.push(`- \`${c.method} ${c.path}\` → \`${c.handlerFile}:L${c.handlerLine}\` (${callerText}, conf: ${c.confidence || "certain"})`);
      }
      if (f.contracts.length > 12) lines.push(`- +${f.contracts.length - 12} more via endpoint()`);
    }

    // Data models/tables touched
    const featTables = new Set();
    const featFileSet = new Set((f.files || []).map((x) => x.relPath));
    const matchedModels = models.filter((m) => featFileSet.has(m.file)).slice(0, 6).map((m) => `\`${m.name}\` (${m.kind})`);
    for (const pf of f.primary || []) {
      const m = modByRel.get(pf.relPath);
      for (const t of m?.structure?.tables || []) featTables.add(`\`${t}\``);
    }
    if (matchedModels.length || featTables.size) {
      lines.push(`**Data:** ${[...matchedModels, ...featTables].slice(0, 10).join(", ")}`);
    }

    // Gaps, flags, TODOs, test presence & up to 3 relevant recent commits (§5.2 #22)
    const testCount = (f.files || []).filter((x) => x.role === "test").length;
    const todos = [];
    for (const xf of (f.files || []).slice(0, 15)) {
      const m = modByRel.get(xf.relPath);
      for (const td of m?.todos || []) todos.push(`${td.tag} ${td.text} (\`${td.relPath}:L${td.line}\`)`);
    }
    const relCommits = recentCommits
      .filter((c) => Array.isArray(c.areas) && c.areas.some((a) => [...featFileSet].some((fp) => fp.startsWith(a))))
      .slice(0, 3)
      .map((c) => `\`${c.sha}\` ${c.message.slice(0, 60)}`);

    const gapParts = [`Tests: ${testCount > 0 ? `${testCount} file(s)` : "none detected"}`];
    if (f.flags?.length) gapParts.push(`Flags: ${f.flags.join(", ")}`);
    if (todos.length) gapParts.push(`TODOs: ${todos.slice(0, 3).join("; ")}`);
    if (f.mismatches?.length) gapParts.push(`Mismatches: ${f.mismatches.length}`);
    lines.push(`**Gaps:** ${gapParts.join(" | ")}`);
    if (relCommits.length) lines.push(`**Recent commits:** ${relCommits.join(" · ")}`);

    // Related features via dependency closure
    const relatedFids = new Set();
    for (const dep of f.closureNeighbors || []) {
      const rf = fileToFid.get(dep);
      if (rf && rf !== f.fid) relatedFids.add(rf);
    }
    if (relatedFids.size > 0) {
      lines.push(`**Related:** ${[...relatedFids].slice(0, 8).join(", ")}`);
    } else if (slugToFid.size > 1 && f.fid !== "F01") {
      // keep clean omitted line if empty
    }

    let md = lines.join("\n");
    let tokens = countTokens(md);
    // Keep card bounded within 400-1500 target if huge contract/doc list pushed it above cap
    if (tokens > maxTokensPerCard) {
      const compactLines = md.split("\n");
      while (countTokens(compactLines.join("\n")) > maxTokensPerCard && compactLines.length > 8) {
        compactLines.pop();
      }
      compactLines.push(`> TRUNCATED: trimmed tail lines to respect ${maxTokensPerCard}t Tier 1 card cap; full symbols/contracts via Tier 2 tools.`);
      md = compactLines.join("\n");
      tokens = countTokens(md);
    }

    const card = {
      fid: f.fid,
      slug: f.slug || f.id,
      name: f.name,
      status: f.status,
      fileName: `features/${f.fid}-${(f.slug || f.id).replace(/[^a-z0-9_-]+/g, "_")}.md`,
      markdown: md,
      tokens,
      hash: f.contentHash,
    };
    cards.push(card);
    nextCache[cacheKey] = card;
  }

  saveCardCache(cacheFile, nextCache);
  return { cards, cacheHits };
}

module.exports = {
  buildTier1FeatureCards,
  collectMultiSymbolSlices,
};
