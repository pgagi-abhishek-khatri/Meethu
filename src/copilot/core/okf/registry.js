// src/copilot/core/okf/registry.js
// In-memory registry and loader for OKF (Official Knowledge Framework) canonical documents.
// Pure, Electron-free. Caches manifest and canonical document contents for sub-millisecond lookup.

const defaultFs = require("fs");
const defaultPath = require("path");
const defaultYaml = require("js-yaml");
const { createAuthoritativeLookupService } = require("./lookup");

function createOkfRegistry({
  okfDir = null,
  fs = defaultFs,
  path = defaultPath,
  yaml = defaultYaml,
} = {}) {
  const resolvedDir = okfDir || path.resolve(__dirname, "../../../../OKF");
  const manifestPath = path.join(resolvedDir, "manifest.yaml");

  let manifest = null;
  let docsById = new Map();
  let docsByTag = new Map();
  let contentCache = new Map();
  let als = null;
  let loaded = false;

  function load() {
    loaded = true;
    if (!fs.existsSync(manifestPath)) {
      manifest = null;
      docsById.clear();
      docsByTag.clear();
      contentCache.clear();
      return false;
    }

    try {
      const raw = fs.readFileSync(manifestPath, "utf8");
      manifest = yaml.load(raw);
    } catch {
      manifest = null;
      return false;
    }

    docsById.clear();
    docsByTag.clear();
    contentCache.clear();

    if (manifest && Array.isArray(manifest.documents)) {
      for (const doc of manifest.documents) {
        if (!doc || !doc.id) continue;
        docsById.set(doc.id, doc);
      }
    }

    als = createAuthoritativeLookupService({
      manifest,
      getDocumentContent: getDocument,
      okfDir: resolvedDir,
      path,
    });

    return true;
  }

  function ensureLoaded() {
    if (!loaded) load();
  }

  // Returns { metadata, body, raw } or null
  function getDocument(id) {
    ensureLoaded();
    const docEntry = docsById.get(id);
    if (!docEntry) return null;

    if (contentCache.has(id)) {
      return contentCache.get(id);
    }

    const fullPath = path.join(resolvedDir, docEntry.path);
    if (!fs.existsSync(fullPath)) return null;

    try {
      const raw = fs.readFileSync(fullPath, "utf8");
      const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
      let metadata = {};
      let body = raw;
      if (match) {
        try {
          metadata = yaml.load(match[1]) || {};
          body = match[2].trim();
        } catch {}
      }

      const result = {
        id: docEntry.id,
        path: docEntry.path,
        version: docEntry.version,
        status: docEntry.status,
        title: docEntry.title,
        metadata,
        body,
        raw,
      };
      contentCache.set(id, result);
      return result;
    } catch {
      return null;
    }
  }

  // Finds documents matching exact ID, title tokens, or tags
  function lookup(query) {
    ensureLoaded();
    if (!manifest || !manifest.documents) return [];

    const q = String(query || "").toLowerCase();
    const matches = new Map();

    // 1. Direct ID check (e.g. "okf-0002")
    const idMatch = q.match(/\bokf-[0-9]{4}\b/i);
    if (idMatch) {
      const idUpper = idMatch[0].toUpperCase();
      const doc = docsById.get(idUpper);
      if (doc) matches.set(doc.id, { doc, score: 1.0, reason: "exact_id" });
    }

    // 2. Title and keyword matching
    for (const doc of manifest.documents) {
      if (matches.has(doc.id)) continue;
      const titleLower = String(doc.title || "").toLowerCase();

      // Check if whole title or key parts of title are contained in the query
      if (q.includes(titleLower)) {
        matches.set(doc.id, { doc, score: 0.9, reason: "title_match" });
        continue;
      }

      // Check specific domain keywords (e.g. "copilot architecture")
      const titleWords = titleLower
        .split(/[^a-z0-9]+/g)
        .filter((w) => w.length > 3 && !["with", "and", "from", "that"].includes(w));
      
      const matchedWords = titleWords.filter((w) => q.includes(w));
      if (matchedWords.length >= 2 && matchedWords.length / titleWords.length >= 0.5) {
        matches.set(doc.id, { doc, score: 0.75, reason: "keyword_overlap" });
      }
    }

    return Array.from(matches.values())
      .sort((a, b) => b.score - a.score)
      .map((m) => ({ ...m.doc, matchScore: m.score, matchReason: m.reason }));
  }

  return {
    load,
    hasBundle: () => {
      ensureLoaded();
      return !!(manifest && manifest.bundle_id && docsById.size > 0);
    },
    getManifest: () => {
      ensureLoaded();
      return manifest;
    },
    getDocuments: () => {
      ensureLoaded();
      return manifest?.documents || [];
    },
    getDocumentById: (id) => {
      ensureLoaded();
      return docsById.get(id) || null;
    },
    getDocument,
    lookup,
    get als() {
      ensureLoaded();
      return als;
    },
  };
}

module.exports = { createOkfRegistry };
