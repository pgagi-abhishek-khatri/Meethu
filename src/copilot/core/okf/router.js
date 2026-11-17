// src/copilot/core/okf/router.js
// Pure, Electron-free OKF Router Gate.
// Classifies queries into 'okf', 'rag', or 'mixed' and formats passages with deterministic precedence.

const CANONICAL_INTENT =
  /\b(official|approved|contract|standard|policy|formula|rule|architecture|invariant|spec|specification|canonical|okf-[0-9]{4})\b/i;

const EXPLORATORY_INTENT =
  /\b(discuss|discussed|meeting|notes|talked about|who said|what did we say|history|previous|agenda|proposal|draft|timeline)\b/i;

const CLASSIFIER_VERSION = "1.0.0";

const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s || "");

function createOkfRouter({ defaultBudget = 2800 } = {}) {
  function classifyQuery({ query = "", spec = {}, registry = null }) {
    const q = String(query || "").trim();
    const signals = [];

    const isCanonical = CANONICAL_INTENT.test(q);
    const isExploratory = EXPLORATORY_INTENT.test(q);

    if (isCanonical) signals.push("intent:canonical");
    if (isExploratory) signals.push("intent:exploratory");

    // Match entities against registry
    const matches = registry && typeof registry.lookup === "function" ? registry.lookup(q) : [];
    const approvedMatches = matches.filter((m) => m.status === "approved");
    const matchedDocIds = approvedMatches.map((m) => m.id);

    for (const id of matchedDocIds) {
      signals.push(`entity:${id}`);
    }

    // Direct OKF ID mention (e.g. OKF-0002)
    if (/\bokf-[0-9]{4}\b/i.test(q) && matchedDocIds.length > 0) {
      if (isExploratory) {
        return {
          route: "mixed",
          confidence: 0.95,
          reason: `Explicit OKF ID with exploratory cues: ${matchedDocIds.join(", ")}`,
          matched_signals: signals,
          matched_doc_ids: matchedDocIds,
          classifier_version: CLASSIFIER_VERSION,
        };
      }
      return {
        route: "okf",
        confidence: 1.0,
        reason: `Explicit OKF ID requested: ${matchedDocIds.join(", ")}`,
        matched_signals: signals,
        matched_doc_ids: matchedDocIds,
        classifier_version: CLASSIFIER_VERSION,
      };
    }

    // Entity match + Canonical intent
    if (matchedDocIds.length > 0 && isCanonical && !isExploratory) {
      return {
        route: "okf",
        confidence: 0.95,
        reason: `Canonical intent matching approved entity: ${matchedDocIds.join(", ")}`,
        matched_signals: signals,
        matched_doc_ids: matchedDocIds,
        classifier_version: CLASSIFIER_VERSION,
      };
    }

    // Entity match + Exploratory intent -> Mixed
    if (matchedDocIds.length > 0 && isExploratory) {
      return {
        route: "mixed",
        confidence: 0.9,
        reason: `Mixed query: official entity ${matchedDocIds.join(", ")} alongside exploratory discussion cues`,
        matched_signals: signals,
        matched_doc_ids: matchedDocIds,
        classifier_version: CLASSIFIER_VERSION,
      };
    }

    // Entity match without explicit cues -> okf if exact title, else mixed if files asked
    if (matchedDocIds.length > 0) {
      const topMatch = approvedMatches[0];
      if (topMatch.matchReason === "exact_id" || topMatch.matchReason === "title_match") {
        return {
          route: "okf",
          confidence: 0.85,
          reason: `Strong entity title/ID match: ${topMatch.id}`,
          matched_signals: signals,
          matched_doc_ids: matchedDocIds,
          classifier_version: CLASSIFIER_VERSION,
        };
      }
    }

    // Canonical cue but no registered entity match
    if (isCanonical && !isExploratory) {
      return {
        route: "mixed",
        confidence: 0.7,
        reason: "Canonical query intent without direct OKF entity match; fallback to hybrid",
        matched_signals: signals,
        matched_doc_ids: matchedDocIds,
        classifier_version: CLASSIFIER_VERSION,
      };
    }

    // Exploratory cue without canonical intent
    if (isExploratory) {
      return {
        route: "rag",
        confidence: 0.95,
        reason: "Exploratory / meeting memory query intent",
        matched_signals: signals,
        matched_doc_ids: matchedDocIds,
        classifier_version: CLASSIFIER_VERSION,
      };
    }

    // Standard D1 project search request
    if (spec.project || spec.projectAuto) {
      return {
        route: "rag",
        confidence: 0.8,
        reason: "Standard project file search triggered by decider",
        matched_signals: signals,
        matched_doc_ids: matchedDocIds,
        classifier_version: CLASSIFIER_VERSION,
      };
    }

    // Ambiguous query default
    return {
      route: "rag",
      confidence: 0.5,
      reason: "Ambiguous query without strong canonical cues; default to RAG lane",
      matched_signals: signals,
      matched_doc_ids: matchedDocIds,
      classifier_version: CLASSIFIER_VERSION,
    };
  }

  function assemblePassages({ route, okfDoc = null, ragText = "", budget = defaultBudget }) {
    if (route === "okf") {
      if (!okfDoc || !okfDoc.body) return "";
      const header = `[CANONICAL SPECIFICATION: ${okfDoc.id} · ${okfDoc.title} (v${okfDoc.version}, ${okfDoc.status})]`;
      const body = clip(okfDoc.body, budget - header.length - 10);
      return `${header}\n${body}`;
    }

    if (route === "rag") {
      return clip(ragText || "", budget);
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
          resolvedDoc = alsRes.document;
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
  };
}

module.exports = {
  createOkfRouter,
  CANONICAL_INTENT,
  EXPLORATORY_INTENT,
  CLASSIFIER_VERSION,
};
