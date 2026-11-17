// src/copilot/core/okf/versionResolver.js
// Pure, Electron-free SemVer and status precedence resolution engine for canonical documents.

const SEMVER_REGEX = /^[0-9]+\.[0-9]+\.[0-9]+$/;

function parseSemVer(v) {
  if (typeof v !== "string" || !SEMVER_REGEX.test(v.trim())) {
    return null;
  }
  const [major, minor, patch] = v.trim().split(".").map(Number);
  return { major, minor, patch, raw: v.trim() };
}

function compareSemVer(v1, v2) {
  const p1 = typeof v1 === "string" ? parseSemVer(v1) : v1;
  const p2 = typeof v2 === "string" ? parseSemVer(v2) : v2;

  if (!p1 || !p2) {
    throw new Error(`Invalid SemVer comparison: '${v1}' vs '${v2}'`);
  }

  if (p1.major !== p2.major) return p1.major - p2.major;
  if (p1.minor !== p2.minor) return p1.minor - p2.minor;
  return p1.patch - p2.patch;
}

/**
 * Resolves the winning document record from a set of candidates according to
 * explicit version and status precedence rules.
 *
 * Status Priority Hierarchy:
 * 1. 'approved' (always highest priority unless another status is explicitly pinned)
 * 2. 'draft' (only eligible if allowDraft: true or requestedVersion matches)
 * 3. 'deprecated' (only eligible if allowDeprecated: true or requestedVersion matches)
 * 4. 'superseded' (redirects to superseded_by pointer unless historical pin requested)
 *
 * @param {Array<Object>} candidates - List of candidate document records with version, status, id, etc.
 * @param {Object} options - Resolution options
 * @param {string|null} [options.requestedVersion] - Explicit version pin (e.g. "1.0.0")
 * @param {boolean} [options.allowDraft=false] - Whether draft versions can be resolved
 * @param {boolean} [options.allowDeprecated=false] - Whether deprecated versions can be resolved
 * @returns {Object} Resolution result: { status, resolvedRecord, reason, supersededTo }
 */
function resolvePrecedence(
  candidates = [],
  { requestedVersion = null, allowDraft = false, allowDeprecated = false } = {}
) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return {
      status: "not_found",
      resolvedRecord: null,
      reason: "No candidate records provided",
    };
  }

  // 1. Explicit Version Requested (Pinning)
  if (requestedVersion) {
    const sem = parseSemVer(requestedVersion);
    if (!sem) {
      return {
        status: "invalid_query",
        resolvedRecord: null,
        reason: `Requested version '${requestedVersion}' is not valid SemVer`,
      };
    }

    const matches = candidates.filter((c) => c.version === requestedVersion);
    if (matches.length === 0) {
      return {
        status: "version_not_found",
        resolvedRecord: null,
        reason: `Requested version '${requestedVersion}' does not exist among candidates`,
      };
    }

    if (matches.length > 1) {
      // Check if duplicate versions exist with same status
      const approvedCount = matches.filter((m) => m.status === "approved").length;
      if (approvedCount > 1) {
        return {
          status: "ambiguous",
          resolvedRecord: null,
          reason: `Multiple duplicate '${requestedVersion}' records with approved status`,
        };
      }
    }

    // Return the pinned version (honours explicit draft/deprecated pin)
    const winningMatch = matches.find((m) => m.status === "approved") || matches[0];
    return {
      status: "resolved",
      resolvedRecord: winningMatch,
      reason: `Explicit version pin '${requestedVersion}' resolved`,
    };
  }

  // 2. Default Resolution (No Version Specified)
  // Check for superseded documents first if all candidates are superseded
  const allSuperseded = candidates.every((c) => c.status === "superseded");
  if (allSuperseded) {
    const newestSuperseded = [...candidates].sort((a, b) => compareSemVer(b.version, a.version))[0];
    return {
      status: "superseded",
      resolvedRecord: newestSuperseded,
      supersededTo: newestSuperseded.superseded_by || null,
      reason: `Document is superseded; redirects to ${newestSuperseded.superseded_by || "successor"}`,
    };
  }

  // Filter candidates by status eligibility
  const approved = candidates.filter((c) => c.status === "approved");
  if (approved.length > 0) {
    // Sort by SemVer descending
    const sorted = [...approved].sort((a, b) => compareSemVer(b.version, a.version));
    
    // Check for duplicate versions with approved status
    if (sorted.length > 1 && compareSemVer(sorted[0].version, sorted[1].version) === 0) {
      return {
        status: "ambiguous",
        resolvedRecord: null,
        reason: `Duplicate approved records share the highest version '${sorted[0].version}'`,
      };
    }

    return {
      status: "resolved",
      resolvedRecord: sorted[0],
      reason: `Highest approved version '${sorted[0].version}' resolved`,
    };
  }

  // If no approved version, check if draft is explicitly allowed
  if (allowDraft) {
    const drafts = candidates.filter((c) => c.status === "draft");
    if (drafts.length > 0) {
      const sorted = [...drafts].sort((a, b) => compareSemVer(b.version, a.version));
      return {
        status: "resolved",
        resolvedRecord: sorted[0],
        reason: `Highest draft version '${sorted[0].version}' resolved (allowDraft=true)`,
      };
    }
  }

  // If no approved version, check if deprecated is explicitly allowed
  if (allowDeprecated) {
    const deprecated = candidates.filter((c) => c.status === "deprecated");
    if (deprecated.length > 0) {
      const sorted = [...deprecated].sort((a, b) => compareSemVer(b.version, a.version));
      return {
        status: "resolved",
        resolvedRecord: sorted[0],
        reason: `Highest deprecated version '${sorted[0].version}' resolved (allowDeprecated=true)`,
      };
    }
  }

  // No authoritative version available
  return {
    status: "no_authoritative_version",
    resolvedRecord: null,
    reason: "Candidates exist but none have 'approved' status and draft/deprecated are disallowed",
  };
}

module.exports = {
  parseSemVer,
  compareSemVer,
  resolvePrecedence,
};
