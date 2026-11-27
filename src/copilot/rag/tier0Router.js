// Builds Tier 0 Router Card (00_router.md) for the decision model:
// Ideal 2,000-3,000 tokens, hard cap 5,000 tokens measured by real BPE tokenizer.
// Applies §3.1 compression ladder & §3.5 priority budget allocator. Fails build if hard cap exceeded.
const { countTokens, getTokenizerInfo } = require("./tokenizer");

class RouterCapExceededError extends Error {
  constructor(tokens, hardCap) {
    super(`Tier 0 router card exceeded hard token cap: ${tokens} > ${hardCap} (${getTokenizerInfo().engine})`);
    this.name = "RouterCapExceededError";
    this.tokens = tokens;
    this.hardCap = hardCap;
  }
}

function stripPathsAndFiller(text) {
  return String(text || "")
    .replace(/\b(?:src|apps|packages|openwhispr-mobile|test|scripts)\/[A-Za-z0-9_./-]+\b/g, "")
    .replace(/\b(?:[A-Za-z0-9_-]+\/){2,}[A-Za-z0-9_.-]+\b/g, "")
    .replace(/\b(?:Handles|Provides|Manages|Serves|Renders|Implemented in)\s+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cutSentence(text, maxChars) {
  const s = stripPathsAndFiller(text);
  if (s.length <= maxChars) return s;
  const sub = s.slice(0, maxChars);
  const dot = Math.max(sub.lastIndexOf(". "), sub.lastIndexOf("; "), sub.lastIndexOf(", "));
  if (dot > maxChars * 0.45) return sub.slice(0, dot).replace(/[.,;:\s]+$/, "").trim();
  const sp = sub.lastIndexOf(" ");
  return (sp > maxChars * 0.45 ? sub.slice(0, sp) : sub).trim();
}

function scoreFeatureImportance(f) {
  const filesCount = f.files?.length || 0;
  const routesCount = f.contracts?.length || 0;
  const docsCount = f.docs?.length || 0;
  const docBonus = docsCount * 15;
  const routeBonus = routesCount * 12;
  const commitBonus = Math.min(20, (f.files || []).reduce((s, x) => s + (x.commitCount || 0), 0));
  const infraPenalty = /^(?:core|shared|utils|helpers|ui|icons|styles|types|common|config)$/i.test(f.slug || f.id || "") ? -25 : 0;
  return docBonus + routeBonus + Math.min(40, filesCount) + commitBonus + infraPenalty;
}

function clusterOverCapFeatures(features, targetCount = 24) {
  if (features.length <= targetCount) return features;
  const ranked = [...features].sort((a, b) => scoreFeatureImportance(b) - scoreFeatureImportance(a) || a.fid.localeCompare(b.fid));
  return ranked.slice(0, targetCount);
}

function sanitizeRuleLine(ruleText, maxChars = 120) {
  let s = String(ruleText || "")
    .replace(/^[\d]+[.)]\s+/, "")
    .replace(/^[-*•]\s+/, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\b(?:src|apps|packages|openwhispr-mobile|test|scripts)\/[A-Za-z0-9_./-]+\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > maxChars) {
    const dot = s.slice(0, maxChars).lastIndexOf(". ");
    s = dot > 40 ? s.slice(0, dot + 1) : `${s.slice(0, maxChars - 1).replace(/\s+\S*$/, "")}…`;
  }
  return s;
}

/**
 * Folds verbose multi-word IPC/contract phrases sharing a namespace root (>= 3 entries)
 * into compact wildcard chips (`analytics.* → F31,F43`) while preserving high-signal
 * domain names, acronyms, and model terms intact.
 */
function foldVocabulary(vocabulary = [], maxChips = 28) {
  const highSignal = [];
  const foldBuckets = new Map(); // prefix -> { fids: Set, terms: [] }

  for (const v of vocabulary) {
    const term = String(v.term || "").trim();
    const fid = String(v.fid || "").trim();
    if (!term || !fid) continue;
    const isRouteOrIpc = v.targetType === "contract";
    if (!isRouteOrIpc) {
      highSignal.push({ term, fid, priority: v.targetType === "term" || v.targetType === "feature" ? 2 : 1 });
      continue;
    }
    const firstTok = term.split(/\s+/)[0].toLowerCase();
    if (!firstTok || firstTok.length < 3) continue;
    if (!foldBuckets.has(firstTok)) foldBuckets.set(firstTok, { fids: new Set(), terms: [] });
    const b = foldBuckets.get(firstTok);
    b.fids.add(fid);
    b.terms.push({ term, fid });
  }

  const chips = [];
  const seen = new Set();
  for (const h of highSignal) {
    const key = `${h.term.toLowerCase()}::${h.fid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    chips.push(`${h.term}→${h.fid}`);
    if (chips.length >= maxChips) return { kept: chips, foldedCount: 0, total: vocabulary.length };
  }

  for (const [pfx, bucket] of [...foldBuckets.entries()].sort((a, b) => b[1].terms.length - a[1].terms.length || a[0].localeCompare(b[0]))) {
    if (chips.length >= maxChips) break;
    if (bucket.terms.length >= 2) {
      const fidList = [...bucket.fids].sort().slice(0, 3).join(",");
      chips.push(`${pfx}.*→${fidList}`);
    } else {
      const only = bucket.terms[0];
      chips.push(`${only.term}→${only.fid}`);
    }
  }

  return { kept: chips, total: vocabulary.length };
}

function formatCompactFeatureRow(f, compIdMap, maxDesc = 82) {
  const owners = (f.ownerCompIds || []).map((id) => compIdMap.get(id) || id).join(",") || "C1";
  let raw = f.routerDescription || f.description || "";
  raw = raw
    .replace(/^purpose unknown\s*\((\d+)[^)]*\)\.?/i, "$1f unknown")
    .replace(new RegExp(`^${f.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*`, "i"), "")
    .replace(/\b(\d+)\s+files\s+\(([^)]*)\)/i, "$1f ($2)")
    .replace(/;\s*endpoints\s+/i, "; ")
    .replace(/\(\);?/g, "");
  const desc = cutSentence(raw, maxDesc) || `${f.files?.length || 0}f`;
  return `${f.fid}|${f.name}|${f.status || "unknown"}|${owners}|${desc}`;
}

function buildTier0RouterCard({
  repoName,
  genDate,
  components = [],
  features = [],
  compIdMap = new Map(),
  systemSummary = "",
  totalDiscovered = 0,
  accountedTotal = 0,
  truncatedAny = false,
  secretsRedacted = 0,
  keyFacts = [],
  vocabulary = [],
  dirtyFeatureIds = [],
  scriptsByComp = new Map(),
  targetTokens = 1200,
  hardCapTokens = 5000,
  failOnCap = true,
} = {}) {
  const dateStr = genDate || new Date().toISOString().slice(0, 10);
  const compRefs = components.map((c) => `${compIdMap.get(c.id) || c.id}@${c.revision || "no-git"}`).join(" ");
  // Keep staticPrefix free of volatile dirty/runtime lines so LLM KV prefix caching hits across turns (V3 Prompt Caching).
  const headerLines = [
    `# ${repoName} · ${dateStr} · ${compRefs}`,
    `Coverage: ${accountedTotal}/${totalDiscovered} · ${truncatedAny ? "Tier2 full" : "complete"} · ${secretsRedacted} redacted`,
  ];

  const sysBlock = systemSummary || `${repoName}: ${components.length} comp(s), ${features.length} domains.`;

  const compRows = components.map((c) => {
    const cid = compIdMap.get(c.id) || c.id;
    const stack = c.primaryStack || c.vcs || "code";
    const entry = scriptsByComp.get(c.id) || "-";
    return `${cid}|${c.name || c.id}|${stack}|${entry}`;
  });

  const componentsBlock = ["## Components", ...compRows].join("\n");
  const rulesBlock = [
    "## Escalation Rules",
    "Answer from card: overview, roles, status, architecture.",
    "Escalate via tools for limits, flow, callers, impact: feature(id) · find(term) · symbol(name) · endpoint(path) · file(path,lines) · doc(path,sec)",
    "Never guess missing paths/numbers.",
  ].join("\n");

  const volatileSuffix = dirtyFeatureIds.length > 0
    ? `## Dirty State\nUncommitted edits in: ${dirtyFeatureIds.slice(0, 8).join(", ")}`
    : "";
  const volatileTokens = volatileSuffix ? countTokens(volatileSuffix) : 0;

  const mandatorySections = [headerLines.join("\n"), sysBlock, componentsBlock, rulesBlock];
  const mandatoryTokens = countTokens(mandatorySections.join("\n\n")) + volatileTokens;
  if (failOnCap && mandatoryTokens > hardCapTokens) {
    throw new RouterCapExceededError(mandatoryTokens, hardCapTokens);
  }

  // Format TOON-compact feature rows (id|name|status|comp|what) and tighten inside targetTokens
  let chosenFeatures = clusterOverCapFeatures(features, 22);
  let descWidth = 82;
  let featSection = "";
  let omittedFeatures = features.length - chosenFeatures.length;

  const rebuildFeatSection = () => {
    const rows = chosenFeatures.map((f) => formatCompactFeatureRow(f, compIdMap, descWidth));
    const tail = omittedFeatures > 0 ? `+${omittedFeatures} domains via find()` : "";
    featSection = ["## Features (id|name|status|comp|what)", ...rows, ...(tail ? [tail] : [])].join("\n");
  };
  rebuildFeatSection();

  const featureCeiling = Math.max(hardCapTokens - 350, Math.floor((targetTokens - volatileTokens) * 0.72));
  while (
    countTokens([headerLines.join("\n"), sysBlock, componentsBlock, featSection, rulesBlock].join("\n\n")) > featureCeiling &&
    (chosenFeatures.length > 10 || descWidth > 48)
  ) {
    if (descWidth > 52) {
      descWidth -= 14;
    } else {
      chosenFeatures = chosenFeatures.slice(0, Math.max(10, chosenFeatures.length - 3));
      omittedFeatures = features.length - chosenFeatures.length;
    }
    rebuildFeatSection();
  }

  // Remaining budget for Key Facts (~8 max) & Prefix-Folded Vocabulary
  const keyFactLines = [];
  for (let i = 0; i < keyFacts.length && keyFactLines.length < 8; i++) {
    const kf = keyFacts[i];
    const clean = sanitizeRuleLine(kf.text, 92);
    if (!clean || clean.length < 16) continue;
    const candidateLines = [...keyFactLines, `K${keyFactLines.length + 1} ${clean}→${kf.fid || "find()"}`];
    const probe = [
      headerLines.join("\n"),
      sysBlock,
      componentsBlock,
      featSection,
      ["## Key Facts", ...candidateLines].join("\n"),
      rulesBlock,
    ].join("\n\n");
    if (countTokens(probe) + volatileTokens <= Math.min(hardCapTokens - 220, Math.floor(targetTokens * 0.88))) {
      keyFactLines.push(candidateLines[candidateLines.length - 1]);
    } else {
      break;
    }
  }
  const keyFactsBlock = keyFactLines.length > 0 ? ["## Key Facts", ...keyFactLines].join("\n") : "";

  const folded = foldVocabulary(vocabulary, 28);
  const vocabKept = [];
  let vocabDropped = Math.max(0, vocabulary.length - folded.kept.length);
  for (const chip of folded.kept) {
    const candidateVocab = [...vocabKept, chip].join(" · ");
    const probe = [
      headerLines.join("\n"),
      sysBlock,
      componentsBlock,
      featSection,
      keyFactsBlock,
      `## Vocabulary\n${candidateVocab}`,
      rulesBlock,
    ]
      .filter(Boolean)
      .join("\n\n");
    if (countTokens(probe) + volatileTokens <= Math.min(hardCapTokens - 60, targetTokens)) {
      vocabKept.push(chip);
    } else {
      vocabDropped += folded.kept.length - vocabKept.length;
      break;
    }
  }
  const vocabBlock = vocabKept.length
    ? `## Vocabulary\n${vocabKept.join(" · ")}${vocabDropped > 0 ? ` · +${vocabDropped} via find()` : ""}`
    : "";

  const staticSections = [
    headerLines.join("\n"),
    sysBlock,
    componentsBlock,
    featSection,
    keyFactsBlock,
    vocabBlock,
    rulesBlock,
  ].filter(Boolean);

  const staticPrefix = staticSections.join("\n\n");
  const markdown = volatileSuffix ? `${staticPrefix}\n\n${volatileSuffix}` : staticPrefix;
  const tokens = countTokens(markdown);
  if (failOnCap && tokens > hardCapTokens) {
    throw new RouterCapExceededError(tokens, hardCapTokens);
  }

  const stepsApplied = [];
  if (features.length > chosenFeatures.length) stepsApplied.push(`rank_cap(${chosenFeatures.length}/${features.length})`);
  if (descWidth < 82) stepsApplied.push(`trim_desc(${descWidth}c)`);
  if (vocabulary.length > folded.kept.length) stepsApplied.push(`prefix_fold(${folded.kept.length}/${vocabulary.length})`);

  return {
    staticPrefix,
    volatileSuffix,
    markdown,
    tokens,
    tokenizer: getTokenizerInfo(),
    metrics: {
      featuresShown: chosenFeatures.length,
      featuresTotal: features.length,
      featuresOmitted: omittedFeatures,
      keyFactsShown: keyFactLines.length,
      vocabShown: vocabKept.length,
      vocabTotal: vocabulary.length,
      hardCapTokens,
      targetTokens,
      capExceeded: tokens > hardCapTokens,
      stepsApplied,
    },
  };
}

module.exports = {
  RouterCapExceededError,
  buildTier0RouterCard,
  scoreFeatureImportance,
  sanitizeRuleLine,
};
