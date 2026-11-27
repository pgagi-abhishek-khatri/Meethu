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
  targetTokens = 2800,
  hardCapTokens = 5000,
  failOnCap = true,
} = {}) {
  const dateStr = genDate || new Date().toISOString().slice(0, 10);
  const compRefs = components.map((c) => `${compIdMap.get(c.id) || c.id}@${c.revision || "no-git"}`).join(" ");
  const headerLines = [
    `# ${repoName} · gen ${dateStr} · ${compRefs}`,
    `Coverage: ${accountedTotal}/${totalDiscovered} files · ${truncatedAny ? "Detail truncated (Tier 2 full)" : "0 truncated"} · ${secretsRedacted} redactions`,
  ];
  if (dirtyFeatureIds.length > 0) {
    headerLines.push(`Dirty: uncommitted changes in ${dirtyFeatureIds.slice(0, 8).join(", ")}`);
  }

  const sysBlock = systemSummary || `${repoName} multi-component codebase with ${components.length} component(s) and ${features.length} domains.`;

  const compRows = components.map((c) => {
    const cid = compIdMap.get(c.id) || c.id;
    const stack = c.primaryStack || c.vcs || "code";
    const entry = scriptsByComp.get(c.id) || "-";
    const role = c.componentSummary || c.name || c.id;
    return `${cid} ${c.name || c.id} · ${stack} · run: ${entry} · ${cutSentence(role, 72)}`;
  });

  const componentsBlock = ["## Components", ...compRows].join("\n");
  const rulesBlock = [
    "## Escalation Rules",
    "Answer directly from this card: overview, roles, feature status, high-level architecture.",
    "Fetch feature(<id>) or Tier 2 tools for: exact limits, validation errors, step-by-step flow, edge cases, callers, impact.",
    "If nothing matches, say \"not covered\". Never guess file paths, numbers, or symbol names.",
    "Tools: feature(id) · find(term) · symbol(name) · endpoint(path) · file(path, lines) · doc(path, section)",
  ].join("\n");

  const mandatorySections = [headerLines.join("\n"), sysBlock, componentsBlock, rulesBlock];
  const mandatoryTokens = countTokens(mandatorySections.join("\n\n"));
  if (failOnCap && mandatoryTokens > hardCapTokens) {
    throw new RouterCapExceededError(mandatoryTokens, hardCapTokens);
  }

  // Format feature rows and compress progressively (§3.1 ladder: cluster -> rank & cap)
  const formatFeatureLine = (f, maxDesc = 105) => {
    const owners = (f.ownerCompIds || []).map((id) => compIdMap.get(id) || id).join(",") || "C1";
    const desc = cutSentence(f.routerDescription || f.description || "purpose unknown", maxDesc) || `purpose unknown (${f.files?.length || 0} files)`;
    return `${f.fid} ${f.name} · ${desc} · ${f.status || "unknown"} · ${owners}`;
  };

  let chosenFeatures = clusterOverCapFeatures(features, 26);
  let descWidth = 105;
  let featSection = "";
  let omittedFeatures = features.length - chosenFeatures.length;

  const rebuildFeatSection = () => {
    const rows = chosenFeatures.map((f) => formatFeatureLine(f, descWidth));
    const tail = omittedFeatures > 0 ? `+${omittedFeatures} smaller domains via find()` : "";
    featSection = ["## Features (id · what · status · comp)", ...rows, ...(tail ? [tail] : [])].join("\n");
  };
  rebuildFeatSection();

  // If mandatory + features exceed ~72% of targetTokens, shrink feature list cleanly
  while (
    countTokens([headerLines.join("\n"), sysBlock, componentsBlock, featSection, rulesBlock].join("\n\n")) >
      Math.max(hardCapTokens - 550, Math.floor(targetTokens * 0.78)) &&
    (chosenFeatures.length > 10 || descWidth > 55)
  ) {
    if (descWidth > 65) {
      descWidth -= 20;
    } else {
      chosenFeatures = chosenFeatures.slice(0, Math.max(10, chosenFeatures.length - 4));
      omittedFeatures = features.length - chosenFeatures.length;
    }
    rebuildFeatSection();
  }

  // Remaining token budget for Key Facts (~10 max) & Top Vocabulary (30-60 target)
  const keyFactLines = [];
  for (let i = 0; i < keyFacts.length && keyFactLines.length < 10; i++) {
    const kf = keyFacts[i];
    const clean = sanitizeRuleLine(kf.text, 105);
    if (!clean || clean.length < 16) continue;
    const candidateLines = [...keyFactLines, `K${keyFactLines.length + 1} ${clean} → ${kf.fid || "find()"}`];
    const probe = [
      headerLines.join("\n"),
      sysBlock,
      componentsBlock,
      featSection,
      ["## Key Facts", ...candidateLines].join("\n"),
      rulesBlock,
    ].join("\n\n");
    if (countTokens(probe) <= Math.min(hardCapTokens - 400, Math.floor(targetTokens * 0.90))) {
      keyFactLines.push(candidateLines[candidateLines.length - 1]);
    } else {
      break;
    }
  }
  const keyFactsBlock = keyFactLines.length > 0 ? ["## Key Facts", ...keyFactLines].join("\n") : "";

  const vocabKept = [];
  let vocabDropped = 0;
  for (const v of vocabulary) {
    if (vocabKept.length >= 50) {
      vocabDropped += 1;
      continue;
    }
    const chip = `${v.term} → ${v.fid}`;
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
    if (countTokens(probe) <= Math.min(hardCapTokens - 80, targetTokens)) {
      vocabKept.push(chip);
    } else {
      vocabDropped += vocabulary.length - vocabKept.length;
      break;
    }
  }
  if (vocabDropped > 0 && vocabKept.length > 0) {
    // Re-check keeping room for "+N more via find()" note
    const suffix = ` (+${vocabDropped} more via find())`;
    const baseVocabBlock = `## Vocabulary\n${vocabKept.join(" · ")}${suffix}`;
    const probe = [headerLines.join("\n"), sysBlock, componentsBlock, featSection, keyFactsBlock, baseVocabBlock, rulesBlock]
      .filter(Boolean)
      .join("\n\n");
    if (countTokens(probe) > hardCapTokens && vocabKept.length > 5) {
      vocabKept.pop();
      vocabDropped += 1;
    }
  }
  const vocabBlock = vocabKept.length
    ? `## Vocabulary\n${vocabKept.join(" · ")}${vocabDropped > 0 ? ` · +${vocabDropped} via find()` : ""}`
    : "";

  const finalSections = [
    headerLines.join("\n"),
    sysBlock,
    componentsBlock,
    featSection,
    keyFactsBlock,
    vocabBlock,
    rulesBlock,
  ].filter(Boolean);

  const markdown = finalSections.join("\n\n");
  const tokens = countTokens(markdown);
  if (failOnCap && tokens > hardCapTokens) {
    throw new RouterCapExceededError(tokens, hardCapTokens);
  }

  const stepsApplied = [];
  if (features.length > chosenFeatures.length) stepsApplied.push(`rank_cap(${chosenFeatures.length}/${features.length})`);
  if (descWidth < 105) stepsApplied.push(`trim_desc(${descWidth}c)`);

  return {
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
