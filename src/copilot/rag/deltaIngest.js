// src/copilot/rag/deltaIngest.js
// Incremental Semantic Delta Ingestion Engine for Meethu Copilot.
// Compares uploaded requirement documents against previously ingested features,
// identifies semantic deltas, preserves baseline requirements, avoids unnecessary
// re-embeddings through content hashing and vector cache, and manages bi-temporal
// version transitions atomically.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { docStanding } = require("./docPrecedence");
const { normalizeTitle } = require("../core/okf/featureRegistry");

// ---------------------------------------------------------------------------
// A. Content Normalization and Cryptographic Hashing
// ---------------------------------------------------------------------------

/**
 * Deterministic Unicode NFKC and whitespace normalization.
 * CRITICAL: Preserves numbers, decimals, commas in numbers, negations,
 * constraints, units, and technical identifiers.
 */
function normalizeContent(text) {
  if (typeof text !== "string") return "";

  return text
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n") // normalize line endings
    .replace(/[\u2018\u2019]/g, "'") // smart single quotes
    .replace(/[\u201C\u201D]/g, '"') // smart double quotes
    .replace(/[\u2013\u2014]/g, "-") // en-dash and em-dash to hyphen
    .replace(/[ \t]+$/gm, "") // strip trailing spaces on lines
    .replace(/[ \t]+/g, " ") // collapse multiple inline spaces/tabs to 1
    .replace(/\n{3,}/g, "\n\n") // collapse 3+ blank lines to 2
    .trim();
}

/**
 * Computes deterministic SHA-256 hexadecimal hash.
 */
function sha256(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Computes separate hashes for section content, body, and overall document.
 */
function computeContentHash(text, bodyOnly = "") {
  const normalizedFull = normalizeContent(text);
  const normalizedBody = normalizeContent(bodyOnly || text);

  return {
    content_hash: sha256(normalizedFull),
    body_hash: sha256(normalizedBody),
    normalized_text: normalizedFull,
  };
}

/**
 * Deterministic zero-LLM Anthropic-style contextual title for embeddings.
 * Format: "File.md [phase 2, what was built | 2026-10-14] · Parent > Section"
 */
function buildContextualTitle({
  sourceName,
  standing = null,
  effectiveAt = null,
  hierarchy = [],
  sectionTitle = "",
}) {
  const resolvedStanding = standing || docStanding({ name: sourceName });
  const standingParts = [];
  if (resolvedStanding?.phase) standingParts.push(`phase ${resolvedStanding.phase}`);
  if (resolvedStanding?.label) standingParts.push(resolvedStanding.label);
  const dateTag =
    resolvedStanding?.dateText ||
    (Number.isFinite(Number(effectiveAt)) && Number(effectiveAt) > 1e11
      ? new Date(Number(effectiveAt)).toISOString().slice(0, 10)
      : null);
  if (dateTag) standingParts.push(dateTag);

  const trail = (Array.isArray(hierarchy) ? hierarchy : [])
    .filter((h) => h && normalizeTitle(h) !== normalizeTitle(sourceName.replace(/\.[^.]+$/, "")))
    .slice(-3)
    .join(" > ");
  const headingPart = trail || sectionTitle || sourceName;
  const metaTag = standingParts.length ? ` [${standingParts.join(", ")}]` : "";
  return `${sourceName}${metaTag} · ${headingPart}`;
}

// ---------------------------------------------------------------------------
// B. Section Extraction & Document Hierarchy Parsing
// ---------------------------------------------------------------------------

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const NUMBERED_HEADING_RE = /^([0-9]+(?:\.[0-9]+)*)[ \t]+(.+?)\s*$/;
const PAGE_RE = /^\s*\[\[page\s+(\d+)\]\]\s*$/i;

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

/**
 * Extracts structured sections with hierarchy, parent links, and location metadata.
 * Collapses consecutive duplicate headings (common in DOCX-to-Markdown output) so
 * empty stub headings are omitted and sub-sections inherit their true parent heading.
 */
function extractSections(rawText, { sourceDocumentId = "doc", sourceFilename = "document" } = {}) {
  const text = String(rawText || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\0/g, "");

  // Pre-pass: collapse consecutive duplicate markdown headings with only blank lines between them
  // (e.g. DOCX-to-MD emits "## When it is available" followed by "#### When it is available").
  // Keeping the second (deeper/true) heading prevents the outer "##" from prematurely popping the parent section.
  const rawLines = text.split("\n");
  const lines = [];
  for (let i = 0; i < rawLines.length; i++) {
    const m1 = HEADING_RE.exec(rawLines[i]);
    if (m1) {
      let j = i + 1;
      while (j < rawLines.length && rawLines[j].trim() === "") j++;
      const m2 = j < rawLines.length ? HEADING_RE.exec(rawLines[j]) : null;
      if (m2 && normalizeTitle(m1[2]) === normalizeTitle(m2[2])) {
        // Drop the redundant wrapper heading and jump straight to the true heading line
        i = j - 1;
        continue;
      }
    }
    lines.push(rawLines[i]);
  }

  const sections = [];
  const headingStack = []; // [{ level, title, section_id }]

  let currentHeading = null;
  let currentLines = [];
  let currentPage = null;
  let sectionIndex = 0;

  function flushCurrentSection() {
    if (!currentHeading && currentLines.length === 0) return;

    const bodyText = currentLines.join("\n").trim();
    if (!currentHeading && !bodyText) return;

    const headingTitle = currentHeading ? currentHeading.title : sourceFilename;
    const fullText = currentHeading
      ? `${"#".repeat(currentHeading.level || 1)} ${headingTitle}\n\n${bodyText}`
      : bodyText;

    const { content_hash, body_hash, normalized_text } = computeContentHash(fullText, bodyText);

    // Parent is the immediate ancestor above currentHeading in headingStack
    const parent =
      currentHeading && headingStack.length > 1
        ? headingStack[headingStack.length - 2]
        : !currentHeading && headingStack.length > 0
          ? headingStack[headingStack.length - 1]
          : null;
    const hierarchy = headingStack.map((h) => h.title);

    const sectionId = currentHeading
      ? `sec_${sectionIndex}_${slugify(headingTitle)}`
      : `sec_${sectionIndex}_body`;

    sections.push({
      section_id: sectionId,
      section_title: headingTitle,
      parent_section_id: parent ? parent.section_id : null,
      hierarchy,
      original_text: fullText,
      body_text: bodyText,
      normalized_text,
      content_hash,
      body_hash,
      source_document_id: sourceDocumentId,
      source_filename: sourceFilename,
      page: currentPage,
      extraction_order: sectionIndex++,
    });

    currentLines = [];
  }

  function enterHeading(level, title) {
    // Collapse consecutive duplicate headings with no body between them (DOCX-to-MD artifact)
    if (
      currentHeading &&
      currentLines.join("\n").trim() === "" &&
      normalizeTitle(title) === normalizeTitle(currentHeading.title)
    ) {
      headingStack.pop();
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop();
      }
      currentHeading = {
        level,
        title,
        section_id: currentHeading.section_id,
      };
      headingStack.push(currentHeading);
      return;
    }

    flushCurrentSection();

    while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
      headingStack.pop();
    }

    currentHeading = {
      level,
      title,
      section_id: `sec_${sectionIndex}_${slugify(title)}`,
    };
    headingStack.push(currentHeading);
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Page marker check
    const pageMatch = PAGE_RE.exec(line);
    if (pageMatch) {
      currentPage = Number(pageMatch[1]);
      continue;
    }

    // Markdown heading check (# Heading)
    const hMatch = HEADING_RE.exec(line);
    if (hMatch) {
      enterHeading(hMatch[1].length, hMatch[2].trim());
      continue;
    }

    // Numbered heading check (e.g. 1.1 Ingestion Architecture)
    const numMatch = NUMBERED_HEADING_RE.exec(line);
    if (
      numMatch &&
      (line.startsWith("1.") ||
        line.startsWith("2.") ||
        line.startsWith("3.") ||
        line.startsWith("4.") ||
        line.startsWith("5.") ||
        line.startsWith("6."))
    ) {
      const numParts = numMatch[1].split(".");
      const level = Math.min(6, numParts.length);
      enterHeading(level, `${numMatch[1]} ${numMatch[2].trim()}`);
      continue;
    }

    currentLines.push(line);
  }

  flushCurrentSection();

  // If document was completely flat without headings, return single root section
  if (sections.length === 0 && text.trim()) {
    const { content_hash, body_hash, normalized_text } = computeContentHash(text, text);
    sections.push({
      section_id: "sec_0_root",
      section_title: sourceFilename,
      parent_section_id: null,
      hierarchy: [sourceFilename],
      original_text: text,
      body_text: text,
      normalized_text,
      content_hash,
      body_hash,
      source_document_id: sourceDocumentId,
      source_filename: sourceFilename,
      page: currentPage,
      extraction_order: 0,
    });
  }

  return sections;
}

// ---------------------------------------------------------------------------
// C. Canonical Feature Matching
// ---------------------------------------------------------------------------

function cleanHeadingTitle(title) {
  return String(title || "")
    .replace(/\[(?:DEPRECATED|RETIRED|OBSOLETE|DRAFT|PROPOSED|ACTIVE)\]/gi, "")
    .replace(/\[v?[0-9]+(?:\.[0-9]+)*\]/gi, "")
    .trim();
}

/**
 * Matches an extracted section to a registered canonical feature.
 * Precedence: Exact feature_id -> Canonical name -> Alias -> Keyword -> Title-First Score -> Parent Heading -> Body Weighted Score -> Unmatched.
 */
function matchFeature(section, featureRegistry, projectId = null) {
  if (!featureRegistry || typeof featureRegistry.resolveFeature !== "function") {
    return {
      feature_id: null,
      feature_name: null,
      matched_by: null,
      confidence: 0,
      status: "unmatched",
      candidates: [],
    };
  }

  const cleanTitle = cleanHeadingTitle(section.section_title);

  // First try title-only match (high precision); if title itself doesn't resolve, check ancestor headings before body text
  const titleOnlyRes = cleanTitle
    ? featureRegistry.resolveFeature(cleanTitle, projectId)
    : { matched: false, ambiguous: false };

  if (titleOnlyRes.matched && titleOnlyRes.feature) {
    let confidence = 0.85;
    if (titleOnlyRes.matchTier === "exact_feature_id") confidence = 1.0;
    else if (titleOnlyRes.matchTier === "canonical_name") confidence = 0.95;
    else if (titleOnlyRes.matchTier === "alias") confidence = 0.92;
    else if (titleOnlyRes.matchTier === "keyword") confidence = 0.88;
    else if (titleOnlyRes.matchTier === "title_scored") confidence = 0.86;

    return {
      feature_id: titleOnlyRes.feature.feature_id,
      feature_name: titleOnlyRes.feature.canonical_name,
      matched_by: titleOnlyRes.matchTier,
      confidence,
      status: "matched",
      candidates: [titleOnlyRes.feature.feature_id],
      feature: titleOnlyRes.feature,
      currentApproved: titleOnlyRes.currentApproved,
    };
  }

  if (titleOnlyRes.ambiguous) {
    return {
      feature_id: null,
      feature_name: null,
      matched_by: null,
      confidence: 0,
      status: "ambiguous",
      candidates: titleOnlyRes.candidates || [],
      reason: titleOnlyRes.reason,
    };
  }

  // Try parent headings in hierarchy (handles generic sub-sections like "When it is available" under "5. Cancel My Bid")
  if (Array.isArray(section.hierarchy) && section.hierarchy.length > 1) {
    for (let i = section.hierarchy.length - 2; i >= 0; i--) {
      const ancestor = cleanHeadingTitle(section.hierarchy[i]);
      if (!ancestor) continue;
      const ancRes = featureRegistry.resolveFeature(ancestor, projectId);
      if (ancRes.matched && ancRes.feature) {
        return {
          feature_id: ancRes.feature.feature_id,
          feature_name: ancRes.feature.canonical_name,
          matched_by: "parent_heading",
          confidence: 0.84,
          status: "matched",
          candidates: [ancRes.feature.feature_id],
          feature: ancRes.feature,
          currentApproved: ancRes.currentApproved,
        };
      }
    }
  }

  // Fallback to full title + body weighted resolution
  const res = featureRegistry.resolveFeature(
    cleanTitle || section.section_title,
    section.original_text,
    projectId
  );

  if (res.matched && res.feature) {
    let confidence = 0.8;
    if (res.matchTier === "exact_feature_id") confidence = 1.0;
    else if (res.matchTier === "canonical_name") confidence = 0.95;
    else if (res.matchTier === "alias") confidence = 0.9;
    else if (res.matchTier === "keyword") confidence = 0.85;

    return {
      feature_id: res.feature.feature_id,
      feature_name: res.feature.canonical_name,
      matched_by: res.matchTier,
      confidence,
      status: "matched",
      candidates: [res.feature.feature_id],
      feature: res.feature,
      currentApproved: res.currentApproved,
    };
  }

  if (res.ambiguous) {
    return {
      feature_id: null,
      feature_name: null,
      matched_by: null,
      confidence: 0,
      status: "ambiguous",
      candidates: res.candidates || [],
      reason: res.reason,
    };
  }

  return {
    feature_id: null,
    feature_name: null,
    matched_by: null,
    confidence: 0,
    status: "unmatched",
    candidates: [],
  };
}

// ---------------------------------------------------------------------------
// D. Semantic Delta Classification
// ---------------------------------------------------------------------------

const DEPRECATION_PATTERNS = [
  /\[(?:DEPRECATED|RETIRED|OBSOLETE)\]/i,
  /\bStatus:\s*(?:Deprecated|Retired|Obsolete)\b/i,
  /\bThis\s+(?:requirement|feature)\s+is\s+(?:deprecated|retired|obsolete)\b/i,
  /\b(?:superseded\s+and\s+deprecated)\b/i,
];

function isExplicitlyDeprecated(text) {
  return DEPRECATION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Classifies a section against existing project records into:
 * NEW | UNCHANGED | MODIFIED | DEPRECATED | AMBIGUOUS | UNMATCHED
 */
function classifySectionDelta({ section, match, activeChunks = [], fileId = null }) {
  if (match.status === "ambiguous") {
    return {
      classification: "AMBIGUOUS",
      reason: match.reason || "Multiple canonical features match this section",
      action: "none",
    };
  }

  if (match.status === "unmatched") {
    return {
      classification: "UNMATCHED",
      reason: "No matching canonical feature found in registry",
      action: "none",
    };
  }

  // Explicit deprecation check
  if (isExplicitlyDeprecated(section.original_text)) {
    return {
      classification: "DEPRECATED",
      reason: "Section contains explicit deprecation notice",
      action: "deprecate",
    };
  }

  // If no prior active chunks exist for this feature in the project
  if (!activeChunks || activeChunks.length === 0) {
    return {
      classification: "NEW",
      reason: "Feature is newly introduced to this project",
      action: "insert",
    };
  }

  // Check if hash matches any active chunk for this feature
  const exactMatch = activeChunks.find(
    (c) => c.hash === section.content_hash || c.hash === section.body_hash
  );

  if (exactMatch) {
    return {
      classification: "UNCHANGED",
      matched_chunk_id: exactMatch.id,
      existing_version: exactMatch.version,
      reason: "Normalized content hash is identical to current active requirement",
      action: "reuse",
    };
  }

  // Filter out active chunks from the same document (fileId) so sibling sections in the same document do not supersede each other
  const priorChunks =
    fileId != null ? activeChunks.filter((c) => c.file_id !== fileId) : activeChunks;

  // If no prior active chunks exist from other files
  if (priorChunks.length === 0) {
    return {
      classification: "NEW",
      reason: "Feature is newly introduced or additional section within current document",
      action: "insert",
    };
  }

  // Hash differs from prior active chunks -> MODIFIED
  const primaryPred = priorChunks[0];
  return {
    classification: "MODIFIED",
    predecessor_chunk_id: primaryPred.id,
    previous_version: primaryPred.version,
    reason: "Feature content differs from current active requirement",
    action: "supersede",
  };
}

// ---------------------------------------------------------------------------
// E. Version Resolution Helper
// ---------------------------------------------------------------------------

function extractVersionFromText(text) {
  const match = text.match(/\b(?:version|v)[\s:]*([0-9]+\.[0-9]+\.[0-9]+)\b/i);
  return match ? match[1] : null;
}

function bumpSemver(version, bumpType = "patch") {
  if (!version || typeof version !== "string") return "1.0.0";
  const parts = version.split(".").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return `${version}.1`;

  if (bumpType === "major") return `${parts[0] + 1}.0.0`;
  if (bumpType === "minor") return `${parts[0]}.${parts[1] + 1}.0`;
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

// ---------------------------------------------------------------------------
// F. Per-Project Serialization and Snapshot Verification
// ---------------------------------------------------------------------------

// Pass 1 classifies against the active chunks it read, pass 3 awaits the embedder for
// seconds, and pass 4 writes against what pass 1 read. Two ingests of one project
// interleaving across that await would supersede or deprecate against stale state.
// Electron main is a single process, so an in-memory promise chain per project is enough.
const ingestQueuesByDb = new WeakMap(); // db -> Map<projectId, Promise tail>
const NO_DB_QUEUE_KEY = {}; // callers without a db still serialize among themselves

// Writers outside the queue (legacy ingest, another engine on the same db) can still
// change a feature mid-embedding; one re-plan covers a single such write, and a second
// change means the feature is churning, so we stop rather than loop.
const MAX_SNAPSHOT_RETRIES = 1;

class StaleSnapshotError extends Error {
  constructor(featureIds) {
    super(`Active chunks for feature(s) ${featureIds.join(", ")} changed during ingestion`);
    this.name = "StaleSnapshotError";
    this.featureIds = featureIds;
  }
}

function enqueueForProject(queueKey, projectId, task) {
  let byProject = ingestQueuesByDb.get(queueKey);
  if (!byProject) {
    byProject = new Map();
    ingestQueuesByDb.set(queueKey, byProject);
  }

  const previous = byProject.get(projectId) || Promise.resolve();
  const run = previous.then(task);
  // The tail only orders the next call; the caller still receives `run`'s rejection,
  // so settling the tail on failure hides nothing and keeps one failure from blocking the queue.
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  byProject.set(projectId, tail);
  tail.then(() => {
    if (byProject.get(projectId) === tail) byProject.delete(projectId);
  });
  return run;
}

function sameChunkIds(a, b) {
  if (a.length !== b.length) return false;
  const ids = new Set(a.map((c) => c.id));
  return b.every((c) => ids.has(c.id));
}

// ---------------------------------------------------------------------------
// G. Delta Ingestion Engine Factory
// ---------------------------------------------------------------------------

function createDeltaIngest({
  db,
  ragStore,
  temporalStore,
  featureRegistry,
  embedder = null,
  now = Date.now,
  options = {},
} = {}) {
  const resolvedTemporal = temporalStore || ragStore?.temporal;
  if (!resolvedTemporal) {
    throw new Error("createDeltaIngest requires temporalStore or ragStore.temporal");
  }

  /**
   * Main Entrypoint: processDocument
   * 4-Pass Batched Pipeline:
   *   Pass 1: Parse sections, match canonical features, classify deltas against pre-mutation snapshot.
   *   Pass 2: Bulk vector cache lookup across all approved NEW / MODIFIED (and optional UNMATCHED) sections.
   *   Pass 3: Single batched embedder.embedDocs() call for all uncached sections (eliminates N sequential HTTP calls).
   *   Pass 4: Atomic SQLite transaction commit with selective sibling preservation (unchanged chunks stay active).
   */
  function processDocument(args) {
    return enqueueForProject(db || NO_DB_QUEUE_KEY, args?.projectId, () =>
      processDocumentNow(args)
    );
  }

  async function processDocumentNow({
    projectId,
    fileId = null,
    document, // file path, string text, or { text, path, name }
    source = "document",
    effectiveAt = null,
    approved = false,
    dryRun = false,
    proposedVersion = null,
    reason = null,
    autoIndexUnmatched = Boolean(options.autoIndexUnmatched),
    embedder: callEmbedder = null,
  }) {
    const activeEmbedder = callEmbedder || embedder;
    const t0 = now();
    const metrics = {
      parse_ms: 0,
      match_ms: 0,
      classification_ms: 0,
      embedding_ms: 0,
      embedding_tokens: 0,
      embedding_cost: 0,
      storage_ms: 0,
      total_ms: 0,
    };

    const warnings = [];
    const errors = [];
    const changes = [];

    const freshSummary = (totalSections = 0) => ({
      total_sections: totalSections,
      new_features: 0,
      unchanged_features: 0,
      modified_features: 0,
      deprecated_features: 0,
      ambiguous_features: 0,
      unmatched_sections: 0,
      unmatched_indexed: 0,
      embeddings_created: 0,
      embeddings_reused: 0,
      embeddings_skipped: 0,
    });
    let summary = freshSummary();

    const ingestionId = `ingest_${now()}_${crypto.randomBytes(4).toString("hex")}`;
    const effTime = effectiveAt != null ? Number(effectiveAt) : now();

    try {
      // 1. Read document text
      let rawText = "";
      let sourceName = source;

      if (typeof document === "string") {
        if (fs.existsSync(document)) {
          rawText = fs.readFileSync(document, "utf8");
          sourceName = path.basename(document);
        } else {
          rawText = document;
        }
      } else if (document && typeof document.text === "string") {
        rawText = document.text;
        if (document.name) sourceName = document.name;
      }

      const standing = docStanding({ name: sourceName });

      // 2. Parse sections
      const tParse = now();
      const sections = extractSections(rawText, {
        sourceDocumentId: ingestionId,
        sourceFilename: sourceName,
      });
      metrics.parse_ms = now() - tParse;
      summary.total_sections = sections.length;

      // Survives re-plans so a retry after a stale snapshot never pays for the same embedding twice.
      const fetchedVectorsByHash = new Map();

      for (let attempt = 0; ; attempt++) {
        summary = freshSummary(sections.length);
        changes.length = 0;
        warnings.length = 0;
        if (attempt > 0) {
          warnings.push(
            `Active chunks changed while embedding; re-planned against the current state (attempt ${attempt + 1}).`
          );
        }

        // -----------------------------------------------------------------------
        // PASS 1: Match & Classify against pre-mutation snapshot
        // -----------------------------------------------------------------------
        const activeSnapshotByFeature = new Map(); // feature_id -> activeChunks[]
        const unchangedHashesByFeature = new Map(); // feature_id -> Set<hash>
        const plans = [];

        // Existing active unmatched chunk hashes for this project (to avoid duplicate unmatched inserts on re-ingest)
        const existingUnmatchedHashes = new Set();
        if (autoIndexUnmatched && db && typeof db.prepare === "function") {
          try {
            const rows = db
              .prepare(
                `SELECT hash FROM copilot_chunks
               WHERE project_id = ? AND feature_id IS NULL
                 AND (lifecycle_status IS NULL OR lifecycle_status = 'active')
                 AND hash IS NOT NULL`
              )
              .all(projectId);
            for (const r of rows) existingUnmatchedHashes.add(r.hash);
          } catch {
            // Non-fatal on mocked DBs
          }
        }

        for (const sec of sections) {
          const tMatch = now();
          const match = matchFeature(sec, featureRegistry, projectId);
          metrics.match_ms += now() - tMatch;

          let activeChunks = [];
          if (match.status === "matched" && match.feature_id) {
            if (!activeSnapshotByFeature.has(match.feature_id)) {
              activeSnapshotByFeature.set(
                match.feature_id,
                resolvedTemporal.getActiveFeatureChunks(projectId, match.feature_id)
              );
            }
            activeChunks = activeSnapshotByFeature.get(match.feature_id);
          }

          const tClass = now();
          const delta = classifySectionDelta({
            section: sec,
            match,
            activeChunks,
            fileId,
          });
          metrics.classification_ms += now() - tClass;

          if (delta.classification === "NEW") summary.new_features++;
          else if (delta.classification === "UNCHANGED") {
            summary.unchanged_features++;
            if (match.feature_id) {
              if (!unchangedHashesByFeature.has(match.feature_id)) {
                unchangedHashesByFeature.set(match.feature_id, new Set());
              }
              unchangedHashesByFeature.get(match.feature_id).add(sec.content_hash);
              unchangedHashesByFeature.get(match.feature_id).add(sec.body_hash);
            }
          } else if (delta.classification === "MODIFIED") summary.modified_features++;
          else if (delta.classification === "DEPRECATED") summary.deprecated_features++;
          else if (delta.classification === "AMBIGUOUS") summary.ambiguous_features++;
          else if (delta.classification === "UNMATCHED") summary.unmatched_sections++;

          const explicitVer = extractVersionFromText(sec.original_text);
          const priorVer = delta.previous_version || (activeChunks[0]?.version ?? null);
          const nextVer =
            proposedVersion || explicitVer || (priorVer ? bumpSemver(priorVer, "minor") : "1.0.0");

          const contextualTitle = buildContextualTitle({
            sourceName,
            standing,
            effectiveAt: effTime,
            hierarchy: sec.hierarchy,
            sectionTitle: sec.section_title,
          });

          const shouldAutoIndex =
            autoIndexUnmatched &&
            (delta.classification === "UNMATCHED" || delta.classification === "AMBIGUOUS") &&
            sec.body_text.trim().length >= 20 &&
            !existingUnmatchedHashes.has(sec.content_hash);

          const changeRecord = {
            section_id: sec.section_id,
            feature_id: match.feature_id,
            feature_name: match.feature_name,
            classification: delta.classification,
            previous_version: priorVer,
            proposed_version:
              delta.classification === "MODIFIED" || delta.classification === "NEW"
                ? nextVer
                : priorVer,
            content_hash: sec.content_hash,
            matched_by: match.matched_by,
            approval_status: approved ? "approved" : "draft",
            action_taken: dryRun ? "dry_run_proposed" : "pending",
            evidence: {
              confidence: match.confidence,
              candidates: match.candidates,
              reason: delta.reason,
            },
          };

          plans.push({
            sec,
            match,
            delta,
            activeChunks,
            nextVer,
            contextualTitle,
            shouldAutoIndex,
            changeRecord,
          });
        }

        if (dryRun) {
          for (const p of plans) {
            if (p.delta.classification === "UNCHANGED") summary.embeddings_reused++;
            else summary.embeddings_skipped++;
            p.changeRecord.action_taken = "dry_run_proposed";
            changes.push(p.changeRecord);
          }
          metrics.total_ms = now() - t0;
          return {
            ingestion_id: ingestionId,
            project_id: projectId,
            source_document: sourceName,
            effective_at: effTime,
            status: "dry_run",
            summary,
            changes,
            warnings,
            errors,
            metrics,
          };
        }

        // -----------------------------------------------------------------------
        // PASS 2: Bulk Vector Cache Lookup across all sections needing embeddings
        // -----------------------------------------------------------------------
        const dims = activeEmbedder?.dims || 768;
        const needEmbedPlans = plans.filter((p) => {
          if (!approved) return false;
          if (p.delta.classification === "NEW" || p.delta.classification === "MODIFIED")
            return true;
          if (p.shouldAutoIndex) return true;
          return false;
        });

        const cachedByHash = new Map();
        if (needEmbedPlans.length > 0 && ragStore && typeof ragStore.cachedVectors === "function") {
          const lookupHashes = [...new Set(needEmbedPlans.map((p) => p.sec.content_hash))];
          const cached = ragStore.cachedVectors(lookupHashes, dims);
          for (const [h, vec] of cached.entries()) {
            cachedByHash.set(h, vec);
          }
        }

        // -----------------------------------------------------------------------
        // PASS 3: Single Batched embedDocs() call for all uncached sections
        // -----------------------------------------------------------------------
        const toEmbedByHash = new Map(); // content_hash -> { title, text }
        for (const p of needEmbedPlans) {
          if (cachedByHash.has(p.sec.content_hash)) continue;
          if (fetchedVectorsByHash.has(p.sec.content_hash)) continue;
          if (!toEmbedByHash.has(p.sec.content_hash)) {
            toEmbedByHash.set(p.sec.content_hash, {
              title: p.contextualTitle,
              text: p.sec.original_text,
            });
          }
        }

        const freshVectorsByHash = fetchedVectorsByHash;
        if (
          toEmbedByHash.size > 0 &&
          activeEmbedder &&
          typeof activeEmbedder.embedDocs === "function"
        ) {
          const entries = [...toEmbedByHash.entries()];
          const tEmb = now();
          const embRes = await activeEmbedder.embedDocs(entries.map(([, doc]) => doc));
          metrics.embedding_ms += now() - tEmb;
          metrics.embedding_tokens += embRes?.tokens || 0;
          metrics.embedding_cost += embRes?.cost || 0;
          const vecs = embRes?.vectors || [];
          entries.forEach(([h], idx) => {
            if (vecs[idx]) freshVectorsByHash.set(h, vecs[idx]);
          });
        }

        // -----------------------------------------------------------------------
        // PASS 4: Atomic SQLite Transaction Commit with Selective Supersession
        // -----------------------------------------------------------------------
        const tStore = now();
        const executeWrites = () => {
          // Inside the transaction and before any write, so a mismatch rolls back nothing
          // and no other writer can slip in between this check and the writes below.
          const staleFeatureIds = [];
          for (const [featureId, snapshot] of activeSnapshotByFeature) {
            const current = resolvedTemporal.getActiveFeatureChunks(projectId, featureId);
            if (!sameChunkIds(snapshot, current)) staleFeatureIds.push(featureId);
          }
          if (staleFeatureIds.length > 0) throw new StaleSnapshotError(staleFeatureIds);

          const activatedFeatureIds = new Set();

          for (const p of plans) {
            const {
              sec,
              match,
              delta,
              activeChunks,
              nextVer,
              contextualTitle,
              shouldAutoIndex,
              changeRecord,
            } = p;
            const chunkMeta = {
              section_id: sec.section_id,
              title: sec.section_title,
              heading: sec.section_title,
              hierarchy: sec.hierarchy,
              contextual_title: contextualTitle,
              source: sourceName,
            };

            if (delta.classification === "UNCHANGED") {
              summary.embeddings_reused++;
              changeRecord.action_taken = "reused";
            } else if (delta.classification === "MODIFIED") {
              if (approved) {
                let vec = cachedByHash.get(sec.content_hash) || null;
                if (vec) {
                  summary.embeddings_reused++;
                } else if (freshVectorsByHash.has(sec.content_hash)) {
                  vec = freshVectorsByHash.get(sec.content_hash);
                  summary.embeddings_created++;
                } else {
                  summary.embeddings_skipped++;
                }

                if (!activatedFeatureIds.has(match.feature_id)) {
                  resolvedTemporal.activateSuccessorVersion({
                    predecessorId: delta.predecessor_chunk_id,
                    newChunkData: {
                      file_id: fileId,
                      project_id: projectId,
                      feature_id: match.feature_id,
                      version: nextVer,
                      text: sec.original_text,
                      hash: sec.content_hash,
                      vec,
                      dims: vec ? vec.length : null,
                      meta: chunkMeta,
                    },
                    effectiveTime: effTime,
                    preserveUnchangedHashes: unchangedHashesByFeature.get(match.feature_id) || null,
                  });
                  activatedFeatureIds.add(match.feature_id);
                } else {
                  // Additional sibling section for the same feature within the same document
                  resolvedTemporal.insertTemporalChunk({
                    file_id: fileId,
                    project_id: projectId,
                    feature_id: match.feature_id,
                    version: nextVer,
                    lifecycle_status: "active",
                    text: sec.original_text,
                    hash: sec.content_hash,
                    vec,
                    dims: vec ? vec.length : null,
                    valid_from: effTime,
                    valid_to: null,
                    meta: chunkMeta,
                  });
                }
                changeRecord.action_taken = "activated";
              } else {
                resolvedTemporal.insertTemporalChunk({
                  file_id: fileId,
                  project_id: projectId,
                  feature_id: match.feature_id,
                  version: nextVer,
                  lifecycle_status: "draft",
                  text: sec.original_text,
                  hash: sec.content_hash,
                  valid_from: effTime,
                  valid_to: null,
                  meta: { ...chunkMeta, note: "Pending approval" },
                });
                summary.embeddings_skipped++;
                changeRecord.action_taken = "draft_stored";
              }
            } else if (delta.classification === "NEW") {
              if (approved) {
                let vec = cachedByHash.get(sec.content_hash) || null;
                if (vec) {
                  summary.embeddings_reused++;
                } else if (freshVectorsByHash.has(sec.content_hash)) {
                  vec = freshVectorsByHash.get(sec.content_hash);
                  summary.embeddings_created++;
                } else {
                  summary.embeddings_skipped++;
                }

                resolvedTemporal.insertTemporalChunk({
                  file_id: fileId,
                  project_id: projectId,
                  feature_id: match.feature_id,
                  version: nextVer,
                  lifecycle_status: "active",
                  text: sec.original_text,
                  hash: sec.content_hash,
                  vec,
                  dims: vec ? vec.length : null,
                  valid_from: effTime,
                  valid_to: null,
                  meta: chunkMeta,
                });
                changeRecord.action_taken = "activated";
              } else {
                resolvedTemporal.insertTemporalChunk({
                  file_id: fileId,
                  project_id: projectId,
                  feature_id: match.feature_id,
                  version: nextVer,
                  lifecycle_status: "draft",
                  text: sec.original_text,
                  hash: sec.content_hash,
                  valid_from: effTime,
                  valid_to: null,
                  meta: { ...chunkMeta, note: "Draft requirement pending approval" },
                });
                summary.embeddings_skipped++;
                changeRecord.action_taken = "draft_stored";
              }
            } else if (delta.classification === "DEPRECATED") {
              if (approved) {
                for (const c of activeChunks) {
                  resolvedTemporal.deprecateChunk(c.id, effTime);
                }
                changeRecord.action_taken = "deprecated";
              } else {
                warnings.push(
                  `Feature '${match.feature_id}' is marked deprecated in text but deprecation was not approved.`
                );
                changeRecord.action_taken = "pending_deprecation";
              }
              summary.embeddings_skipped++;
            } else if (shouldAutoIndex && approved) {
              let vec = cachedByHash.get(sec.content_hash) || null;
              if (vec) {
                summary.embeddings_reused++;
              } else if (freshVectorsByHash.has(sec.content_hash)) {
                vec = freshVectorsByHash.get(sec.content_hash);
                summary.embeddings_created++;
              } else {
                summary.embeddings_skipped++;
              }

              resolvedTemporal.insertTemporalChunk({
                file_id: fileId,
                project_id: projectId,
                feature_id: null,
                version: null,
                lifecycle_status: "active",
                text: sec.original_text,
                hash: sec.content_hash,
                vec,
                dims: vec ? vec.length : null,
                valid_from: effTime,
                valid_to: null,
                meta: chunkMeta,
              });
              existingUnmatchedHashes.add(sec.content_hash);
              summary.unmatched_indexed++;
              changeRecord.action_taken = "indexed_unmatched";
            } else if (autoIndexUnmatched && existingUnmatchedHashes.has(sec.content_hash)) {
              summary.embeddings_reused++;
              changeRecord.action_taken = "reused";
            } else {
              summary.embeddings_skipped++;
              changeRecord.action_taken = "none";
            }

            changes.push(changeRecord);
          }
        };

        try {
          if (db && typeof db.transaction === "function") {
            db.transaction(executeWrites)();
          } else {
            executeWrites();
          }
        } catch (err) {
          metrics.storage_ms += now() - tStore;
          if (!(err instanceof StaleSnapshotError)) throw err;
          if (attempt < MAX_SNAPSHOT_RETRIES) continue;
          throw new Error(
            `${err.message}, again after ${MAX_SNAPSHOT_RETRIES} re-plan(s); another writer keeps changing this project, so nothing was written`
          );
        }
        metrics.storage_ms += now() - tStore;
        metrics.total_ms = now() - t0;

        return {
          ingestion_id: ingestionId,
          project_id: projectId,
          source_document: sourceName,
          effective_at: effTime,
          status: "success",
          summary,
          changes,
          warnings,
          errors,
          metrics,
        };
      }
    } catch (err) {
      metrics.total_ms = now() - t0;
      errors.push(err.message);
      return {
        ingestion_id: ingestionId,
        project_id: projectId,
        source_document: source,
        effective_at: effTime,
        status: "error",
        summary,
        changes,
        warnings,
        errors,
        metrics,
      };
    }
  }

  return {
    extractSections,
    normalizeContent,
    computeContentHash,
    buildContextualTitle,
    matchFeature: (section, projId = null) => matchFeature(section, featureRegistry, projId),
    classifySectionDelta,
    processDocument,
    ingestDocumentDelta: processDocument,
  };
}

module.exports = {
  createDeltaIngest,
  normalizeContent,
  computeContentHash,
  buildContextualTitle,
  extractSections,
  matchFeature,
  classifySectionDelta,
  isExplicitlyDeprecated,
  bumpSemver,
};
