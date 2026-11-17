// src/copilot/rag/deltaIngest.js
// Incremental Semantic Delta Ingestion Engine for Meethu Copilot.
// Compares uploaded requirement documents against previously ingested features,
// identifies semantic deltas, preserves baseline requirements, avoids unnecessary
// re-embeddings through content hashing and vector cache, and manages bi-temporal
// version transitions atomically.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

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
 */
function extractSections(rawText, { sourceDocumentId = "doc", sourceFilename = "document" } = {}) {
  const text = String(rawText || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\0/g, "");

  const lines = text.split("\n");
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

    // Parent is the immediate ancestor in headingStack
    const parent = headingStack.length > 0 ? headingStack[headingStack.length - 1] : null;
    const hierarchy = headingStack.map((h) => h.title);
    if (currentHeading) hierarchy.push(currentHeading.title);

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
      flushCurrentSection();
      const level = hMatch[1].length;
      const title = hMatch[2].trim();

      // Pop stack until parent has smaller level
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop();
      }

      currentHeading = {
        level,
        title,
        section_id: `sec_${sectionIndex}_${slugify(title)}`,
      };
      headingStack.push(currentHeading);
      continue;
    }

    // Numbered heading check (e.g. 1.1 Ingestion Architecture)
    const numMatch = NUMBERED_HEADING_RE.exec(line);
    if (numMatch && (line.startsWith("1.") || line.startsWith("2.") || line.startsWith("3.") || line.startsWith("4.") || line.startsWith("5.") || line.startsWith("6."))) {
      flushCurrentSection();
      const numParts = numMatch[1].split(".");
      const level = Math.min(6, numParts.length);
      const title = `${numMatch[1]} ${numMatch[2].trim()}`;

      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop();
      }

      currentHeading = {
        level,
        title,
        section_id: `sec_${sectionIndex}_${slugify(title)}`,
      };
      headingStack.push(currentHeading);
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

/**
 * Matches an extracted section to a registered canonical feature.
 * Precedence: Exact feature_id -> Canonical name -> Alias -> Keyword -> Unmatched.
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

  // Clean bracketed tags such as [DEPRECATED] or [v2.0.0] from title for canonical matching
  const cleanTitle = String(section.section_title || "")
    .replace(/\[(?:DEPRECATED|RETIRED|OBSOLETE|DRAFT|PROPOSED|ACTIVE)\]/gi, "")
    .replace(/\[v?[0-9]+(?:\.[0-9]+)*\]/gi, "")
    .trim();

  // Use resolveFeature(cleanTitle || sectionTitle, text, projectId)
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
  const priorChunks = fileId != null ? activeChunks.filter((c) => c.file_id !== fileId) : activeChunks;

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
// F. Delta Ingestion Engine Factory
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
   */
  async function processDocument({
    projectId,
    fileId = null,
    document, // file path, string text, or { text, path, name }
    source = "document",
    effectiveAt = null,
    approved = false,
    dryRun = false,
    proposedVersion = null,
    reason = null,
  }) {
    const t0 = now();
    const metrics = {
      parse_ms: 0,
      match_ms: 0,
      classification_ms: 0,
      embedding_ms: 0,
      storage_ms: 0,
      total_ms: 0,
    };

    const warnings = [];
    const errors = [];
    const changes = [];

    const summary = {
      total_sections: 0,
      new_features: 0,
      unchanged_features: 0,
      modified_features: 0,
      deprecated_features: 0,
      ambiguous_features: 0,
      unmatched_sections: 0,
      embeddings_created: 0,
      embeddings_reused: 0,
      embeddings_skipped: 0,
    };

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

      // 2. Parse sections
      const tParse = now();
      const sections = extractSections(rawText, {
        sourceDocumentId: ingestionId,
        sourceFilename: sourceName,
      });
      metrics.parse_ms = now() - tParse;
      summary.total_sections = sections.length;

      // 3. Process each section through Match -> Classify -> Embed -> Store
      for (const sec of sections) {
        // A. Match canonical feature
        const tMatch = now();
        const match = matchFeature(sec, featureRegistry, projectId);
        metrics.match_ms += now() - tMatch;

        // B. Query existing active chunks for this feature
        let activeChunks = [];
        if (match.status === "matched" && match.feature_id) {
          activeChunks = resolvedTemporal.getActiveFeatureChunks(projectId, match.feature_id);
        }

        // C. Classify delta
        const tClass = now();
        const delta = classifySectionDelta({
          section: sec,
          match,
          activeChunks,
          fileId,
        });
        metrics.classification_ms += now() - tClass;

        // Update summary counts
        if (delta.classification === "NEW") summary.new_features++;
        else if (delta.classification === "UNCHANGED") summary.unchanged_features++;
        else if (delta.classification === "MODIFIED") summary.modified_features++;
        else if (delta.classification === "DEPRECATED") summary.deprecated_features++;
        else if (delta.classification === "AMBIGUOUS") summary.ambiguous_features++;
        else if (delta.classification === "UNMATCHED") summary.unmatched_sections++;

        // Determine target version
        const explicitVer = extractVersionFromText(sec.original_text);
        const priorVer = delta.previous_version || (activeChunks[0]?.version ?? null);
        const nextVer =
          proposedVersion || explicitVer || (priorVer ? bumpSemver(priorVer, "minor") : "1.0.0");

        const changeRecord = {
          section_id: sec.section_id,
          feature_id: match.feature_id,
          feature_name: match.feature_name,
          classification: delta.classification,
          previous_version: priorVer,
          proposed_version: delta.classification === "MODIFIED" || delta.classification === "NEW" ? nextVer : priorVer,
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

        // 4. Ingestion / Embedding / Storage Execution
        if (!dryRun) {
          if (delta.classification === "UNCHANGED") {
            summary.embeddings_reused++;
            changeRecord.action_taken = "reused";
          } else if (delta.classification === "MODIFIED") {
            if (approved) {
              // Embedding step: check cache first
              let vec = null;
              const dims = embedder?.dims || 768;
              if (ragStore && typeof ragStore.cachedVectors === "function") {
                const cached = ragStore.cachedVectors([sec.content_hash], dims);
                if (cached.has(sec.content_hash)) {
                  vec = cached.get(sec.content_hash);
                  summary.embeddings_reused++;
                }
              }

              if (!vec && embedder && typeof embedder.embedDocs === "function") {
                const tEmb = now();
                const embRes = await embedder.embedDocs([
                  { title: `${sourceName} · ${sec.section_title}`, text: sec.original_text },
                ]);
                metrics.embedding_ms += now() - tEmb;
                vec = embRes.vectors?.[0] || null;
                summary.embeddings_created++;
              } else if (!vec) {
                summary.embeddings_skipped++;
              }

              // Transactional activation
              const tStore = now();
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
                  meta: {
                    section_id: sec.section_id,
                    title: sec.section_title,
                    source: sourceName,
                  },
                },
                effectiveTime: effTime,
              });
              metrics.storage_ms += now() - tStore;
              changeRecord.action_taken = "activated";
            } else {
              // Unapproved modification -> store as draft
              const tStore = now();
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
                meta: {
                  section_id: sec.section_id,
                  title: sec.section_title,
                  source: sourceName,
                  note: "Pending approval",
                },
              });
              metrics.storage_ms += now() - tStore;
              summary.embeddings_skipped++;
              changeRecord.action_taken = "draft_stored";
            }
          } else if (delta.classification === "NEW") {
            if (approved) {
              let vec = null;
              if (embedder && typeof embedder.embedDocs === "function") {
                const tEmb = now();
                const embRes = await embedder.embedDocs([
                  { title: `${sourceName} · ${sec.section_title}`, text: sec.original_text },
                ]);
                metrics.embedding_ms += now() - tEmb;
                vec = embRes.vectors?.[0] || null;
                summary.embeddings_created++;
              }

              const tStore = now();
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
                meta: { section_id: sec.section_id, title: sec.section_title, source: sourceName },
              });
              metrics.storage_ms += now() - tStore;
              changeRecord.action_taken = "activated";
            } else {
              const tStore = now();
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
                meta: {
                  section_id: sec.section_id,
                  title: sec.section_title,
                  source: sourceName,
                  note: "Draft requirement pending approval",
                },
              });
              metrics.storage_ms += now() - tStore;
              summary.embeddings_skipped++;
              changeRecord.action_taken = "draft_stored";
            }
          } else if (delta.classification === "DEPRECATED") {
            if (approved) {
              const tStore = now();
              for (const c of activeChunks) {
                resolvedTemporal.deprecateChunk(c.id, effTime);
              }
              metrics.storage_ms += now() - tStore;
              changeRecord.action_taken = "deprecated";
            } else {
              warnings.push(
                `Feature '${match.feature_id}' is marked deprecated in text but deprecation was not approved.`
              );
              changeRecord.action_taken = "pending_deprecation";
            }
            summary.embeddings_skipped++;
          } else {
            summary.embeddings_skipped++;
            changeRecord.action_taken = "none";
          }
        } else {
          // Dry Run: skip execution, just estimate embeddings
          if (delta.classification === "UNCHANGED") summary.embeddings_reused++;
          else if (delta.classification === "MODIFIED" || delta.classification === "NEW") {
            summary.embeddings_skipped++;
          } else {
            summary.embeddings_skipped++;
          }
          changeRecord.action_taken = "dry_run_proposed";
        }

        changes.push(changeRecord);
      }

      metrics.total_ms = now() - t0;

      return {
        ingestion_id: ingestionId,
        project_id: projectId,
        source_document: sourceName,
        effective_at: effTime,
        status: dryRun ? "dry_run" : "success",
        summary,
        changes,
        warnings,
        errors,
        metrics,
      };
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
  extractSections,
  matchFeature,
  classifySectionDelta,
  isExplicitlyDeprecated,
  bumpSemver,
};
