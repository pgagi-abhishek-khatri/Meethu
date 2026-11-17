// src/copilot/core/okf/featureRegistryValidator.js
// Pure, Electron-free validator for the Canonical Feature Registry.
// Validates schema conformance, identity uniqueness, SemVer strings,
// authority states, source provenance, and acyclic supersession lineages.

const { parseSemVer } = require("./versionResolver");

const VALID_APPROVAL_STATUSES = new Set(["draft", "pending", "approved", "rejected"]);
const VALID_LIFECYCLE_STATUSES = new Set(["active", "superseded", "deprecated"]);
const VALID_IMPLEMENTATION_STATUSES = new Set(["planned", "in_progress", "implemented", "verified"]);
const FEATURE_ID_REGEX = /^feat:[a-z0-9_:-]+$/;

/**
 * Validates a loaded Feature Registry data structure.
 *
 * @param {Object} data - Parsed feature registry object from YAML/JSON
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
function validateFeatureRegistry(data) {
  const errors = [];
  const warnings = [];

  if (!data || typeof data !== "object") {
    return {
      valid: false,
      errors: ["Feature registry root must be an object"],
      warnings: [],
    };
  }

  // Root validation
  if (!data.schema_version || typeof data.schema_version !== "string") {
    errors.push("Missing or invalid 'schema_version' (must be SemVer string)");
  } else if (!parseSemVer(data.schema_version)) {
    errors.push(`Invalid 'schema_version' SemVer format: '${data.schema_version}'`);
  }

  if (!data.bundle_id || typeof data.bundle_id !== "string") {
    errors.push("Missing or invalid 'bundle_id' (must be a non-empty string)");
  }

  if (!Array.isArray(data.features)) {
    errors.push("Missing or invalid 'features' (must be an array of feature objects)");
    return { valid: errors.length === 0, errors, warnings };
  }

  const seenFeatureIds = new Set();

  data.features.forEach((feat, index) => {
    const loc = `features[${index}]`;

    // 1. Feature Identity & ID
    if (!feat.feature_id || typeof feat.feature_id !== "string") {
      errors.push(`${loc}: Missing required 'feature_id'`);
      return;
    }

    if (!FEATURE_ID_REGEX.test(feat.feature_id)) {
      errors.push(
        `${loc}: Invalid 'feature_id' format '${feat.feature_id}'. Must match pattern '^feat:[a-z0-9_:-]+$'`
      );
    }

    const normId = feat.feature_id.toLowerCase();
    if (seenFeatureIds.has(normId)) {
      errors.push(`${loc}: Duplicate feature_id detected: '${feat.feature_id}'`);
    }
    seenFeatureIds.add(normId);

    // 2. Canonical Name
    if (!feat.canonical_name || typeof feat.canonical_name !== "string" || feat.canonical_name.trim().length < 3) {
      errors.push(`${loc} (${feat.feature_id}): Missing or invalid 'canonical_name' (minimum 3 characters)`);
    }

    // 3. Domain
    if (!feat.domain || typeof feat.domain !== "string") {
      errors.push(`${loc} (${feat.feature_id}): Missing required 'domain'`);
    }

    // 4. Aliases
    if (!Array.isArray(feat.aliases)) {
      errors.push(`${loc} (${feat.feature_id}): 'aliases' must be an array of strings`);
    } else {
      const aliasSet = new Set();
      feat.aliases.forEach((alias, aIdx) => {
        if (typeof alias !== "string" || alias.trim().length === 0) {
          errors.push(`${loc} (${feat.feature_id}): aliases[${aIdx}] must be a non-empty string`);
        } else {
          const normAlias = alias.trim().toLowerCase();
          if (aliasSet.has(normAlias)) {
            warnings.push(`${loc} (${feat.feature_id}): Duplicate alias '${alias}' within feature`);
          }
          aliasSet.add(normAlias);
        }
      });
    }

    // 5. Keywords
    if (!Array.isArray(feat.keywords)) {
      errors.push(`${loc} (${feat.feature_id}): 'keywords' must be an array of strings`);
    } else {
      feat.keywords.forEach((kw, kIdx) => {
        if (typeof kw !== "string" || kw.trim().length === 0) {
          errors.push(`${loc} (${feat.feature_id}): keywords[${kIdx}] must be a non-empty string`);
        }
      });
    }

    // 6. Approval & Lifecycle Status
    if (!VALID_APPROVAL_STATUSES.has(feat.approval_status)) {
      errors.push(
        `${loc} (${feat.feature_id}): Invalid 'approval_status' '${feat.approval_status}'. Allowed: ${Array.from(VALID_APPROVAL_STATUSES).join(", ")}`
      );
    }

    if (!VALID_LIFECYCLE_STATUSES.has(feat.lifecycle_status)) {
      errors.push(
        `${loc} (${feat.feature_id}): Invalid 'lifecycle_status' '${feat.lifecycle_status}'. Allowed: ${Array.from(VALID_LIFECYCLE_STATUSES).join(", ")}`
      );
    }

    if (feat.implementation_status && !VALID_IMPLEMENTATION_STATUSES.has(feat.implementation_status)) {
      errors.push(
        `${loc} (${feat.feature_id}): Invalid 'implementation_status' '${feat.implementation_status}'. Allowed: ${Array.from(VALID_IMPLEMENTATION_STATUSES).join(", ")}`
      );
    }

    // 7. Sources provenance validation helper
    const validateSources = (sources, pathLabel) => {
      if (!Array.isArray(sources) || sources.length === 0) {
        return false;
      }
      sources.forEach((src, sIdx) => {
        if (!src || typeof src !== "object") {
          errors.push(`${pathLabel}[${sIdx}]: Source entry must be an object`);
        } else {
          if (!src.document_id || typeof src.document_id !== "string") {
            errors.push(`${pathLabel}[${sIdx}]: Missing required 'document_id' in source provenance`);
          }
          if (!src.document_name || typeof src.document_name !== "string") {
            errors.push(`${pathLabel}[${sIdx}]: Missing required 'document_name' in source provenance`);
          }
        }
      });
      return true;
    };

    if (feat.approval_status === "approved" && feat.lifecycle_status === "active") {
      const hasTopSources = validateSources(feat.sources, `${loc} (${feat.feature_id}).sources`);
      if (!hasTopSources && (!Array.isArray(feat.versions) || feat.versions.length === 0)) {
        errors.push(`${loc} (${feat.feature_id}): Active approved feature must specify source provenance`);
      }
    }

    // 8. Versions and Lineage Validation
    if (feat.versions) {
      if (!Array.isArray(feat.versions)) {
        errors.push(`${loc} (${feat.feature_id}): 'versions' must be an array`);
      } else {
        const versionMap = new Map();
        let activeApprovedCount = 0;

        feat.versions.forEach((verObj, vIdx) => {
          const vLoc = `${loc} (${feat.feature_id}).versions[${vIdx}]`;

          if (!verObj.version || typeof verObj.version !== "string") {
            errors.push(`${vLoc}: Missing 'version' identifier`);
            return;
          }

          if (!parseSemVer(verObj.version)) {
            errors.push(`${vLoc}: Version '${verObj.version}' is not valid SemVer (MAJOR.MINOR.PATCH)`);
          }

          if (versionMap.has(verObj.version)) {
            errors.push(`${vLoc}: Duplicate version identifier '${verObj.version}' within feature`);
          }
          versionMap.set(verObj.version, verObj);

          if (!VALID_APPROVAL_STATUSES.has(verObj.approval_status)) {
            errors.push(
              `${vLoc}: Invalid approval_status '${verObj.approval_status}' on version ${verObj.version}`
            );
          }

          if (!VALID_LIFECYCLE_STATUSES.has(verObj.lifecycle_status)) {
            errors.push(
              `${vLoc}: Invalid lifecycle_status '${verObj.lifecycle_status}' on version ${verObj.version}`
            );
          }

          // Count active approved versions
          if (verObj.approval_status === "approved" && verObj.lifecycle_status === "active") {
            activeApprovedCount++;
          }

          // Approved versions require source provenance
          if (verObj.approval_status === "approved") {
            const hasVerSources = validateSources(verObj.sources, `${vLoc}.sources`);
            if (!hasVerSources && !feat.sources) {
              errors.push(
                `${vLoc}: Approved version '${verObj.version}' must specify source document provenance`
              );
            }
          }
        });

        // Rule: Multiple active approved versions are forbidden
        if (activeApprovedCount > 1) {
          errors.push(
            `${loc} (${feat.feature_id}): Multiple active approved versions detected (${activeApprovedCount}). At most 1 active approved version allowed.`
          );
        }

        // Validate Current Approved Version pointer
        if (feat.current_approved_version) {
          if (!parseSemVer(feat.current_approved_version)) {
            errors.push(
              `${loc} (${feat.feature_id}): current_approved_version '${feat.current_approved_version}' is not valid SemVer`
            );
          } else if (!versionMap.has(feat.current_approved_version)) {
            errors.push(
              `${loc} (${feat.feature_id}): current_approved_version '${feat.current_approved_version}' does not exist in registered versions`
            );
          } else {
            const currentVer = versionMap.get(feat.current_approved_version);
            if (currentVer.approval_status !== "approved") {
              errors.push(
                `${loc} (${feat.feature_id}): current_approved_version '${feat.current_approved_version}' must have approval_status 'approved', but found '${currentVer.approval_status}'`
              );
            }
            if (currentVer.lifecycle_status !== "active" && feat.lifecycle_status !== "deprecated") {
              errors.push(
                `${loc} (${feat.feature_id}): current_approved_version '${feat.current_approved_version}' must have lifecycle_status 'active', but found '${currentVer.lifecycle_status}'`
              );
            }
          }
        } else if (activeApprovedCount === 1) {
          errors.push(
            `${loc} (${feat.feature_id}): Missing 'current_approved_version' reference when an active approved version exists`
          );
        }

        // Validate Supersession Graph (lineage consistency and circularity checks)
        const graph = new Map(); // version -> Set of versions it is superseded by

        for (const [vStr, verObj] of versionMap) {
          if (!graph.has(vStr)) graph.set(vStr, new Set());

          const supersededBy = verObj.supersession?.superseded_by || [];
          const supersedes = verObj.supersession?.supersedes || [];

          for (const target of supersededBy) {
            // Check if target is a version within this feature
            if (parseSemVer(target)) {
              if (!versionMap.has(target)) {
                errors.push(
                  `${loc} (${feat.feature_id}): Version '${vStr}' references non-existent successor '${target}' in superseded_by`
                );
              } else {
                graph.get(vStr).add(target);
              }
            }
          }

          for (const target of supersedes) {
            if (parseSemVer(target)) {
              if (!versionMap.has(target)) {
                errors.push(
                  `${loc} (${feat.feature_id}): Version '${vStr}' references non-existent predecessor '${target}' in supersedes`
                );
              }
            }
          }
        }

        // Circularity check using DFS
        const visited = new Set();
        const recursionStack = new Set();

        function checkCycle(node, path) {
          visited.add(node);
          recursionStack.add(node);

          const neighbors = graph.get(node) || new Set();
          for (const neighbor of neighbors) {
            if (!visited.has(neighbor)) {
              if (checkCycle(neighbor, [...path, neighbor])) return true;
            } else if (recursionStack.has(neighbor)) {
              errors.push(
                `${loc} (${feat.feature_id}): Circular supersession detected in version lineage: ${[...path, neighbor].join(" -> ")}`
              );
              return true;
            }
          }

          recursionStack.delete(node);
          return false;
        }

        for (const vStr of versionMap.keys()) {
          if (!visited.has(vStr)) {
            checkCycle(vStr, [vStr]);
          }
        }
      }
    }
  });

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

module.exports = {
  validateFeatureRegistry,
  VALID_APPROVAL_STATUSES,
  VALID_LIFECYCLE_STATUSES,
  VALID_IMPLEMENTATION_STATUSES,
};
