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
  models = [],
  manualAliases = null,
} = {}) {
  const entries = new Map(); // spokenKey -> { spoken, targetType, target, fid, featureId, mishearings: [], source }

  const fileToFid = new Map();
  for (const f of features) {
    const fKey = f.fid || f.id || "";
    for (const pf of f.files || []) {
      if (pf.relPath && !fileToFid.has(pf.relPath)) fileToFid.set(pf.relPath, fKey);
    }
  }

  const resolveFid = (target, fallbackId = "") => {
    const cleanFile = String(target || "").replace(/:L\d+.*$/, "");
    return fileToFid.get(cleanFile) || fallbackId || "";
  };

  const add = (spoken, targetType, target, featureId = "", source = "derived", extraMishearings = []) => {
    const clean = String(spoken || "").replace(/\s+/g, " ").trim();
    const key = clean.toLowerCase();
    if (source !== "manual" && isNoisyGlossaryKey(key, target)) return;
    // V2 §5.1 #8: never emit entries that merely restate a filename (unless manual)
    if (source !== "manual" && targetType === "file") return;
    if (!clean || clean.length < 3) return;
    if (entries.has(key) && entries.get(key).source === "manual") return;
    const autoMishear = deriveMishearings(key);
    const fid = resolveFid(target, featureId);
    entries.set(key, {
      spoken: clean,
      targetType,
      target,
      fid,
      featureId: fid || featureId,
      mishearings: [...new Set([...extraMishearings, ...autoMishear])].slice(0, 4),
      source,
    });
  };

  // 1. User-defined aliases (highest priority)
  if (manualAliases && typeof manualAliases === "object") {
    for (const [spoken, def] of Object.entries(manualAliases)) {
      if (typeof def === "string") {
        add(spoken, "feature", def, "", "manual");
      } else if (def && typeof def === "object") {
        add(spoken, def.type || "feature", def.target || "", def.feature || "", "manual", def.mishearings || []);
      }
    }
  }

  // 2. From domain feature names & abbreviations
  for (const f of features) {
    const topFile = f.primary?.[0]?.relPath || f.files?.[0]?.relPath || "";
    if (!topFile) continue;
    add(f.name, "feature", f.fid || f.id, f.fid || f.id, "derived");
  }

  // 3. From HTTP / IPC routes (clean spoken phrases mapped to Fid + contract)
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

  // 4. From translation i18n top-level sections/UI domain labels
  for (const tr of translationFiles) {
    for (const prefix of tr.topPrefixes || []) {
      const spoken = splitCamelAndSnake(prefix);
      if (spoken.length >= 4) add(spoken, "translation", tr.relPath, "", "derived");
    }
  }

  // 5. From schema / data model names (domain entities, not UI filenames)
  for (const m of models) {
    const spoken = splitCamelAndSnake(String(m.name || "").split("(")[0].trim());
    if (spoken.length >= 3) add(spoken, "model", `${m.file}:L${m.line}`, "", "derived");
  }

  // 6. From Tier-1/Tier-2 priority docs & markdown headings/acronyms
  for (const d of docFacts) {
    if (d.isPriority && !d.excludeFromRules && d.title) add(d.title, "doc", d.relPath, "", "derived");
    for (const r of d.rules || []) {
      const abbr = /\b([A-Z]{2,6})\s*\(([^)]{4,40})\)/.exec(r.text || "");
      if (abbr) add(abbr[2], "term", `${abbr[1]} (${d.relPath}:L${r.line})`, "", "derived", [abbr[1]]);
    }
  }

  return [...entries.values()]
    .filter((e) => e.fid || e.source === "manual" || e.targetType === "feature")
    .sort((a, b) => (a.source === "manual" ? -1 : 0) - (b.source === "manual" ? -1 : 0) || a.spoken.localeCompare(b.spoken))
    .slice(0, 120);
}

module.exports = {
  splitCamelAndSnake,
  buildGlossary,
};
