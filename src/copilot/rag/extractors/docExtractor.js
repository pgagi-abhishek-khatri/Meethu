// Document outline, scaffold-free summary, Markdown-aware rule/decision extraction, and stale-reference checking.
const path = require("path");

const TIER1_DOC_RE = /(?:^|\/)(?:CLAUDE|AGENTS|OKF|ARCHITECTURE|DESIGN|SPEC|ADR\/[^/]+|DECISION|README)(?:\.[^/]*)?$/i;
const EXCLUDE_RULES_DOC_RE = /(?:^|\/)(?:CHANGELOG|CHANGES|HISTORY|RELEASES|\.github\/(?:ISSUE_TEMPLATE|PULL_REQUEST_TEMPLATE)|CODE_OF_CONDUCT|CONTRIBUTING)(?:\/|\.[^/]*)?$/i;
const PRIORITY_DOC_RE = /(?:^|\/)(?:README|CLAUDE|AGENTS|ARCHITECTURE|DESIGN|SPEC|ADR|DECISION|API|HANDOFF|OKF)/i;
const RULE_LINE_RE = /(?:^|\s)(?:MUST(?:\s+NOT)?|NEVER|ALWAYS|REQUIRED|INVARIANT|LIMIT|RULE|MAX(?:IMUM)?|MIN(?:IMUM)?|ONLY\s+WHEN|SHALL\s+NOT|FORBIDDEN|ENFORCED?)\b/i;
const ARCH_SECTION_RE = /(?:architecture|design|rule|constraint|security|invariants?|auth|permission|role|deploy|spec|decision|overview)/i;
const SCAFFOLD_LINE_RE = /(?:npm\s+(?:install|run|start|ci)|yarn\s+|pnpm\s+|pip\s+install|cargo\s+build|npx\s+create|getting\s+started|prerequisites|clone\s+this\s+repo|learn\s+more\s+at|\[!\[|!\[[^\]]*\]\(http)/i;

function normalizeSentenceEnd(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  if (/[.!?]$/.test(s)) return s;
  const lastPeriod = s.lastIndexOf(". ");
  if (lastPeriod > s.length * 0.55) return s.slice(0, lastPeriod + 1).trim();
  return `${s}.`;
}

function extractDocFacts(relPath, content) {
  const clean = String(content || "").replace(/\r\n?/g, "\n");
  const lines = clean.split("\n");
  const headings = [];
  const rawRules = [];
  const mentionedPaths = new Set();
  const paragraphs = [];

  let inFence = false;
  let date = null;
  let title = path.basename(relPath);
  let currentHeading = "";
  let i = 0;

  while (i < lines.length) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    const lineNum = i + 1;

    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      i += 1;
      continue;
    }
    if (inFence) {
      i += 1;
      continue;
    }

    if (!date && i < 30) {
      const dm = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(trimmed);
      if (dm) date = dm[1];
    }

    const hm = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (hm) {
      const level = hm[1].length;
      const text = hm[2].replace(/\s+#*$/, "").trim();
      if (level === 1 && headings.length === 0) title = text;
      currentHeading = text;
      headings.push({ level, text, line: lineNum });
      i += 1;
      continue;
    }

    // Parse Markdown list item (bullet or numbered) as one complete logical block (#6)
    const listMatch = /^(?:[-*+]\s+|\d+[.)]\s+)(.+)$/.exec(trimmed);
    if (listMatch) {
      const startLine = lineNum;
      const parts = [listMatch[1].trim()];
      let j = i + 1;
      while (j < lines.length) {
        const nextRaw = lines[j];
        const nextTrim = nextRaw.trim();
        if (!nextTrim || /^(?:#{1,3}\s|[-*+]\s|\d+[.)]\s|```|---|\|)/.test(nextTrim)) break;
        if (/^\s{2,}/.test(nextRaw)) {
          parts.push(nextTrim);
          j += 1;
        } else {
          break;
        }
      }
      const endLine = j;
      const joined = parts.join(" ").replace(/\s+/g, " ").trim();
      if (RULE_LINE_RE.test(joined) && joined.length >= 16 && joined.length <= 280 && !SCAFFOLD_LINE_RE.test(joined)) {
        const isVerbatimComplete = /[.!?]$/.test(joined) && joined.length >= 18;
        const cleanRule = isVerbatimComplete ? joined : normalizeSentenceEnd(joined);
        const archBoost = ARCH_SECTION_RE.test(currentHeading) ? 2 : 0;
        rawRules.push({
          text: cleanRule,
          line: startLine,
          endLine,
          heading: currentHeading,
          priority: archBoost + (TIER1_DOC_RE.test(relPath) ? 2 : 0),
          confidence: isVerbatimComplete ? "stated" : "derived",
        });
      }
      i = j;
      continue;
    }

    if (trimmed && !trimmed.startsWith("---") && !trimmed.startsWith("|")) {
      const cleanPara = trimmed.replace(/^>\s*/, "").trim();
      const isScaffold = SCAFFOLD_LINE_RE.test(cleanPara) || /^(?:created\s+with|generated\s+by|table\s+of\s+contents)/i.test(cleanPara);
      if (!isScaffold && !/^\d+[.)]\s/.test(cleanPara) && paragraphs.length < 4 && cleanPara.length > 24) {
        paragraphs.push(cleanPara);
      }
      if (RULE_LINE_RE.test(cleanPara) && cleanPara.length >= 16 && cleanPara.length <= 280 && !isScaffold) {
        const isVerbatimComplete = /[.!?]$/.test(cleanPara);
        rawRules.push({
          text: isVerbatimComplete ? cleanPara : normalizeSentenceEnd(cleanPara),
          line: lineNum,
          endLine: lineNum,
          heading: currentHeading,
          priority: ARCH_SECTION_RE.test(currentHeading) ? 2 : 0,
          confidence: isVerbatimComplete ? "stated" : "derived",
        });
      }
    }

    const pathMatches = trimmed.match(/`([A-Za-z0-9_./-]+\.[a-z]{1,6})`/g) || [];
    for (const pm of pathMatches) {
      const inner = pm.slice(1, -1);
      if (inner.includes("/") && !inner.startsWith("http")) mentionedPaths.add(inner);
    }
    i += 1;
  }

  // Deduplicate near-identical rules & sort by architectural relevance
  const dedupRules = [];
  const seenRuleNorm = new Set();
  for (const r of rawRules.sort((a, b) => b.priority - a.priority || a.line - b.line)) {
    const norm = r.text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 90);
    if (seenRuleNorm.has(norm)) continue;
    seenRuleNorm.add(norm);
    dedupRules.push(r);
  }

  const summaryLines = paragraphs.slice(0, 2).join(" ");
  const summary = summaryLines.length > 240 ? normalizeSentenceEnd(summaryLines.slice(0, 237)) : summaryLines;
  const excludeFromRules = EXCLUDE_RULES_DOC_RE.test(relPath);
  const isPriority = !excludeFromRules && (TIER1_DOC_RE.test(relPath) || PRIORITY_DOC_RE.test(relPath));
  const docTier = excludeFromRules ? 3 : TIER1_DOC_RE.test(relPath) ? 1 : isPriority ? 2 : 3;

  return {
    relPath,
    title,
    date,
    isPriority,
    docTier,
    excludeFromRules,
    totalLines: lines.length,
    estTokens: Math.max(1, Math.round(clean.length / 4)),
    headings,
    summary: summary || `${title} (${lines.length} lines).`,
    rules: dedupRules,
    mentionedPaths: [...mentionedPaths],
  };
}

function findStaleDocReferences(docFactsList, knownRelPathsSet) {
  const stale = [];
  for (const doc of docFactsList) {
    for (const ref of doc.mentionedPaths || []) {
      const normalized = ref.replace(/^\.\//, "");
      const exists =
        knownRelPathsSet.has(normalized) ||
        [...knownRelPathsSet].some((p) => p.endsWith(`/${normalized}`));
      if (!exists) {
        stale.push({ docPath: doc.relPath, missingRef: ref });
      }
    }
  }
  return stale;
}

module.exports = {
  extractDocFacts,
  findStaleDocReferences,
};
