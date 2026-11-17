// src/copilot/core/okf/lookup.js
// Authoritative Lookup Service (ALS) for OKF canonical source-of-truth documents.
// Pure, Electron-free. Strictly ZERO vector search. Resolves canonical facts deterministically.

const defaultPath = require("path");
const { compareSemVer, resolvePrecedence } = require("./versionResolver");

// Normalizes title strings for exact matching
function normalizeTitle(s) {
  if (typeof s !== "string") return "";
  return s
    .trim()
    .toLowerCase()
    .replace(/[\u2014\u2013]/g, "-") // em-dash, en-dash to hyphen
    .replace(/["'“”‘’]/g, "") // strip quotes
    .replace(/[.:;]+$/g, "") // strip trailing punctuation
    .replace(/\s+/g, " "); // collapse whitespace
}

// Tokenizes keyword for exact keyword indexing
function normalizeKeyword(k) {
  if (typeof k !== "string") return "";
  return k.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "");
}

function createAuthoritativeLookupService({
  manifest = null,
  getDocumentContent = () => null,
  okfDir = null,
  path = defaultPath,
} = {}) {
  const idIndex = new Map(); // ID -> DocumentRecord[]
  const titleIndex = new Map(); // NormalizedTitle -> DocumentRecord[]
  const aliasIndex = new Map(); // NormalizedAlias -> DocumentRecord[]
  const keywordIndex = new Map(); // NormalizedKeyword -> Set<DocumentRecord>
  const tagIndex = new Map(); // CanonicalTag -> Set<DocumentRecord>
  let bundleId = manifest?.bundle_id || "openwhispr-canonical-v1";
  let hasCorruptedIndex = false;

  function buildIndexes() {
    idIndex.clear();
    titleIndex.clear();
    aliasIndex.clear();
    keywordIndex.clear();
    tagIndex.clear();
    hasCorruptedIndex = false;

    if (!manifest || !Array.isArray(manifest.documents)) return;

    for (const doc of manifest.documents) {
      if (!doc || !doc.id) {
        hasCorruptedIndex = true;
        continue;
      }

      // 1. ID Index
      const idUpper = doc.id.toUpperCase();
      if (!idIndex.has(idUpper)) idIndex.set(idUpper, []);
      idIndex.get(idUpper).push(doc);

      // 2. Title Index
      if (doc.title) {
        const normTitle = normalizeTitle(doc.title);
        if (!titleIndex.has(normTitle)) titleIndex.set(normTitle, []);
        titleIndex.get(normTitle).push(doc);

        // Keywords from title
        const words = normTitle.split(/[^a-z0-9-]+/g).filter((w) => w.length > 3);
        for (const w of words) {
          const kw = normalizeKeyword(w);
          if (!kw) continue;
          if (!keywordIndex.has(kw)) keywordIndex.set(kw, new Set());
          keywordIndex.get(kw).add(doc);
        }
      }

      // 3. Extract metadata from document frontmatter if getDocumentContent is available
      let aliases = Array.isArray(doc.aliases) ? [...doc.aliases] : [];
      let keywords = Array.isArray(doc.keywords) ? [...doc.keywords] : [];
      let tags = Array.isArray(doc.tags) ? [...doc.tags] : [];

      if (typeof getDocumentContent === "function") {
        try {
          const docContent = getDocumentContent(doc.id);
          if (docContent && docContent.metadata) {
            if (Array.isArray(docContent.metadata.aliases)) {
              aliases.push(...docContent.metadata.aliases);
            }
            if (Array.isArray(docContent.metadata.keywords)) {
              keywords.push(...docContent.metadata.keywords);
            }
            if (Array.isArray(docContent.metadata.tags)) {
              tags.push(...docContent.metadata.tags);
            }
          }
        } catch {}
      }

      // 3. Aliases
      for (const alias of aliases) {
        const normAlias = normalizeTitle(alias);
        if (!aliasIndex.has(normAlias)) aliasIndex.set(normAlias, []);
        aliasIndex.get(normAlias).push(doc);
      }

      // 4. Keywords
      for (const kwRaw of keywords) {
        const kw = normalizeKeyword(kwRaw);
        if (!kw) continue;
        if (!keywordIndex.has(kw)) keywordIndex.set(kw, new Set());
        keywordIndex.get(kw).add(doc);
      }

      // 5. Tags
      for (const tag of tags) {
        const tagNorm = String(tag).trim().toLowerCase();
        if (!tagIndex.has(tagNorm)) tagIndex.set(tagNorm, new Set());
        tagIndex.get(tagNorm).add(doc);
      }
    }
  }

  buildIndexes();

  // Path traversal protection: ensures target path stays strictly inside OKF/documents/
  function isSafePath(relPath) {
    if (!okfDir || !relPath) return true;
    const resolvedPath = path.resolve(okfDir, relPath);
    const documentsRoot = path.resolve(okfDir, "documents");
    return resolvedPath.startsWith(documentsRoot);
  }

  // Exact ID Lookup
  function lookupById(id, options = {}) {
    const idUpper = String(id || "").trim().toUpperCase();
    const candidates = idIndex.get(idUpper) || [];
    return resolvePrecedence(candidates, options);
  }

  // Exact Title Lookup
  function lookupByTitle(title, options = {}) {
    const norm = normalizeTitle(title);
    if (!norm) return { status: "not_found", resolvedRecord: null, reason: "Empty title" };

    let candidates = titleIndex.get(norm);
    let matchedBy = "title";

    if (!candidates || candidates.length === 0) {
      candidates = aliasIndex.get(norm);
      matchedBy = "alias";
    }

    if (!candidates || candidates.length === 0) {
      return { status: "not_found", resolvedRecord: null, reason: `Title '${norm}' not found` };
    }

    // Check if multiple distinct document IDs share this exact title
    const distinctIds = new Set(candidates.map((c) => c.id));
    if (distinctIds.size > 1 && !options.requestedVersion) {
      return {
        status: "ambiguous",
        resolvedRecord: null,
        reason: `Multiple distinct documents share title '${norm}': ${Array.from(distinctIds).join(", ")}`,
      };
    }

    const res = resolvePrecedence(candidates, options);
    return { ...res, matchedBy };
  }

  // Exact Keyword Lookup
  function lookupByKeyword(keyword, options = {}) {
    const kw = normalizeKeyword(keyword);
    if (!kw) return { status: "not_found", resolvedRecord: null, reason: "Empty keyword" };

    const candidateSet = keywordIndex.get(kw);
    if (!candidateSet || candidateSet.size === 0) {
      return { status: "not_found", resolvedRecord: null, reason: `Keyword '${kw}' not found` };
    }

    const candidates = Array.from(candidateSet);
    const distinctIds = new Set(candidates.map((c) => c.id));
    if (distinctIds.size > 1 && !options.requestedVersion) {
      return {
        status: "ambiguous",
        resolvedRecord: null,
        reason: `Keyword '${kw}' matches multiple documents: ${Array.from(distinctIds).join(", ")}`,
      };
    }

    const res = resolvePrecedence(candidates, options);
    return { ...res, matchedBy: "keyword" };
  }

  // Canonical Tag Lookup (Supports AND / OR)
  function lookupByTag(tags, { operator = "AND", ...options } = {}) {
    const tagList = Array.isArray(tags) ? tags : [tags];
    const normalizedTags = tagList.map((t) => String(t || "").trim().toLowerCase()).filter(Boolean);

    if (normalizedTags.length === 0) {
      return { status: "not_found", resolvedRecord: null, reason: "No valid tags provided" };
    }

    let matchingDocs = null;

    for (const tag of normalizedTags) {
      const set = tagIndex.get(tag) || new Set();
      if (matchingDocs === null) {
        matchingDocs = new Set(set);
      } else if (operator === "AND") {
        for (const doc of matchingDocs) {
          if (!set.has(doc)) matchingDocs.delete(doc);
        }
      } else {
        // OR
        for (const doc of set) matchingDocs.add(doc);
      }
    }

    if (!matchingDocs || matchingDocs.size === 0) {
      return { status: "not_found", resolvedRecord: null, reason: `Tags '${normalizedTags.join(", ")}' not found` };
    }

    const candidates = Array.from(matchingDocs);
    const docsByIdGroup = new Map();
    for (const cand of candidates) {
      if (!docsByIdGroup.has(cand.id)) docsByIdGroup.set(cand.id, []);
      docsByIdGroup.get(cand.id).push(cand);
    }

    const resolvedDocs = [];
    let hasAmbiguity = false;
    let ambiguityReason = "";

    for (const [, group] of docsByIdGroup) {
      const groupRes = resolvePrecedence(group, options);
      if (groupRes.status === "ambiguous") {
        hasAmbiguity = true;
        ambiguityReason = groupRes.reason;
        break;
      }
      if (groupRes.status === "resolved") {
        resolvedDocs.push(groupRes.resolvedRecord);
      }
    }

    if (hasAmbiguity) {
      return {
        status: "ambiguous",
        resolvedRecord: null,
        reason: ambiguityReason,
        matchedBy: "tag",
      };
    }

    if (resolvedDocs.length === 0) {
      return {
        status: "no_authoritative_version",
        resolvedRecord: null,
        reason: `No authoritative version available for documents matching tags '${normalizedTags.join(", ")}'`,
        matchedBy: "tag",
      };
    }

    return {
      status: "resolved",
      resolvedRecord: resolvedDocs[0],
      allRecords: resolvedDocs,
      matchedBy: "tag",
      reason: `Resolved ${resolvedDocs.length} canonical document(s) for tags '${normalizedTags.join(", ")}'`,
    };
  }

  // Unified Resolve Entry Point
  function resolve(request = {}) {
    const t0 = Date.now();

    if (!manifest) {
      return {
        status: "registry_error",
        error: "Manifest not loaded or unavailable",
        latency_ms: Date.now() - t0,
      };
    }

    const type = request.type || "auto";
    const value = request.value;
    const options = {
      requestedVersion: request.version || null,
      allowDraft: !!request.allowDraft,
      allowDeprecated: !!request.allowDeprecated,
    };

    let outcome = null;

    if (type === "id") {
      outcome = lookupById(value, options);
      outcome.matchedBy = "id";
    } else if (type === "title") {
      outcome = lookupByTitle(value, options);
    } else if (type === "keyword") {
      outcome = lookupByKeyword(value, options);
    } else if (type === "tag") {
      outcome = lookupByTag(value, { ...options, operator: request.tagOperator || "AND" });
    } else {
      // "auto" detection
      const valStr = String(value || "").trim();

      // 1. Direct ID pattern match
      const idMatch = valStr.match(/\bokf-[0-9]{4}\b/i);
      if (idMatch) {
        outcome = lookupById(idMatch[0], options);
        outcome.matchedBy = "id";
      }

      // 2. Exact Title match
      if (!outcome || outcome.status === "not_found") {
        const titleRes = lookupByTitle(valStr, options);
        if (titleRes.status !== "not_found") {
          outcome = titleRes;
        }
      }

      // 3. Keyword / Tag fallback
      if (!outcome || outcome.status === "not_found") {
        const tagMatch = valStr.match(/\b(domain|type|tier|platform):[a-z0-9-]+\b/i);
        if (tagMatch) {
          outcome = lookupByTag(tagMatch[0], options);
        }
      }
    }

    if (!outcome || outcome.status !== "resolved") {
      // Check if document was superseded and needs redirection
      if (outcome && outcome.status === "superseded" && outcome.supersededTo) {
        const targetId = outcome.supersededTo;
        const targetRes = lookupById(targetId, options);
        if (targetRes.status === "resolved") {
          const docContent = getDocumentContent(targetRes.resolvedRecord.id);
          return {
            status: "resolved",
            document: docContent,
            matched_by: outcome.matchedBy || type,
            provenance: {
              bundle_id: bundleId,
              document_id: targetRes.resolvedRecord.id,
              version: targetRes.resolvedRecord.version,
              status: targetRes.resolvedRecord.status,
              sha256: targetRes.resolvedRecord.sha256,
              source_path: targetRes.resolvedRecord.path,
              superseded_from: outcome.resolvedRecord.id,
            },
            latency_ms: Date.now() - t0,
          };
        }
      }

      return {
        status: outcome ? outcome.status : "not_found",
        error: outcome ? outcome.reason : `No match found for query '${value}'`,
        latency_ms: Date.now() - t0,
      };
    }

    const rec = outcome.resolvedRecord;

    // Security: Check path traversal
    if (!isSafePath(rec.path)) {
      return {
        status: "registry_error",
        error: `Security violation: Path '${rec.path}' attempts traversal outside OKF root`,
        latency_ms: Date.now() - t0,
      };
    }

    // Load document content
    const docContent = getDocumentContent(rec.id);
    if (!docContent) {
      return {
        status: "registry_error",
        error: `Document file missing on disk: '${rec.path}'`,
        latency_ms: Date.now() - t0,
      };
    }

    return {
      status: "resolved",
      document: docContent,
      matched_by: outcome.matchedBy || type,
      provenance: {
        bundle_id: bundleId,
        document_id: rec.id,
        version: rec.version,
        status: rec.status,
        sha256: rec.sha256,
        source_path: rec.path,
      },
      latency_ms: Date.now() - t0,
    };
  }

  return {
    normalizeTitle,
    normalizeKeyword,
    buildIndexes,
    lookupById,
    lookupByTitle,
    lookupByKeyword,
    lookupByTag,
    resolve,
  };
}

module.exports = {
  createAuthoritativeLookupService,
  normalizeTitle,
  normalizeKeyword,
};
