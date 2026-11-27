// Two-layer priority-budgeted summary compiler (Layer A Answer Layer + Layer B Routing Layer)
// and atomic tiered writer. Never silently truncates; header counts always match body entries.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { redactSecrets } = require("./secretScan");

const PRIORITY_ROLE_ORDER = {
  "model/schema": 4,
  "type definitions": 4,
  "service/API client": 5,
  "state store": 6,
  "route/page": 7,
  "entry point": 7,
  middleware: 7,
  "job/worker": 7,
  "hook/controller": 8,
  utility: 9,
  config: 9,
  "UI component": 10,
  test: 11,
  script: 12,
  migration: 12,
  CLI: 8,
  generated: 12,
};

const estTokens = (text) => Math.ceil(String(text || "").length / 4);

function safeAnchor(relPath) {
  const raw = String(relPath || "");
  const slug =
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section";
  const hash = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 6);
  return `${slug}-${hash}`;
}

function cutAtWord(text, maxChars) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (s.length <= maxChars) return s;
  const cut = s.slice(0, maxChars);
  const sp = cut.lastIndexOf(" ");
  return (sp > maxChars * 0.5 ? cut.slice(0, sp) : cut).trimEnd() + "…";
}

function budgetJoin(blocks, maxTokens, degradeNote = null) {
  const maxChars = Math.max(400, maxTokens * 4);
  const reserve = degradeNote ? degradeNote.length + 32 : 0;
  const kept = [];
  let used = 0;
  let dropped = 0;
  for (const b of blocks) {
    if (!b) continue;
    if (used + b.length + 2 + reserve > maxChars && kept.length > 0) {
      dropped += 1;
      continue;
    }
    kept.push(b);
    used += b.length + 2;
  }
  if (dropped > 0 && degradeNote) {
    kept.push(`> TRUNCATED: ${dropped} ${degradeNote}`);
  }
  return {
    text: kept.join("\n\n"),
    shown: kept.length - (dropped > 0 && degradeNote ? 1 : 0),
    total: kept.length - (dropped > 0 && degradeNote ? 1 : 0) + dropped,
    dropped,
    truncated: dropped > 0,
  };
}

function budgetRows(rows, maxChars, reserveFooter = 180) {
  const limit = Math.max(200, maxChars);
  const kept = [];
  let used = 0;
  let omitted = 0;
  for (const row of rows) {
    const addLen = row.length + 1;
    if (used + addLen + reserveFooter > limit && kept.length > 0) {
      omitted += 1;
      continue;
    }
    kept.push(row);
    used += addLen;
  }
  return {
    kept,
    usedChars: used,
    shown: kept.length,
    total: rows.length,
    omitted,
    truncated: omitted > 0,
  };
}

function buildSystemDiagram(components, features) {
  if (components.length > 1) {
    const lines = ["```text"];
    const root = components[0];
    lines.push(`[${root.name}] (${root.branch || "no-git"} ${root.revision || ""})`);
    for (const c of components.slice(1, 10)) {
      lines.push(`  ├── [${c.id}] (${c.kind}, ${c.branch || "no-git"} ${c.revision || ""})`);
    }
    lines.push("```");
    return lines.join("\n");
  }
  const topFeats = features.slice(0, 6).map((f) => `[${f.name}]`);
  return `\`\`\`text\nUser / Meeting -> ${topFeats.join(" -> ") || "[Core Modules]"}\n\`\`\``;
}

/**
 * Compiles the full tiered bundle (00_index.md .. 90_coverage.md + manifest.json + JSONL twins)
 * and a unified single-file markdown view.
 */
function compileSummaryBundle({
  absRoot,
  repoName,
  components = [],
  modules = [],
  docFacts = [],
  staleDocRefs = [],
  contracts = [],
  mismatches = [],
  events = [],
  symbols = [],
  features = [],
  glossary = [],
  dataAndConfig = {},
  graph = null,
  commits = [],
  coverage = {},
  configsIndexed = 0,
  indexedDocsMeta = [],
  indexedConfigsMeta = [],
  specialSummaries = {},
  secretsRedacted = 0,
  redactionTypes = {},
  budgets = {},
  formatCompactFileEntry,
} = {}) {
  const b = {
    index: budgets.index || 8000,
    features: budgets.features || 10000,
    contracts: budgets.contracts || 15000,
    files_per_component: budgets.files_per_component || 40000,
    symbols: budgets.symbols || 12000,
    docs: budgets.docs || 8000,
    config: budgets.config || 6000,
    data: budgets.data || 6000,
  };

  const mainComp = components[0] || { id: repoName, name: repoName, branch: null, revision: null, dirtyFiles: new Set() };
  const dirtyCount = components.reduce((s, c) => s + (c.dirtyFiles?.size || 0), 0);
  const fullCount = modules.length;
  const totalIndexed = fullCount + docFacts.length + configsIndexed;
  const skippedCount = coverage.skipped?.length || 0;
  const failedCount = coverage.failed?.length || 0;
  const totalFound = coverage.filesFound ?? totalIndexed + skippedCount + failedCount;
  const truncatedSections = {};

  // ---- 10_features.md ----
  const featBlocks = features.map((f) => {
    const out = [
      `## ${f.name} (\`${f.id}\`, source: ${f.source}, status: ${f.status})`,
      f.description,
      `- **Primary files** (~${f.primaryTokens} tokens total):`,
      ...f.primary.map((pf) => `  - \`${pf.relPath}\` (${pf.role}, ~${pf.estTokens}t) — ${pf.purpose}${pf.slices.length ? ` | Slices: ${pf.slices.join(", ")}` : ""}`),
    ];
    if (f.supporting.length > 0) {
      const shownSup = f.supporting.slice(0, 20);
      const moreSup = f.supporting.length - shownSup.length;
      out.push(`- **Supporting files (${f.supporting.length}):** ${shownSup.map((sf) => `\`${sf.relPath}\``).join(", ")}${moreSup > 0 ? ` (+${moreSup} more in \`30_files.md\` / \`files.jsonl\`)` : ""}`);
    }
    if (f.closureNeighbors.length > 0) {
      out.push(`- **Dependency closure (read next if budget allows):** ${f.closureNeighbors.map((d) => `\`${d}\``).join(", ")}`);
    }
    if (f.docs.length > 0) {
      out.push(`- **Related docs:** ${f.docs.map((d) => `\`${d.relPath}\``).join(", ")}`);
    }
    out.push(`- **Does not cover:** ${f.notCovered}`);
    return out.join("\n");
  });
  const featBudgeted = budgetJoin(featBlocks, b.features, "features omitted due to token budget; see 30_files.md");
  truncatedSections.features = {
    total: featBudgeted.total,
    shown: featBudgeted.shown,
    omitted: featBudgeted.dropped,
    truncated: featBudgeted.truncated,
  };
  const featuresMd = [
    `# Feature → Files Map (${featBudgeted.truncated ? `showing ${featBudgeted.shown} of ${featBudgeted.total}` : `${features.length}`} features)`,
    "",
    featBudgeted.text,
  ].join("\n");

  // ---- 20_contracts.md ----
  const maxContractsChars = Math.max(1200, b.contracts * 4);
  const mismatchRows = mismatches.map((m) => `| \`${m.type}\` | \`${m.path}\` | ${m.detail} |`);
  const contractRows = contracts.map((c) => {
    const meta = [c.schema, c.auth, c.versioned ? "versioned" : ""].filter(Boolean).join(", ") || "-";
    const callers = c.callers.length ? c.callers.join(", ") : "-";
    return `| \`${c.method}\` | \`${c.path}\` | \`${c.handlerFile}:L${c.handlerLine}\` | ${meta} | ${callers} |`;
  });
  const eventRows = events.map((ev) => `| ${ev.kind} | \`${ev.channel}\` | ${ev.direction} | \`${ev.file}:L${ev.line}\` |`);

  const mBudget = budgetRows(mismatchRows, Math.floor(maxContractsChars * 0.30));
  const remAfterM = maxContractsChars - mBudget.usedChars - 400;
  const cBudget = budgetRows(contractRows, Math.floor(remAfterM * 0.72));
  const remAfterC = remAfterM - cBudget.usedChars;
  const eBudget = budgetRows(eventRows, Math.max(400, remAfterC));

  const contractsTotal = mismatchRows.length + contractRows.length + eventRows.length;
  const contractsShown = mBudget.shown + cBudget.shown + eBudget.shown;
  const contractsOmitted = mBudget.omitted + cBudget.omitted + eBudget.omitted;
  truncatedSections.contracts = {
    total: contractsTotal,
    shown: contractsShown,
    omitted: contractsOmitted,
    truncated: contractsOmitted > 0,
  };

  const contractLines = [
    `# Cross-Boundary Contracts (showing ${contractsShown} of ${contractsTotal} total entries: ${cBudget.shown}/${contracts.length} routes/channels · ${mBudget.shown}/${mismatches.length} mismatches · ${eBudget.shown}/${events.length} events)`,
    "",
  ];
  if (mismatchRows.length > 0) {
    contractLines.push(
      `## Contract Mismatches (${mBudget.truncated ? `showing ${mBudget.shown} of ${mismatchRows.length}` : mismatchRows.length})`,
      "| Type | Endpoint | Detail |",
      "| :--- | :--- | :--- |",
      ...mBudget.kept
    );
    if (mBudget.truncated) {
      contractLines.push(`> TRUNCATED: omitted ${mBudget.omitted} mismatches due to contracts token budget.`);
    }
    contractLines.push("");
  }
  if (contractRows.length > 0) {
    contractLines.push(
      `## Served Endpoints & Channels (${cBudget.truncated ? `showing ${cBudget.shown} of ${contractRows.length}` : contractRows.length})`,
      "| Method | Path | Handler | Schema / Auth | Callers |",
      "| :--- | :--- | :--- | :--- | :--- |",
      ...cBudget.kept
    );
    if (cBudget.truncated) {
      contractLines.push(`> TRUNCATED: omitted ${cBudget.omitted} routes/channels; see \`contracts.jsonl\` for all records.`);
    }
  }
  if (eventRows.length > 0) {
    contractLines.push(
      "",
      `## Events, Sockets & Page Routes (${eBudget.truncated ? `showing ${eBudget.shown} of ${eventRows.length}` : eventRows.length})`,
      "| Kind | Channel / Route | Direction | Location |",
      "| :--- | :--- | :--- | :--- |",
      ...eBudget.kept
    );
    if (eBudget.truncated) {
      contractLines.push(`> TRUNCATED: omitted ${eBudget.omitted} event/route entries due to contracts token budget.`);
    }
  }
  const contractsMd = contractLines.join("\n");

  // ---- 30_files.md (all-inclusive token budget counting tree, thin table, anchors, entries, and overflow) ----
  const thinFiles = modules.filter((m) => m.structure?.isThinPassthrough);
  const richModules = modules.filter((m) => !m.structure?.isThinPassthrough);

  // Sort by Priority Order (§10.2) then PageRank fan-in then path
  const prioritized = [...richModules].sort((a, bMod) => {
    const pA = PRIORITY_ROLE_ORDER[a.structure?.role] ?? 9;
    const pB = PRIORITY_ROLE_ORDER[bMod.structure?.role] ?? 9;
    if (pA !== pB) return pA - pB;
    const fA = graph?.inEdges?.get(a.relPath)?.size || 0;
    const fB = graph?.inEdges?.get(bMod.relPath)?.size || 0;
    if (fB !== fA) return fB - fA;
    return a.relPath.localeCompare(bMod.relPath);
  });

  const maxFilesBudgetTokens = b.files_per_component * Math.max(1, components.length);
  const maxFilesChars = Math.max(1200, maxFilesBudgetTokens * 4);

  // Compact directory tree (folder counts on large repos so entry budget expands from ~130 to ~700+ modules)
  const allByDir = new Map();
  for (const mod of [...modules].sort((a, bMod) => a.relPath.localeCompare(bMod.relPath))) {
    const dir = path.dirname(mod.relPath) === "." ? "(root)" : path.dirname(mod.relPath);
    if (!allByDir.has(dir)) allByDir.set(dir, []);
    allByDir.get(dir).push(path.basename(mod.relPath));
  }
  const useFolderCountOnlyTree = modules.length > 300;
  const dirTreeRawRows = [...allByDir.entries()].map(([dir, names]) =>
    useFolderCountOnlyTree ? `- \`${dir}/\` (${names.length} files)` : `- \`${dir}/\` (${names.length}): ${names.join(", ")}`
  );
  const dirTreeBudget = budgetRows(dirTreeRawRows, Math.floor(maxFilesChars * 0.10), 120);
  const dirTreeLines = [`## Directory & Module Tree (${allByDir.size} folders)`, ...dirTreeBudget.kept];
  if (dirTreeBudget.truncated) {
    dirTreeLines.push(`> TRUNCATED: omitted ${dirTreeBudget.omitted} folder tree lines due to files token budget; see \`files.jsonl\`.`);
  }
  const dirTreeText = dirTreeLines.join("\n");

  const thinRowsAll = thinFiles.map((tf) => ({
    mod: tf,
    row: `| \`${tf.relPath}\` | ${(tf.structure?.internalImports || []).join(", ") || "-"} |`,
  }));
  const thinBudget = budgetRows(thinRowsAll.map((x) => x.row), Math.floor(maxFilesChars * 0.10), 100);
  const thinShownCount = thinBudget.shown;
  const thinOverflowMods = thinFiles.slice(thinShownCount);
  const thinTableText =
    thinShownCount > 0
      ? ["## Thin Pass-Through & Re-Export Files", "| File | Re-exports / Target |", "| :--- | :--- |", ...thinBudget.kept].join("\n")
      : "";

  const staticOverheadChars = 360 + dirTreeText.length + thinTableText.length;
  const remainingForEntriesAndOverflow = Math.max(400, maxFilesChars - staticOverheadChars);
  const fullTierCapChars = Math.floor(remainingForEntriesAndOverflow * 0.44);
  const totalEntryPoolChars = Math.floor(remainingForEntriesAndOverflow * 0.78);
  let filesUsedChars = 0;
  let filesFullCount = 0;
  let filesCompactCount = 0;
  const byComp = new Map();
  const degradedMods = [];

  for (const mod of prioritized) {
    const compId = mod.componentId || mainComp.id;
    const compObj = components.find((c) => c.id === compId);
    const relInComp = compObj && compObj.relDir && compObj.relDir !== "." && mod.relPath.startsWith(`${compObj.relDir}/`)
      ? mod.relPath.slice(compObj.relDir.length + 1)
      : mod.relPath;
    // Only report real per-file git SHA from history; never fake HEAD on untracked/older files (#4)
    const perFileRev = compObj?.fileLastRev?.get(relInComp) || compObj?.fileLastRev?.get(mod.relPath) || null;
    const commitCount = compObj?.fileCommitCount?.get(relInComp) || compObj?.fileCommitCount?.get(mod.relPath) || 0;
    const preferCompact = filesUsedChars >= fullTierCapChars;

    const entryText = formatCompactFileEntry(mod, {
      relPath: mod.relPath,
      revision: perFileRev,
      commitCount,
      includePrivate: false,
      compact: preferCompact,
    });
    const anchor = safeAnchor(mod.relPath);
    const blockCost = `<a id="${anchor}"></a>\n\`\`\`text\n${entryText}\n\`\`\`\n`.length + 28;

    if (filesUsedChars + blockCost <= totalEntryPoolChars) {
      if (!byComp.has(compId)) byComp.set(compId, new Map());
      const dir = path.dirname(mod.relPath) === "." ? "(root)" : path.dirname(mod.relPath);
      if (!byComp.get(compId).has(dir)) byComp.get(compId).set(dir, []);
      byComp.get(compId).get(dir).push({ mod, entry: entryText, anchor });
      filesUsedChars += blockCost;
      if (preferCompact) filesCompactCount += 1;
      else filesFullCount += 1;
    } else {
      degradedMods.push(mod);
    }
  }

  for (const tm of thinOverflowMods) degradedMods.push(tm);

  const folderDegraded = new Map();
  for (const mod of degradedMods) {
    const compId = mod.componentId || mainComp.id;
    const dir = path.dirname(mod.relPath) === "." ? "(root)" : path.dirname(mod.relPath);
    const fKey = `${compId}::${dir}`;
    if (!folderDegraded.has(fKey)) folderDegraded.set(fKey, []);
    folderDegraded.get(fKey).push(path.basename(mod.relPath));
  }
  const filesDegradedCount = degradedMods.length;
  truncatedSections.files = {
    total: modules.length,
    shown: filesFullCount + filesCompactCount + thinShownCount,
    omitted: filesDegradedCount,
    truncated: filesDegradedCount > 0 || dirTreeBudget.truncated,
  };

  const fileSections = [
    `# File Index (${filesFullCount} full, ${filesCompactCount} compact, ${thinShownCount} thin pass-throughs, ${filesDegradedCount} folder-summarised; total ${modules.length} code modules)`,
    "",
  ];
  if (filesDegradedCount > 0) {
    fileSections.push(
      `> TRUNCATED: ${filesDegradedCount} lower-priority entries collapsed at folder level below to stay within ${maxFilesBudgetTokens} token budget; complete list in \`files.jsonl\`.`,
      ""
    );
  }
  fileSections.push(dirTreeText);
  if (thinTableText) fileSections.push("", thinTableText);

  fileSections.push("", "## Module-by-Module Code-to-MD Specifications");
  for (const [compId, dirMap] of byComp.entries()) {
    fileSections.push("", `## Component: ${compId}`);
    for (const [dir, items] of [...dirMap.entries()].sort((a, bDir) => a[0].localeCompare(bDir[0]))) {
      fileSections.push("", `### ${dir}`);
      for (const { entry, anchor } of items) {
        fileSections.push(`<a id="${anchor}"></a>`, "```text", entry, "```");
      }
    }
  }

  if (folderDegraded.size > 0) {
    const overflowBudgetChars = Math.max(300, maxFilesChars - fileSections.join("\n").length - 120);
    const overflowRows = [...folderDegraded.entries()]
      .sort((a, bF) => a[0].localeCompare(bF[0]))
      .map(([fKey, names]) => {
        const [compId, dir] = fKey.split("::");
        return `- **\`${compId}/${dir}\`** (${names.length} files): ${names.join(", ")}`;
      });
    const ovBudget = budgetRows(overflowRows, overflowBudgetChars, 140);
    fileSections.push("", "## Folder-Summarised Files (Budget Overflow)", ...ovBudget.kept);
    if (ovBudget.truncated) {
      fileSections.push(`> TRUNCATED: omitted ${ovBudget.omitted} overflow folder lines due to tight files budget; see \`files.jsonl\` for all ${modules.length} modules.`);
    }
  }
  const filesMd = fileSections.join("\n");

  // ---- 40_symbols.md ----
  const totalSymbolsCount = symbols.totalDiscovered ?? symbols.length;
  const maxSymbolsChars = Math.max(600, b.symbols * 4);
  const prioritizedSymRows = symbols.map((s) => ({
    s,
    row: `| \`${s.symbol}\` | ${s.kind} | \`${s.relPath}:L${s.line}${s.endLine && s.endLine !== s.line ? `-L${s.endLine}` : ""}\` |`,
  }));
  const symBudget = budgetRows(prioritizedSymRows.map((x) => x.row), maxSymbolsChars - 220, 140);
  const keptSymbolObjs = prioritizedSymRows.slice(0, symBudget.shown);
  keptSymbolObjs.sort((a, bSym) => a.s.symbol.localeCompare(bSym.s.symbol) || a.s.relPath.localeCompare(bSym.s.relPath));
  const symDropped = Math.max(0, totalSymbolsCount - keptSymbolObjs.length);
  truncatedSections.symbols = {
    total: totalSymbolsCount,
    shown: keptSymbolObjs.length,
    omitted: symDropped,
    truncated: symDropped > 0,
  };
  const symbolsMd = [
    `# Symbol Index (showing ${keptSymbolObjs.length} of ${totalSymbolsCount} symbols)`,
    ...(symDropped > 0
      ? [`> TRUNCATED: omitted ${symDropped} lower-priority symbols due to ${b.symbols} token budget (priority subset across A–Z retained; full list in \`symbols.jsonl\`).`]
      : []),
    "",
    "| Symbol | Kind | Location |",
    "| :--- | :--- | :--- |",
    ...keptSymbolObjs.map((x) => x.row),
  ].join("\n");

  // ---- 50_docs.md ----
  const docBlocks = [...docFacts]
    .sort((a, bDoc) => Number(bDoc.isPriority) - Number(a.isPriority) || a.relPath.localeCompare(b.relPath))
    .map((d) => {
      const lines = [
        `## \`${d.relPath}\` (${d.totalLines} lines, ~${d.estTokens}t${d.date ? `, ${d.date}` : ""})`,
        d.summary,
      ];
      if (d.headings.length > 0) {
        lines.push(`- **Outline (${d.headings.length}):** ${d.headings.map((h) => `${"#".repeat(h.level)} ${h.text} (L${h.line})`).join(" · ")}`);
      }
      if (d.rules.length > 0) {
        lines.push(`- **Rules (${d.rules.length}):** ${d.rules.map((r) => `${r.text} [L${r.line}]`).join(" | ")}`);
      }
      return lines.join("\n");
    });
  if (staleDocRefs.length > 0) {
    docBlocks.push(
      [`## Stale Doc References (${staleDocRefs.length})`, ...staleDocRefs.map((s) => `- \`${s.docPath}\` mentions missing path \`${s.missingRef}\``)].join("\n")
    );
  }
  const docBudgeted = budgetJoin(docBlocks, b.docs, "doc outlines omitted due to docs token budget; see 90_coverage.md");
  truncatedSections.docs = {
    total: docBudgeted.total,
    shown: docBudgeted.shown,
    omitted: docBudgeted.dropped,
    truncated: docBudgeted.truncated,
  };
  const docsMd = [
    `# Documentation Index (${docBudgeted.truncated ? `showing ${docBudgeted.shown} of ${docBudgeted.total} sections for ` : ""}${docFacts.length} docs)`,
    "",
    docBudgeted.text,
  ].join("\n");

  // ---- 60_config.md ----
  const maxConfigChars = Math.max(800, b.config * 4);
  const scripts = dataAndConfig.scripts || [];
  const envVars = dataAndConfig.envVars || [];
  const ciJobs = dataAndConfig.ciJobs || [];
  const extPkgs = dataAndConfig.externalPackages || [];

  const scBudget = budgetRows(
    scripts.map((sc) => `| \`${sc.component}\` | \`${sc.name}\` | \`${sc.command.replace(/\|/g, "\\|")}\` | \`${sc.file}\` |`),
    Math.floor(maxConfigChars * 0.25)
  );
  const envBudget = budgetRows(
    envVars.map((ev) => `| \`${ev.name}\` | ${ev.documented ? "yes" : "no"} | ${ev.hasDefault ? "yes" : "no"} | ${[...ev.files].slice(0, 3).map((f) => `\`${f}\``).join(", ") || "-"} |`),
    Math.floor(maxConfigChars * 0.28)
  );
  const hasMultiPkgInComp = new Map();
  for (const p of extPkgs) {
    const k = `${p.component}`;
    if (!hasMultiPkgInComp.has(k)) hasMultiPkgInComp.set(k, new Set());
    hasMultiPkgInComp.get(k).add(p.packageFile || "package.json");
  }
  const pkgBudget = budgetRows(
    extPkgs.map((p) => {
      const pkgLabel = (hasMultiPkgInComp.get(p.component)?.size || 0) > 1 && p.packageFile ? `${p.component} (${path.dirname(p.packageFile)})` : p.component;
      return `| \`${pkgLabel}\` | \`${p.name}\` | \`${p.version}\` | ${p.kind} | ${p.sites} |`;
    }),
    Math.max(400, maxConfigChars - scBudget.usedChars - envBudget.usedChars - 800)
  );
  const cfgOmitted = scBudget.omitted + envBudget.omitted + pkgBudget.omitted;
  truncatedSections.config = {
    total: scripts.length + envVars.length + extPkgs.length,
    shown: scBudget.shown + envBudget.shown + pkgBudget.shown,
    omitted: cfgOmitted,
    truncated: cfgOmitted > 0,
  };

  const cfgLines = [`# Config, Environment, Scripts & Dependencies`, ""];
  if (scripts.length > 0) {
    cfgLines.push(`## Scripts & Commands (${scBudget.truncated ? `showing ${scBudget.shown} of ${scripts.length}` : scripts.length})`, "| Component | Script | Command | Source |", "| :--- | :--- | :--- | :--- |", ...scBudget.kept);
    if (scBudget.truncated) cfgLines.push(`> TRUNCATED: omitted ${scBudget.omitted} scripts due to config token budget.`);
    cfgLines.push("");
  }
  if (envVars.length > 0) {
    cfgLines.push(`## Environment Variables (Names Only — No Values, ${envBudget.truncated ? `showing ${envBudget.shown} of ${envVars.length}` : envVars.length})`, "| Variable | Documented | Default | Read In |", "| :--- | :---: | :---: | :--- |", ...envBudget.kept);
    if (envBudget.truncated) cfgLines.push(`> TRUNCATED: omitted ${envBudget.omitted} environment variables due to config token budget.`);
    cfgLines.push("");
  }
  if (ciJobs.length > 0) {
    cfgLines.push("## CI Workflows");
    for (const j of ciJobs) cfgLines.push(`- **${j.name}** (\`${j.file}\`): triggers [${j.triggers.join(", ")}]`);
    cfgLines.push("");
  }
  if (graph) {
    const hubs = [...modules]
      .map((m) => ({ relPath: m.relPath, inDeg: graph.inEdges.get(m.relPath)?.size || 0 }))
      .filter((x) => x.inDeg > 0)
      .sort((a, bHub) => bHub.inDeg - a.inDeg || a.relPath.localeCompare(bHub.relPath))
      .slice(0, 20);
    if (hubs.length > 0) {
      cfgLines.push("## Highest Fan-In Internal Hubs", "| File | Dependents |", "| :--- | ---: |");
      for (const h of hubs) cfgLines.push(`| \`${h.relPath}\` | ${h.inDeg} |`);
      cfgLines.push("");
    }
  }
  if (extPkgs.length > 0) {
    cfgLines.push(`## External Packages (Component-Level, ${pkgBudget.truncated ? `showing ${pkgBudget.shown} of ${extPkgs.length}` : extPkgs.length})`, "| Component | Package | Version | Scope | Import Sites |", "| :--- | :--- | :--- | :--- | ---: |", ...pkgBudget.kept);
    if (pkgBudget.truncated) cfgLines.push(`> TRUNCATED: omitted ${pkgBudget.omitted} external packages due to config token budget.`);
  }
  const configMd = cfgLines.join("\n");

  // ---- 70_data.md ----
  const maxDataChars = Math.max(800, b.data * 4);
  const models = dataAndConfig.models || [];
  const migrations = dataAndConfig.migrations || [];
  const modBudget = budgetRows(
    models.map((m) => `| \`${m.name}\` | ${m.kind} | \`${m.file}:L${m.line}\` | ${m.fields.join(", ") || "-"} |`),
    Math.floor(maxDataChars * 0.55)
  );
  const migBudget = budgetRows(
    migrations.map((mg) => `- \`${mg.relPath}\`${mg.rev ? ` (rev: \`${mg.rev}\`, down: \`${mg.downRev || "None"}\`)` : ""}`),
    Math.max(400, maxDataChars - modBudget.usedChars - 240)
  );
  const dataOmitted = modBudget.omitted + migBudget.omitted;
  truncatedSections.data = {
    total: models.length + migrations.length,
    shown: modBudget.shown + migBudget.shown,
    omitted: dataOmitted,
    truncated: dataOmitted > 0,
  };
  const dataLines = [`# Data Models & Migrations`, ""];
  if (models.length > 0) {
    dataLines.push(`## Models & Tables (${modBudget.truncated ? `showing ${modBudget.shown} of ${models.length}` : models.length})`, "| Model / Table | Kind | Location | Fields |", "| :--- | :--- | :--- | :--- |", ...modBudget.kept);
    if (modBudget.truncated) dataLines.push(`> TRUNCATED: omitted ${modBudget.omitted} models due to data token budget.`);
    dataLines.push("");
  }
  if (migrations.length > 0) {
    if ((dataAndConfig.migrationHeads || []).length > 1) {
      dataLines.push(`> WARNING: Multiple migration heads detected (${dataAndConfig.migrationHeads.map((h) => h.rev).join(", ")})`, "");
    }
    dataLines.push(`## Migrations (${migBudget.truncated ? `showing ${migBudget.shown} of ${migrations.length}` : migrations.length})`, ...migBudget.kept);
    if (migBudget.truncated) dataLines.push(`> TRUNCATED: omitted ${migBudget.omitted} migrations due to data token budget.`);
  }
  const dataMd = dataLines.join("\n");

  // ---- 00_index.md (Layer A — Answer Layer, hard token cap, stable first / volatile last) ----
  const headerWarning = secretsRedacted > 0 ? `\n> SECURITY NOTICE: ${secretsRedacted} secret pattern(s) redacted; ${coverage.secretsNotRead?.length || 0} secret file(s) excluded without reading.` : "";

  // Stack & System Purpose synthesis (#12)
  const langCounts = new Map();
  for (const m of modules) {
    if (m.language) langCounts.set(m.language, (langCounts.get(m.language) || 0) + 1);
  }
  const topLangs = [...langCounts.entries()]
    .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
    .slice(0, 5)
    .map(([l, cnt]) => `${l} (${cnt})`);
  const rootReadme = docFacts.find((d) => /^readme\.md$/i.test(d.relPath)) || docFacts.find((d) => /^[^/]+\/readme\.md$/i.test(d.relPath) && !/^modules\//i.test(d.relPath));
  const pkgDesc = dataAndConfig.projectMeta?.description || "";
  const sysLead = pkgDesc
    ? `[stated] ${cutAtWord(pkgDesc, 220)}`
    : rootReadme?.summary
      ? `[stated] ${cutAtWord(rootReadme.summary, 220)}`
      : `[derived] ${repoName} comprises ${components.length} component(s) and ${modules.length} code modules across ${topLangs.join(", ") || "source files"}.`;

  const rootRunScripts = scripts.filter((s) => s.isComponentRoot && /^(?:dev|start|serve|build|test|lint|typecheck)/i.test(s.name));
  const deployList = dataAndConfig.deployFiles || [];
  const runDeployLines = [];
  if (rootRunScripts.length > 0) {
    runDeployLines.push(`- **Commands:** ${rootRunScripts.slice(0, 6).map((s) => `\`${s.name}\` (\`${cutAtWord(s.command, 45)}\`)`).join(" · ")}`);
  }
  if (deployList.length > 0 || ciJobs.length > 0) {
    runDeployLines.push(`- **Build / CI / Deploy:** ${[...deployList.map((f) => `\`${f}\``), ...ciJobs.slice(0, 4).map((j) => `${j.name} (\`${j.file}\`)`)].join(", ")}`);
  }

  const layerAStable = [
    `# ${repoName} — Context Index (Layer A)`,
    `> Coverage: ${totalFound} discovered · ${fullCount} code · ${docFacts.length} docs · ${configsIndexed} configs · ${skippedCount} skipped · ${failedCount} failed${filesDegradedCount > 0 ? ` · TRUNCATED (${filesDegradedCount} folder-summarised in 30_files.md)` : ""}${headerWarning}`,
    "",
    `## Question Routing Guide (Fast vs Deep)`,
    `- **Answer from Layer A (Fast):** overview, component roles, feature rules/status, glossary terms, high-level architecture. Prefer \`[stated]\` facts over \`[derived]\` or \`[auto]\`.`,
    `- **Escalate to Deep (read targeted \`Lstart-Lend\` slices via Layer B):** exact validation thresholds, error messages, branch conditions, step-by-step control flow, "what happens when", impact analysis.`,
    `- **Not in summary:** state clearly what is missing and offer to inspect the code.`,
    "",
    `## System Overview`,
    sysLead,
    `- **Architecture:** ${components.length} component(s) (${components.map((c) => `\`${c.id}\``).join(", ")}), ${modules.length} modules, ${docFacts.length} docs, ${contracts.length} contracts.`,
    ...(topLangs.length ? [`- **Primary stack:** ${topLangs.join(", ")}`] : []),
    ...runDeployLines,
    buildSystemDiagram(components, features),
    "",
    `## Components`,
    `| Component | VCS / Branch | Revision | Entry / Test |`,
    `| :--- | :--- | :--- | :--- |`,
    ...components.map((c) => {
      const compRootScripts = scripts.filter((s) => s.isComponentRoot && (s.component === c.id || (c.id === mainComp.id && s.component === "root")));
      const poolScripts = compRootScripts.length > 0 ? compRootScripts : scripts.filter((s) => s.component === c.id || (c.id === mainComp.id && s.component === "root"));
      const compScripts = poolScripts.slice(0, 4).map((s) => `\`${s.name}\``).join(", ") || "-";
      return `| \`${c.id}\` | ${c.vcs}${c.branch ? ` (${c.branch})` : ""} | \`${c.revision || "-"}\` | ${compScripts} |`;
    }),
  ].join("\n");

  // Feature catalogue for Layer A (#9-#11, #18 confidence tag)
  const layerAFeatRows = features.map((f) => {
    const tag = f.confidence === "auto" ? "[auto]" : f.source === "overridden" ? "[stated]" : "[derived]";
    const primaryRef = f.primary.slice(0, 3).map((p) => `\`${p.relPath}\``).join(", ") || "-";
    return `- **${f.name}** ${tag} (${f.status}): ${cutAtWord(f.description, 170)} Primary: ${primaryRef}. *Does not cover:* ${cutAtWord(f.notCovered, 90)}`;
  });
  const featCatBudget = budgetRows(layerAFeatRows, Math.floor(b.index * 4 * 0.42), 100);
  const featCatLines = [
    `## Feature Catalogue (${featCatBudget.truncated ? `showing ${featCatBudget.shown} of ${features.length}` : features.length} features — see 10_features.md for slices)`,
    ...featCatBudget.kept,
    ...(featCatBudget.truncated ? [`> TRUNCATED: omitted ${featCatBudget.omitted} smaller features; see \`10_features.md\`.`] : []),
  ].join("\n");

  // Stated rules & decisions from docs sorted by docTier (CLAUDE/OKF/ARCHITECTURE first, CHANGELOG/templates excluded) (#14)
  const rankedRuleEntries = [];
  for (const d of docFacts) {
    if (d.excludeFromRules) continue;
    const tier = d.docTier ?? (d.isPriority ? 1 : 2);
    for (const r of d.rules || []) {
      rankedRuleEntries.push({
        tier,
        relPath: d.relPath,
        line: r.line,
        rendered: `- [stated] ${cutAtWord(r.text, 160)} (\`${d.relPath}:L${r.line}\`)`,
      });
    }
  }
  rankedRuleEntries.sort((x, y) => x.tier - y.tier || x.relPath.localeCompare(y.relPath) || x.line - y.line);
  const ruleBudget = budgetRows(rankedRuleEntries.map((x) => x.rendered), Math.floor(b.index * 4 * 0.22), 80);
  const rulesSection = rankedRuleEntries.length
    ? [
        `## Rules & Decisions (${ruleBudget.truncated ? `showing ${ruleBudget.shown} of ${rankedRuleEntries.length}` : rankedRuleEntries.length} — see 50_docs.md)`,
        ...ruleBudget.kept,
      ].join("\n")
    : "";

  // Meeting glossary & spoken aliases (#15)
  const glossaryRows = glossary.map((g) => `| ${g.spoken}${g.mishearings.length ? ` (aka ${g.mishearings.join(", ")})` : ""} | ${g.targetType} | \`${g.target}\` |`);
  const glossaryBudget = budgetRows(glossaryRows, Math.floor(b.index * 4 * 0.20), 80);
  const glossarySection = glossary.length
    ? [
        `## Meeting Glossary & Spoken Aliases (${glossaryBudget.truncated ? `showing ${glossaryBudget.shown} of ${glossary.length}` : glossary.length})`,
        `| Spoken / Term | Maps To | Target |`,
        `| :--- | :--- | :--- |`,
        ...glossaryBudget.kept,
      ].join("\n")
    : "";

  // Volatile section last for prompt-cache friendliness (+ TODO/FIXME scan #12)
  const allTodos = [];
  for (const m of modules) {
    for (const td of m.todos || []) allTodos.push(td);
  }
  allTodos.sort((x, y) => x.relPath.localeCompare(y.relPath) || x.line - y.line);

  const gaps = [];
  if (dirtyCount > 0) gaps.push(`- **Uncommitted changes (${dirtyCount} files):** ${components.flatMap((c) => [...(c.dirtyFiles || [])]).slice(0, 8).map((p) => `\`${p}\``).join(", ")}`);
  if (allTodos.length > 0) {
    gaps.push(`- **In-flight TODO/FIXME (${allTodos.length}):** ${allTodos.slice(0, 5).map((td) => `${td.tag} "${cutAtWord(td.text, 55)}" (\`${td.relPath}:L${td.line}\`)`).join("; ")}`);
  }
  if (mismatches.length > 0) gaps.push(`- **Contract mismatches (${mismatches.length}):** ${mismatches.slice(0, 4).map((m) => `${m.type} \`${m.path}\``).join("; ")} (see \`20_contracts.md\`)`);
  if (staleDocRefs.length > 0) gaps.push(`- **Stale doc references (${staleDocRefs.length}):** see \`50_docs.md\``);
  if ((dataAndConfig.migrationHeads || []).length > 1) gaps.push(`- **Multiple migration heads:** see \`70_data.md\``);
  const gapsSection = gaps.length ? [`## Known Gaps & In-Flight Work`, ...gaps].join("\n") : "";

  const commitLines = commits.slice(0, 10).map((c) => {
    const cleanMsg = redactSecrets(String(c.message || "")).text;
    const areasTag = Array.isArray(c.areas) && c.areas.length ? ` [${c.areas.slice(0, 3).join(", ")}]` : "";
    return `- \`${c.sha}\` (${c.date}): ${cutAtWord(cleanMsg, 80)}${areasTag}`;
  });
  const commitsSection = commitLines.length ? [`## Recent Commits`, ...commitLines].join("\n") : "";

  const layerABlocks = [layerAStable, featCatLines, rulesSection, glossarySection, gapsSection, commitsSection].filter(Boolean);
  const layerABudgeted = budgetJoin(layerABlocks, b.index, "Layer A sections trimmed to stay under fast-path token cap; see Layer B files");
  const indexMd = layerABudgeted.text;
  truncatedSections.index = {
    total: layerABudgeted.total,
    shown: layerABudgeted.shown,
    omitted: layerABudgeted.dropped,
    truncated: layerABudgeted.truncated,
  };

  // ---- 90_coverage.md (built last so header accounting & truncation summary match 100% of body) ----
  const sortedRedactionEntries = Object.entries(redactionTypes).sort((a, bE) => a[0].localeCompare(bE[0]));
  const covLines = [
    `# Coverage & Accounting Report: ${repoName}`,
    "",
    `| Component | VCS | Branch | Revision | Dirty Files | Submodules |`,
    `| :--- | :--- | :--- | :--- | ---: | :--- |`,
    ...components.map((c) => {
      const subSummary = (c.submodules || []).length
        ? c.submodules.map((s) => `${s.path} (${s.initialized ? `checked:${s.checkedOutSha || "?"} pinned:${s.pinnedSha || "?"}` : "uninitialized"})`).join("; ")
        : "none";
      return `| \`${c.id}\` | ${c.vcs}${c.isShallow ? " (shallow)" : ""}${c.isWorktree ? " (worktree)" : ""} | \`${c.branch || "-"}\` | \`${c.revision || "-"}\` | ${c.dirtyFiles?.size || 0} | ${subSummary} |`;
    }),
    "",
    `## File Accounting`,
    `- **Files discovered (post-dir-ignore):** ${totalFound}`,
    `- **Indexed in full (code + docs + configs):** ${totalIndexed} (${fullCount} code modules, ${docFacts.length} docs, ${configsIndexed} configs)`,
    `- **Skipped (accounted with reason):** ${skippedCount}`,
    `- **Failed / unreadable:** ${failedCount}`,
    `- **Accounted total:** ${totalIndexed + skippedCount + failedCount} / ${totalFound}`,
    `- **Secrets not opened (deny-list):** ${coverage.secretsNotRead?.length || 0}`,
    `- **Secrets redacted inside content:** ${secretsRedacted}${sortedRedactionEntries.length ? ` (${sortedRedactionEntries.map(([k, v]) => `${k}:${v}`).join(", ")})` : ""}`,
    `- **Out-of-root symlinks refused:** ${coverage.outOfRootSymlinks || 0} · **Symlink loops skipped:** ${coverage.symlinkLoops || 0}`,
    "",
    `## Truncated Sections Summary`,
    `| Section | Shown | Total | Omitted | Status |`,
    `| :--- | ---: | ---: | ---: | :--- |`,
    ...Object.entries(truncatedSections).map(
      ([sec, st]) => {
        const label = sec === "contracts" ? "contracts (routes+mismatches+events)" : sec;
        return `| \`${label}\` | ${st.shown} | ${st.total} | ${st.omitted} | ${st.truncated ? "TRUNCATED" : "complete"} |`;
      }
    ),
  ];

  if (Object.keys(coverage.ignoredByRule || {}).length > 0) {
    covLines.push("", "## Excluded by Ignore Rules", "| Rule | Files Counted | Details |", "| :--- | ---: | :--- |");
    for (const [rule, cnt] of Object.entries(coverage.ignoredByRule).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))) {
      const meta = coverage.ignoredMetaByRule?.[rule];
      const detail = meta && meta.dirs > 0 ? `${meta.dirs} dir(s)${meta.capped ? ", per-dir cap reached" : ""}` : "file rule";
      covLines.push(`| \`${rule}\` | ${cnt} | ${detail} |`);
    }
  }
  if ((coverage.secretsNotRead || []).length > 0) {
    covLines.push("", `## Secrets Not Read (Deny-List, ${coverage.secretsNotRead.length})`);
    for (const s of [...coverage.secretsNotRead].sort((a, bS) => a.relPath.localeCompare(bS.relPath))) {
      covLines.push(`- \`${s.relPath}\` [secret: not read]`);
    }
  }
  if ((coverage.skipped || []).length > 0) {
    const byReason = new Map();
    const otherExts = new Map();
    for (const s of coverage.skipped) {
      byReason.set(s.reason, (byReason.get(s.reason) || 0) + 1);
      if (s.reason === "other") {
        const ext = path.extname(s.relPath).toLowerCase() || "(no ext)";
        otherExts.set(ext, (otherExts.get(ext) || 0) + 1);
      }
    }
    covLines.push("", "## Skipped Files by Reason", "| Reason | Count |", "| :--- | ---: |");
    for (const [reason, cnt] of [...byReason.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))) {
      covLines.push(`| \`${reason}\` | ${cnt} |`);
    }
    if (otherExts.size > 0) {
      covLines.push("", "### Unrecognized Extensions Under `other`", ...[...otherExts.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([ext, cnt]) => `- \`${ext}\`: ${cnt}`));
    }
  }
  if ((coverage.failed || []).length > 0) {
    covLines.push("", `## Failed Files (${coverage.failed.length})`);
    for (const f of coverage.failed) {
      covLines.push(`- \`${f.relPath}\`: ${f.reason}`);
    }
  }
  if ((specialSummaries.binaries || []).length > 0) {
    covLines.push("", "## Binary & Media Assets (By Folder)", "| Folder | Count | Total Bytes | Types |", "| :--- | ---: | ---: | :--- |");
    for (const bin of specialSummaries.binaries) {
      covLines.push(`| \`${bin.dir}\` | ${bin.count} | ${bin.bytes} | ${bin.exts.join(", ")} |`);
    }
  }
  const coverageMd = covLines.join("\n");

  // ---- manifest.json & JSONL twins ----
  const filesMap = {
    "00_index.md": indexMd,
    "10_features.md": featuresMd,
    "20_contracts.md": contractsMd,
    "30_files.md": filesMd,
    "40_symbols.md": symbolsMd,
    "50_docs.md": docsMd,
    "60_config.md": configMd,
    "70_data.md": dataMd,
    "90_coverage.md": coverageMd,
  };

  const anyTruncated = Object.values(truncatedSections).some((s) => s.truncated);
  const manifest = {
    schemaVersion: 3,
    repoName,
    root: ".",
    components: components.map((c) => ({
      id: c.id,
      kind: c.kind,
      relDir: c.relDir || ".",
      vcs: c.vcs,
      branch: c.branch,
      revision: c.revision,
      isShallow: Boolean(c.isShallow),
      isWorktree: Boolean(c.isWorktree),
      dirtyCount: c.dirtyFiles?.size || 0,
      remoteUrl: c.remoteUrl || "",
    })),
    counts: {
      discovered: totalFound,
      codeModules: modules.length,
      docs: docFacts.length,
      configs: configsIndexed,
      contracts: contracts.length,
      mismatches: mismatches.length,
      symbols: totalSymbolsCount,
      symbolsShown: keptSymbolObjs.length,
      features: features.length,
      skipped: skippedCount,
      failed: failedCount,
      secretsNotRead: coverage.secretsNotRead?.length || 0,
      secretsRedacted,
    },
    truncated: anyTruncated,
    truncatedSections,
    sections: Object.fromEntries(
      Object.entries(filesMap).map(([name, md]) => [name, { chars: md.length, estTokens: estTokens(md) }])
    ),
    files: [
      ...modules.map((m) => ({
        relPath: m.relPath,
        kind: "code",
        componentId: m.componentId || mainComp.id,
        role: m.structure?.role || "module",
        estTokens: Math.max(1, Math.round((m.rawCodeChars || (m.structure?.totalLines || 10) * 36) / 4)),
        hash: m.contentHash || null,
        dirty: Boolean(m.dirty),
      })),
      ...indexedDocsMeta.map((d) => ({
        relPath: d.relPath,
        kind: "doc",
        componentId: d.componentId || mainComp.id,
        role: "doc",
        estTokens: d.estTokens || 1,
        hash: d.hash || null,
        dirty: Boolean(d.dirty),
      })),
      ...indexedConfigsMeta.map((c) => ({
        relPath: c.relPath,
        kind: "config",
        componentId: c.componentId || mainComp.id,
        role: "config",
        estTokens: c.estTokens || 1,
        hash: c.hash || null,
        dirty: Boolean(c.dirty),
      })),
    ].sort((x, y) => x.relPath.localeCompare(y.relPath)),
  };

  const jsonlTwins = {
    "symbols.jsonl": symbols.map((s) => JSON.stringify(s)).join("\n"),
    "contracts.jsonl": contracts.map((c) => JSON.stringify(c)).join("\n"),
    "files.jsonl": manifest.files.map((f) => JSON.stringify(f)).join("\n"),
  };

  // Single-file view keeping exact section order + TOC
  const toc = [
    `- [Layer A: Context Index](#${safeAnchor("00_index.md")})`,
    `- [Feature Map](#${safeAnchor("10_features.md")})`,
    `- [Contracts](#${safeAnchor("20_contracts.md")})`,
    `- [Files](#${safeAnchor("30_files.md")})`,
    `- [Symbols](#${safeAnchor("40_symbols.md")})`,
    `- [Docs](#${safeAnchor("50_docs.md")})`,
    `- [Config & Dependencies](#${safeAnchor("60_config.md")})`,
    `- [Data & Migrations](#${safeAnchor("70_data.md")})`,
    `- [Coverage](#${safeAnchor("90_coverage.md")})`,
  ].join("\n");

  const singleMarkdown = [
    `# Repository Context: ${repoName}`,
    `## Table of Contents\n${toc}`,
    `<a id="${safeAnchor("00_index.md")}"></a>\n${indexMd}`,
    `<a id="${safeAnchor("10_features.md")}"></a>\n${featuresMd}`,
    `<a id="${safeAnchor("20_contracts.md")}"></a>\n${contractsMd}`,
    `<a id="${safeAnchor("30_files.md")}"></a>\n${filesMd}`,
    `<a id="${safeAnchor("40_symbols.md")}"></a>\n${symbolsMd}`,
    `<a id="${safeAnchor("50_docs.md")}"></a>\n${docsMd}`,
    `<a id="${safeAnchor("60_config.md")}"></a>\n${configMd}`,
    `<a id="${safeAnchor("70_data.md")}"></a>\n${dataMd}`,
    `<a id="${safeAnchor("90_coverage.md")}"></a>\n${coverageMd}`,
  ].join("\n\n---\n\n");

  return {
    files: filesMap,
    manifest,
    jsonlTwins,
    singleMarkdown,
    layerA: indexMd,
    layerATokens: estTokens(indexMd),
  };
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

function writeSummaryBundleAtomic(outDir, bundle, { writeJsonTwins = true, lockStaleMs = 120000 } = {}) {
  const absOut = path.resolve(String(outDir));
  fs.mkdirSync(absOut, { recursive: true });
  const lockPath = path.join(absOut, ".summary.lock");
  const lockPayload = JSON.stringify({ pid: process.pid, startedAt: Date.now() });

  const acquire = () => fs.writeFileSync(lockPath, lockPayload, { flag: "wx" });
  try {
    acquire();
  } catch (err) {
    if (!err || err.code !== "EEXIST") throw err;
    let holder = null;
    try {
      const raw = fs.readFileSync(lockPath, "utf8").trim();
      holder = raw.startsWith("{") ? JSON.parse(raw) : { pid: Number(raw) || 0, startedAt: fs.statSync(lockPath).mtimeMs };
    } catch {}
    const ageMs = holder?.startedAt ? Date.now() - holder.startedAt : 0;
    if (holder?.pid && isPidAlive(holder.pid) && ageMs < lockStaleMs) {
      throw new Error(`Summary output directory is locked by active PID ${holder.pid} (${lockPath})`);
    }
    try { fs.unlinkSync(lockPath); } catch {}
    acquire();
  }

  try {
    const allWrites = {
      ...bundle.files,
      "manifest.json": JSON.stringify(bundle.manifest, null, 2),
      ...(writeJsonTwins ? bundle.jsonlTwins : {}),
    };
    for (const [name, content] of Object.entries(allWrites)) {
      const target = path.join(absOut, name);
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, String(content ?? ""), "utf8");
      fs.renameSync(tmp, target);
    }
    return absOut;
  } finally {
    try {
      if (fs.existsSync(lockPath)) {
        const cur = fs.readFileSync(lockPath, "utf8");
        if (cur.includes(`"pid":${process.pid}`)) fs.unlinkSync(lockPath);
      }
    } catch {}
  }
}

module.exports = {
  PRIORITY_ROLE_ORDER,
  safeAnchor,
  cutAtWord,
  compileSummaryBundle,
  writeSummaryBundleAtomic,
};
