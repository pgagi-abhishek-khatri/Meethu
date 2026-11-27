// Builds meeting vocabulary & spoken-name glossary mapping casual speech and ASR variants
// to real features, files, routes, translations, and symbols.
const path = require("path");

const NOISY_BASENAMES = new Set(["index", "layout", "page", "route", "types", "constants", "utils", "helpers", "styles"]);

const ASR_REPLACEMENTS = [
  [/\bauth\b/g, "authentication"],
  [/\bcfg\b/g, "config"],
  [/\bdb\b/g, "database"],
  [/\bws\b/g, "websocket"],
  [/\bipc\b/g, "inter-process"],
  [/\bui\b/g, "interface"],
  [/\bapi\b/g, "endpoint"],
  [/\bsignin\b/g, "sign in"],
  [/\bsignup\b/g, "sign up"],
];

function splitCamelAndSnake(name) {
  return String(name || "")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[[()\]]/g, " ")
    .replace(/^[+_]+/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function deriveMishearings(spoken) {
  const variants = new Set();
  for (const [re, rep] of ASR_REPLACEMENTS) {
    if (re.test(spoken)) {
      re.lastIndex = 0;
      variants.add(spoken.replace(re, rep));
    }
  }
  if (spoken.includes(" ")) variants.add(spoken.replace(/\s+/g, "-"));
  return [...variants].filter((v) => v !== spoken).slice(0, 4);
}

function isNoisyGlossaryKey(key, rawTarget) {
  if (!key || key.length < 3 || key.length > 48) return true;
  if (/^\(|\)|\[|\]/.test(key)) return true;
  if (/\b(?:test|spec|mock|fixture)\b/i.test(key) || /\.(?:test|spec)\./i.test(rawTarget || "")) return true;
  if (NOISY_BASENAMES.has(key)) return true;
  return false;
}

function buildGlossary({
  features = [],
  modules = [],
  contracts = [],
  docFacts = [],
  translationFiles = [],
  manualAliases = null,
} = {}) {
  const entries = new Map(); // spokenKey -> { spoken, targetType, target, featureId, mishearings: [], source }

  const add = (spoken, targetType, target, featureId = "", source = "derived", extraMishearings = []) => {
    const clean = String(spoken || "").replace(/\s+/g, " ").trim();
    const key = clean.toLowerCase();
    if (source !== "manual" && isNoisyGlossaryKey(key, target)) return;
    if (!clean || clean.length < 3) return;
    if (entries.has(key) && entries.get(key).source === "manual") return;
    const autoMishear = deriveMishearings(key);
    entries.set(key, {
      spoken: clean,
      targetType,
      target,
      featureId,
      mishearings: [...new Set([...extraMishearings, ...autoMishear])].slice(0, 4),
      source,
    });
  };

  // 1. User-defined aliases (highest priority)
  if (manualAliases && typeof manualAliases === "object") {
    for (const [spoken, def] of Object.entries(manualAliases)) {
      if (typeof def === "string") {
        add(spoken, "file", def, "", "manual");
      } else if (def && typeof def === "object") {
        add(spoken, def.type || "feature", def.target || "", def.feature || "", "manual", def.mishearings || []);
      }
    }
  }

  // 2. From domain feature names
  for (const f of features) {
    const topFile = f.primary?.[0]?.relPath || f.files?.[0]?.relPath || "";
    if (!topFile) continue;
    add(f.name.toLowerCase(), "feature", topFile, f.id, "derived");
  }

  // 3. From HTTP / IPC routes (clean spoken phrases without route param noise)
  for (const c of contracts) {
    const spoken = c.path
      .replace(/\{[^}]+\}/g, " ")
      .replace(/[:/{}-]+/g, " ")
      .replace(/\b(?:api|v\d+)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    if (spoken.length >= 4) add(spoken, "contract", `${c.handlerFile}:L${c.handlerLine}`, "", "derived");
  }

  // 4. From translation i18n top-level sections/UI labels
  for (const tr of translationFiles) {
    for (const prefix of tr.topPrefixes || []) {
      const spoken = splitCamelAndSnake(prefix);
      if (spoken.length >= 4) add(spoken, "translation", tr.relPath, "", "derived");
    }
  }

  // 5. From UI screens, routes, services, and state stores (skipping bracketed/test noise)
  for (const mod of modules) {
    const role = mod.structure?.role || "";
    if (!["UI component", "route/page", "service/API client", "state store"].includes(role)) continue;
    if (/[[()\]]/.test(mod.relPath)) continue;
    const base = path.basename(mod.relPath, path.extname(mod.relPath));
    const spoken = splitCamelAndSnake(base);
    add(spoken, "file", mod.relPath, "", "derived");
  }

  // 6. From Tier-1/Tier-2 priority docs
  for (const d of docFacts) {
    if (d.isPriority && !d.excludeFromRules && d.title) add(d.title, "doc", d.relPath, "", "derived");
  }

  return [...entries.values()].sort((a, b) => (a.source === "manual" ? -1 : 0) - (b.source === "manual" ? -1 : 0) || a.spoken.localeCompare(b.spoken)).slice(0, 120);
}

module.exports = {
  splitCamelAndSnake,
  buildGlossary,
};
