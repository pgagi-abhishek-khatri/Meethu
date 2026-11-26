// src/copilot/core/okf/router.js
// Pure, Electron-free OKF Router Gate.
// Classifies queries into 'okf', 'rag', or 'mixed' and formats passages with deterministic precedence.

const {
  createTemporalRouter,
  classifyTemporalIntent,
  extractTemporalParameters,
} = require("./temporalRouter");
const { classifyIntent: classifyWhenToCall, ROUTES } = require("../trigger/whenToCallRouter");
const {
  resolveEvidence,
  normalizeEvidence,
  detectConflicts,
  buildProvenance,
  formatEvidenceForContext,
  resolvePrecedence,
} = require("./versionResolver");

const { rankDocuments, resolveSuperseded } = require("./precedence");

const CANONICAL_INTENT =
  /\b(official|approved|contract|standard|policy|formula|rule|architecture|invariant|spec|specification|canonical|okf-[0-9]{4}|feat:[a-z0-9_:-]+)\b/i;

const EXPLORATORY_INTENT =
  /\b(discuss|discussed|meeting|notes|talked about|who said|what did we say|history|previous|agenda|proposal|draft|timeline)\b/i;

const CLASSIFIER_VERSION = "1.0.0";

const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s || "");

function createOkfRouter({ defaultBudget = 2800 } = {}) {
  function classifyQuery({ query = "", spec = {}, registry = null }) {
    const q = String(query || "").trim();
    const signals = [];

    const temporalClassification = classifyTemporalIntent(q);
    const temporalExtraction = extractTemporalParameters(q);
    const attachTemporal = (res) => ({
      ...res,
      temporal: {
        intent: temporalClassification.intent,
        confidence: temporalClassification.confidence,
        ...temporalExtraction.temporal,
        ambiguity: temporalExtraction.ambiguity,
      },
    });

    const isCanonical = CANONICAL_INTENT.test(q);
    const isExploratory = EXPLORATORY_INTENT.test(q);

    // Dynamic When-to-Call Router check (Tier 1 & Tier 2)
    const whenToCall = classifyWhenToCall(q, {
      hasIndex: Boolean(spec.project || spec.projectAuto),
      localCodeMode: Boolean(spec.localCodeMode),
    });
    if (whenToCall.route === ROUTES.DIRECT_ANSWER && !isCanonical) {
      return attachTemporal({
        route: "direct",
        confidence: whenToCall.confidence,
        reason: whenToCall.rationale,
        matched_signals: ["intent:direct", ...(whenToCall.signals || [])],
        matched_doc_ids: [],
        classifier_version: CLASSIFIER_VERSION,
        whenToCall,
      });
    }

    // Naming a canonical entity outright (feat:… or OKF-####) is a request for the canonical record, even when the
    // wording also sounds like a code question ("specification", "architecture").
    const namesCanonicalEntity = /\bfeat:[a-z0-9_:-]+\b/i.test(q) || /\bokf-[0-9]{4}\b/i.test(q);
    if (whenToCall.route === ROUTES.LOCAL_CODE_VECTORLESS && !namesCanonicalEntity) {
      return attachTemporal({
        route: "local_vectorless",
        confidence: whenToCall.confidence,
        reason: whenToCall.rationale,
        matched_signals: ["intent:local_code_vectorless", ...(whenToCall.signals || [])],
        matched_doc_ids: [],
        classifier_version: CLASSIFIER_VERSION,
        whenToCall,
      });
    }

    if (whenToCall.route === ROUTES.OKF_CANONICAL) {
      signals.push("intent:git_canonical");
    }

    if (isCanonical) signals.push("intent:canonical");
    if (isExploratory) signals.push("intent:exploratory");

    // Match entities against registry
    const matches = registry && typeof registry.lookup === "function" ? registry.lookup(q) : [];
    // A superseded document leads to the one that replaced it; anything not approved (and with no approved
    // successor) is not canonical. Several matches are ordered by the manifest's precedence rules.
    const getById = (id) =>
      typeof registry?.getDocumentById === "function" ? registry.getDocumentById(id) : null;
    const resolved = new Map();
    for (const m of matches) {
      const r = resolveSuperseded(m, getById);
      if (!r.doc || resolved.has(r.doc.id)) continue;
      resolved.set(r.doc.id, r.doc);
      if (r.redirected) signals.push(`redirect:${m.id}->${r.doc.id}`);
    }
    const approvedMatches = rankDocuments([...resolved.values()]);
    const matchedDocIds = approvedMatches.map((m) => m.id);

    for (const id of matchedDocIds) {
      signals.push(`entity:${id}`);
    }

    // Direct Feature ID mention (e.g. feat:ingestion_pipeline)
    const featMatch = q.match(/\bfeat:[a-z0-9_:-]+\b/i);
    if (featMatch) {
      signals.push(`feature:${featMatch[0]}`);
      if (isExploratory) {
        return attachTemporal({
          route: "mixed",
          confidence: 0.95,
          reason: `Explicit Feature ID with exploratory cues: ${featMatch[0]}`,
          matched_signals: signals,
          matched_doc_ids: matchedDocIds,
          classifier_version: CLASSIFIER_VERSION,
        });
      }
      return attachTemporal({
        route: "okf",
        confidence: 1.0,
        reason: `Explicit Feature ID requested: ${featMatch[0]}`,
        matched_signals: signals,
        matched_doc_ids: matchedDocIds,
        classifier_version: CLASSIFIER_VERSION,
      });
    }

    // Direct OKF ID mention (e.g. OKF-0002)
    if (/\bokf-[0-9]{4}\b/i.test(q) && matchedDocIds.length > 0) {
      if (isExploratory) {
        return attachTemporal({
          route: "mixed",
          confidence: 0.95,
          reason: `Explicit OKF ID with exploratory cues: ${matchedDocIds.join(", ")}`,
          matched_signals: signals,
          matched_doc_ids: matchedDocIds,
          classifier_version: CLASSIFIER_VERSION,
        });
      }
      return attachTemporal({
        route: "okf",
        confidence: 1.0,
        reason: `Explicit OKF ID requested: ${matchedDocIds.join(", ")}`,
        matched_signals: signals,
        matched_doc_ids: matchedDocIds,
        classifier_version: CLASSIFIER_VERSION,
      });
    }

    // Entity match + Canonical intent
    if (matchedDocIds.length > 0 && isCanonical && !isExploratory) {
      return attachTemporal({
        route: "okf",
        confidence: 0.95,
        reason: `Canonical intent matching approved entity: ${matchedDocIds.join(", ")}`,
        matched_signals: signals,
        matched_doc_ids: matchedDocIds,
        classifier_version: CLASSIFIER_VERSION,
      });
    }

    // Entity match + Exploratory intent -> Mixed
    if (matchedDocIds.length > 0 && isExploratory) {
      return attachTemporal({
        route: "mixed",
        confidence: 0.9,
        reason: `Mixed query: official entity ${matchedDocIds.join(", ")} alongside exploratory discussion cues`,
        matched_signals: signals,
        matched_doc_ids: matchedDocIds,
        classifier_version: CLASSIFIER_VERSION,
      });
    }

    // Entity match without explicit cues -> okf if exact title, else mixed if files asked
    if (matchedDocIds.length > 0) {
      const topMatch = approvedMatches[0];
      if (topMatch.matchReason === "exact_id" || topMatch.matchReason === "title_match") {
        return attachTemporal({
          route: "okf",
          confidence: 0.85,
          reason: `Strong entity title/ID match: ${topMatch.id}`,
          matched_signals: signals,
          matched_doc_ids: matchedDocIds,
          classifier_version: CLASSIFIER_VERSION,
        });
      }
    }

    // Canonical cue but no registered entity match
    if (isCanonical && !isExploratory) {
      return attachTemporal({
        route: "mixed",
        confidence: 0.7,
        reason: "Canonical query intent without direct OKF entity match; fallback to hybrid",
        matched_signals: signals,
        matched_doc_ids: matchedDocIds,
        classifier_version: CLASSIFIER_VERSION,
      });
    }

    // Exploratory cue without canonical intent
    if (isExploratory) {
      return attachTemporal({
        route: "rag",
        confidence: 0.95,
        reason: "Exploratory / meeting memory query intent",
        matched_signals: signals,
        matched_doc_ids: matchedDocIds,
        classifier_version: CLASSIFIER_VERSION,
      });
    }

    // Standard D1 project search request
    if (spec.project || spec.projectAuto) {
      return attachTemporal({
        route: "rag",
        confidence: 0.8,
        reason: "Standard project file search triggered by decider",
        matched_signals: signals,
        matched_doc_ids: matchedDocIds,
        classifier_version: CLASSIFIER_VERSION,
      });
    }

    // Ambiguous query default
    return attachTemporal({
      route: "rag",
      confidence: 0.5,
      reason: "Ambiguous query without strong canonical cues; default to RAG lane",
      matched_signals: signals,
      matched_doc_ids: matchedDocIds,
      classifier_version: CLASSIFIER_VERSION,
    });
  }

  function assemblePassages({ route, okfDoc = null, ragText = "", budget = defaultBudget }) {
    if (route === "okf") {
      if (!okfDoc || !okfDoc.body) return "";
      const header = `[CANONICAL SPECIFICATION: ${okfDoc.id} · ${okfDoc.title} (v${okfDoc.version}, ${okfDoc.status})]`;
      const body = clip(okfDoc.body, budget - header.length - 10);
      return `${header}\n${body}`;
    }

    if (route === "rag") {
      // the search already sized its passages; cutting them here would drop the newest ones and the note on
      // which document wins
      return ragText || "";
    }

    if (route === "mixed") {
      const hasOkf = okfDoc && okfDoc.body;
      const hasRag = ragText && ragText.trim().length > 0;

      if (hasOkf && !hasRag) {
        return assemblePassages({ route: "okf", okfDoc, budget });
      }
      if (!hasOkf && hasRag) {
        return assemblePassages({ route: "rag", ragText, budget });
      }
      if (!hasOkf && !hasRag) {
        return "";
      }

      // 50/50 budget split
      const okfBudget = Math.floor(budget * 0.5);
      const ragBudget = budget - okfBudget;

      const okfHeader = `=== AUTHORITATIVE CANONICAL BASELINE (Governing Source of Truth) ===\n[${okfDoc.id} · ${okfDoc.title} (v${okfDoc.version}, ${okfDoc.status})]`;
      const okfBody = clip(okfDoc.body, okfBudget - okfHeader.length - 10);

      const ragHeader = `\n\n=== SUPPORTING PROJECT EXPLORATION (Informal / Subject to Precedence) ===`;
      const ragBody = clip(ragText, ragBudget - ragHeader.length - 10);

      return `${okfHeader}\n${okfBody}${ragHeader}\n${ragBody}`;
    }

    return clip(ragText || "", budget);
  }

  async function routeContext({
    query = "",
    spec = {},
    registry = null,
    ragResult = null,
    budget = defaultBudget,
  }) {
    const t0 = Date.now();
    const classification = classifyQuery({ query, spec, registry });
    let effectiveRoute = classification.route;
    let okfDoc = null;
    let fallback = null;

    let provenance = null;

    // Load OKF doc if needed via ALS if available
    if (effectiveRoute === "okf" || effectiveRoute === "mixed") {
      let resolvedDoc = null;
      if (registry && registry.als && typeof registry.als.resolve === "function") {
        const alsRes = registry.als.resolve({
          type: "auto",
          value: classification.matched_doc_ids[0] || query,
        });
        if (alsRes.status === "resolved") {
          if (alsRes.document) {
            resolvedDoc = alsRes.document;
          } else if (alsRes.feature) {
            const curVer = alsRes.currentApproved;
            const specLines = curVer?.spec
              ? Object.entries(curVer.spec)
                  .map(([k, v]) => `• ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
                  .join("\n")
              : "";
            resolvedDoc = {
              id: alsRes.feature.feature_id,
              title: alsRes.feature.canonical_name,
              version: curVer?.version || "1.0.0",
              status: curVer?.approval_status || alsRes.feature.approval_status,
              path: `registry/feature_registry.yaml#${alsRes.feature.feature_id}`,
              body: `${alsRes.feature.description || alsRes.feature.canonical_name}\n\n${specLines}`.trim(),
            };
          }
          provenance = alsRes.provenance;
        } else if (alsRes.status === "no_authoritative_version") {
          fallback = "okf_no_authoritative_version";
        }
      } else if (registry && typeof registry.getDocument === "function") {
        const targetId = classification.matched_doc_ids[0];
        if (targetId) resolvedDoc = registry.getDocument(targetId);
      }

      okfDoc = resolvedDoc;

      // If OKF read failed or doc not found
      if (!okfDoc && effectiveRoute === "okf") {
        if (ragResult && ragResult.text) {
          effectiveRoute = "rag";
          fallback = fallback || "okf_doc_unavailable_fallback_to_rag";
        } else {
          fallback = fallback || "okf_doc_unavailable_no_rag";
        }
      }
    }

    const ragText = ragResult?.text || "";
    const passages = assemblePassages({
      route: effectiveRoute,
      okfDoc,
      ragText,
      budget,
    });

    const files = [];
    if (okfDoc && (effectiveRoute === "okf" || effectiveRoute === "mixed")) {
      files.push(okfDoc.path);
    }
    if (ragResult && ragResult.used && (effectiveRoute === "rag" || effectiveRoute === "mixed")) {
      for (const u of ragResult.used) {
        if (u.file && !files.includes(u.file)) files.push(u.file);
      }
    }

    return {
      route: effectiveRoute,
      originalRoute: classification.route,
      classification,
      passages,
      files,
      fallback,
      okfDocId: okfDoc?.id || null,
      provenance,
      latencyMs: Date.now() - t0,
    };
  }

  return {
    classifyQuery,
    assemblePassages,
    routeContext,
    classifyTemporalIntent,
    extractTemporalParameters,
  };
}

module.exports = {
  createOkfRouter,
  createTemporalRouter,
  classifyTemporalIntent,
  extractTemporalParameters,
  resolveEvidence,
  normalizeEvidence,
  detectConflicts,
  buildProvenance,
  formatEvidenceForContext,
  resolvePrecedence,
  CANONICAL_INTENT,
  EXPLORATORY_INTENT,
  CLASSIFIER_VERSION,
};
