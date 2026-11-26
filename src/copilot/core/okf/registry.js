// src/copilot/core/okf/registry.js
// In-memory registry and loader for OKF (Official Knowledge Framework) canonical documents.
// Pure, Electron-free. Caches manifest and canonical document contents for sub-millisecond lookup.

const crypto = require("crypto");
const defaultFs = require("fs");
const defaultPath = require("path");
const defaultYaml = require("js-yaml");
const { createAuthoritativeLookupService } = require("./lookup");
const { createFeatureRegistry } = require("./featureRegistry");

function createOkfRegistry({
  okfDir = null,
  registryPath = null,
  registryDir = null,
  fs = defaultFs,
  path = defaultPath,
  yaml = defaultYaml,
  log = () => {},
} = {}) {
  const resolvedDir = okfDir || path.resolve(__dirname, "../../../../OKF");
  const manifestPath = path.join(resolvedDir, "manifest.yaml");

  let manifest = null;
  let docsById = new Map();
  let docsByTag = new Map();
  let contentCache = new Map();
  let als = null;
  let featureRegistry = null;
  let loaded = false;
  let loadError = null; // why the manifest could not be used, when it exists but is unreadable
  const integrityFailures = new Map(); // id -> issue: documents whose bytes no longer match the manifest's sha256

  const sha256 = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

  function load() {
    loaded = true;
    loadError = null;
    integrityFailures.clear();

    // Initialize/reload feature registry
    featureRegistry = createFeatureRegistry({
      okfDir: resolvedDir,
      registryPath,
      registryDir,
      fs,
      path,
      yaml,
    });
    featureRegistry.load();

    if (!fs.existsSync(manifestPath)) {
      manifest = null;
      docsById.clear();
      docsByTag.clear();
      contentCache.clear();
      als = createAuthoritativeLookupService({
        manifest: null,
        getDocumentContent: () => null,
        okfDir: resolvedDir,
        path,
        featureRegistry,
      });
      return false;
    }

    try {
      const raw = fs.readFileSync(manifestPath, "utf8");
      manifest = yaml.load(raw);
    } catch (error) {
      // Distinct from "no bundle": the manifest is there but cannot be read, so nothing canonical is served.
      manifest = null;
      loadError = error?.message || String(error);
      log({ event: "okf_manifest_parse_failed", error: loadError });
      docsById.clear();
      docsByTag.clear();
      contentCache.clear();
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
      featureRegistry,
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
    if (integrityFailures.has(id)) return null; // already judged: do not re-read a refused file on every call

    if (contentCache.has(id)) {
      return contentCache.get(id);
    }

    const fullPath = path.join(resolvedDir, docEntry.path);
    if (!fs.existsSync(fullPath)) return null;

    try {
      const raw = fs.readFileSync(fullPath, "utf8");
      // The manifest is the contract: bytes that differ from its hash are not canonical, whatever the file says.
      let integrity = "unverified";
      if (docEntry.sha256) {
        if (sha256(raw) !== docEntry.sha256) {
          const issue = { id: docEntry.id, path: docEntry.path, expected: docEntry.sha256, actual: sha256(raw) };
          integrityFailures.set(docEntry.id, issue);
          log({ event: "okf_integrity_failed", ...issue });
          return null;
        }
        integrity = "ok";
      }
      const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
      let metadata = {};
      let body = raw;
      if (match) {
        try {
          metadata = yaml.load(match[1]) || {};
          body = match[2].trim();
        } catch (error) {
          log({ event: "front_matter_parse_failed", id: docEntry.id, path: docEntry.path, error: error.message });
        }
      }

      const result = {
        id: docEntry.id,
        path: docEntry.path,
        version: docEntry.version,
        status: docEntry.status,
        title: docEntry.title,
        integrity,
        metadata,
        body,
        raw,
      };
      contentCache.set(id, result);
      return result;
    } catch (error) {
      log({ event: "okf_document_read_failed", id, error: error?.message });
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
    // What an operator needs to know about the bundle: is there a manifest, did it parse, which documents failed
    // their hash. Only documents already read are listed, so call getDocument for each first (see verifyAll).
    getLoadStatus: () => {
      ensureLoaded();
      return {
        manifestPresent: !!manifest || !!loadError || fs.existsSync(manifestPath),
        error: loadError,
        integrityIssues: [...integrityFailures.values()],
      };
    },
    // Reads every document once so every failure is listed.
    verifyAll: () => {
      ensureLoaded();
      for (const id of docsById.keys()) getDocument(id);
      return [...integrityFailures.values()];
    },
    lookup,
    get als() {
      ensureLoaded();
      return als;
    },
    get featureRegistry() {
      ensureLoaded();
      return featureRegistry;
    },
    getFeatures: (projectId = null) => {
      ensureLoaded();
      return featureRegistry?.getFeatures(projectId) || [];
    },
    getFeatureById: (featureId, projectId = null) => {
      ensureLoaded();
      return featureRegistry?.getFeatureById(featureId, projectId) || null;
    },
    getFeatureByName: (name, projectId = null) => {
      ensureLoaded();
      return featureRegistry?.getFeatureByName(name, projectId) || null;
    },
    getFeatureByAlias: (alias, projectId = null) => {
      ensureLoaded();
      return featureRegistry?.getFeatureByAlias(alias, projectId) || null;
    },
    findFeaturesByKeyword: (keyword, projectId = null) => {
      ensureLoaded();
      return featureRegistry?.findFeaturesByKeyword(keyword, projectId) || [];
    },
    getCurrentApprovedVersion: (featureId, projectId = null) => {
      ensureLoaded();
      return (
        featureRegistry?.getCurrentApprovedVersion(featureId, projectId) || {
          status: "not_found",
          reason: "Feature registry not loaded",
        }
      );
    },
    getFeatureLineage: (featureId, projectId = null) => {
      ensureLoaded();
      return (
        featureRegistry?.getFeatureLineage(featureId, projectId) || {
          status: "not_found",
          reason: "Feature registry not loaded",
        }
      );
    },
    resolveFeature: (queryOrRequest, projectId = null) => {
      ensureLoaded();
      return (
        featureRegistry?.resolveFeature(queryOrRequest, projectId) || {
          matched: false,
          reason: "Feature registry not loaded",
        }
      );
    },
  };
}

module.exports = { createOkfRegistry };
