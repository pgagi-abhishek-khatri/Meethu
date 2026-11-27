// Document outline, summary, rule/decision extraction, and stale-reference checking for Markdown/text docs.
const path = require("path");

const TIER1_DOC_RE = /(?:^|\/)(?:CLAUDE|AGENTS|OKF|ARCHITECTURE|DESIGN|SPEC|ADR\/[^/]+|DECISION|README)(?:\.[^/]*)?$/i;
const EXCLUDE_RULES_DOC_RE = /(?:^|\/)(?:CHANGELOG|CHANGES|HISTORY|RELEASES|\.github\/(?:ISSUE_TEMPLATE|PULL_REQUEST_TEMPLATE)|CODE_OF_CONDUCT|CONTRIBUTING)(?:\/|\.[^/]*)?$/i;
const PRIORITY_DOC_RE = /(?:^|\/)(?:README|CLAUDE|AGENTS|ARCHITECTURE|DESIGN|SPEC|ADR|DECISION|API|HANDOFF|OKF)/i;
const RULE_LINE_RE = /(?:^|\s)(?:MUST(?:\s+NOT)?|NEVER|ALWAYS|REQUIRED|INVARIANT|LIMIT|RULE|MAX(?:IMUM)?|MIN(?:IMUM)?|ONLY\s+WHEN|SHALL\s+NOT)\b/i;

function extractDocFacts(relPath, content) {
  const clean = String(content || "").replace(/\r\n?/g, "\n");
  const lines = clean.split("\n");
  const headings = [];
  const rules = [];
  const mentionedPaths = new Set();
  const paragraphs = [];

  let inFence = false;
  let date = null;
  let title = path.basename(relPath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const lineNum = i + 1;

    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // Frontmatter or inline date
    if (!date && i < 30) {
      const dm = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(trimmed);
      if (dm) date = dm[1];
    }

    const hm = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (hm) {
      const level = hm[1].length;
      const text = hm[2].replace(/\s+#*$/, "").trim();
      if (level === 1 && headings.length === 0) title = text;
      headings.push({ level, text, line: lineNum });
      continue;
    }

    if (trimmed && !trimmed.startsWith("---") && !trimmed.startsWith("|")) {
      if (paragraphs.length < 4 && trimmed.length > 20) {
        paragraphs.push(trimmed.replace(/^[-*>\s]+/, ""));
      }
      if (RULE_LINE_RE.test(trimmed) && trimmed.length >= 16 && trimmed.length <= 240) {
        rules.push({
          text: trimmed.replace(/^[-*]\s+/, ""),
          line: lineNum,
          confidence: "stated",
        });
      }
    }

    // Detect backtick-quoted file paths for stale-doc checks
    const pathMatches = trimmed.match(/`([A-Za-z0-9_./-]+\.[a-z]{1,6})`/g) || [];
    for (const pm of pathMatches) {
      const inner = pm.slice(1, -1);
      if (inner.includes("/") && !inner.startsWith("http")) mentionedPaths.add(inner);
    }
  }

  const summaryLines = paragraphs.slice(0, 2).join(" ");
  const summary = summaryLines.length > 240 ? `${summaryLines.slice(0, 237).replace(/\s+\S*$/, "")}…` : summaryLines;
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
    rules,
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
