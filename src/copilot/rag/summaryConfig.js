// Loads optional .meethu-summary.yaml / .json configuration and features/aliases overrides.
const fs = require("fs");
const path = require("path");

const DEFAULT_CONFIG = {
  roots: [],
  include: [],
  exclude: [],
  secret_patterns_extra: [],
  budgets: {
    router_target: 2800, // Tier 0 router card target (2-3k ideal)
    router_hard_cap: 5000, // Tier 0 hard cap — build fails if real tokenizer count exceeds this
    tier1_max_per_card: 1500, // Tier 1 per-feature card cap (400-1500t)
    index: 8000, // Legacy Layer A token cap (4-10k target)
    features: 10000,
    contracts: 15000,
    files_per_component: 40000,
    symbols: 12000,
    docs: 8000,
    config: 6000,
    data: 6000,
  },
  output: {
    mode: "tiered", // "tiered" | "single"
    dir: null,
    json_twins: true,
  },
  features_override: "features.yaml",
  aliases: "aliases.yaml",
  summaries: {
    model: false, // opt-in only (§8.2 & §12)
  },
  priority_overrides: [],
};

// Minimal deterministic YAML subset parser (handles flat/nested maps, inline arrays [a, b], and bullet lists).
function parseSimpleYaml(text) {
  const result = {};
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const stack = [{ indent: -1, obj: result, key: null }];

  const parseScalar = (val) => {
    const v = val.trim();
    if (!v || v === "null" || v === "~") return null;
    if (v === "true") return true;
    if (v === "false") return false;
    if (/^-?\d+(?:\.\d+)?$/.test(v)) return Number(v);
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
    if (v.startsWith("[") && v.endsWith("]")) {
      return v
        .slice(1, -1)
        .split(",")
        .map((x) => parseScalar(x))
        .filter((x) => x !== null && x !== "");
    }
    if (v.startsWith("{") && v.endsWith("}")) {
      const obj = {};
      for (const pair of v.slice(1, -1).split(",")) {
        const idx = pair.indexOf(":");
        if (idx > 0) obj[pair.slice(0, idx).trim()] = parseScalar(pair.slice(idx + 1));
      }
      return obj;
    }
    return v;
  };

  for (const raw of lines) {
    const clean = raw.replace(/\s+#.*$/, "");
    if (!clean.trim() || clean.trim().startsWith("#")) continue;
    const indent = clean.search(/\S/);

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    const trimmed = clean.trim();

    if (trimmed.startsWith("- ")) {
      const itemVal = parseScalar(trimmed.slice(2));
      if (Array.isArray(parent.obj)) {
        parent.obj.push(itemVal);
      } else if (!Array.isArray(parent.obj) && stack.length > 1 && Object.keys(parent.obj).length === 0) {
        // Convert empty nested map to array when first child is a YAML bullet (`key:\n  - val`)
        const holder = stack[stack.length - 2];
        const arr = [itemVal];
        holder.obj[parent.key] = arr;
        stack[stack.length - 1].obj = arr;
      } else if (parent.lastKey) {
        if (!Array.isArray(parent.obj[parent.lastKey])) parent.obj[parent.lastKey] = [];
        parent.obj[parent.lastKey].push(itemVal);
      }
      continue;
    }

    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim().replace(/^['"]|['"]$/g, "");
    const rest = trimmed.slice(colon + 1).trim();

    if (!rest) {
      const child = {};
      parent.obj[key] = child;
      parent.lastKey = key;
      stack.push({ indent, obj: child, key });
    } else {
      parent.obj[key] = parseScalar(rest);
      parent.lastKey = key;
    }
  }
  return result;
}

function loadStructuredFile(absPath) {
  if (!absPath || !fs.existsSync(absPath)) return null;
  try {
    const text = fs.readFileSync(absPath, "utf8");
    if (absPath.endsWith(".json")) return JSON.parse(text);
    return parseSimpleYaml(text);
  } catch {
    return null;
  }
}

function loadSummaryConfig(rootDir) {
  const absRoot = path.resolve(String(rootDir || ""));
  let userCfg = {};
  for (const candidate of [
    ".meethu-summary.json",
    ".meethu-summary.yaml",
    ".meethu-summary.yml",
    ".copilot-summary.json",
    ".copilot-summary.yaml",
  ]) {
    const parsed = loadStructuredFile(path.join(absRoot, candidate));
    if (parsed && typeof parsed === "object") {
      userCfg = parsed;
      break;
    }
  }

  const merged = {
    ...DEFAULT_CONFIG,
    ...userCfg,
    budgets: { ...DEFAULT_CONFIG.budgets, ...(userCfg.budgets || {}) },
    output: { ...DEFAULT_CONFIG.output, ...(userCfg.output || {}) },
    summaries: { ...DEFAULT_CONFIG.summaries, ...(userCfg.summaries || {}) },
  };

  const resolveAux = (relOrName, altJson) => {
    if (!relOrName) return null;
    const p1 = path.isAbsolute(relOrName) ? relOrName : path.join(absRoot, relOrName);
    const d1 = loadStructuredFile(p1);
    if (d1) return d1;
    if (altJson) return loadStructuredFile(path.join(absRoot, altJson));
    return null;
  };

  const featuresOverride = resolveAux(merged.features_override, "features.json");
  const aliasesOverride = resolveAux(merged.aliases, "aliases.json");

  return {
    config: merged,
    featuresOverride,
    aliasesOverride,
  };
}

module.exports = {
  DEFAULT_CONFIG,
  parseSimpleYaml,
  loadStructuredFile,
  loadSummaryConfig,
};
