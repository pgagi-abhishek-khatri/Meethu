// Builds priority-ranked symbol index across exported functions, classes, types, schemas, constants,
// feature flags, routes, and IPC/event names. Never silently discards total symbol counts.

const ROLE_PRIORITY = {
  "entry point": 22,
  "model/schema": 22,
  "type definitions": 20,
  "service/API client": 18,
  "state store": 16,
  "route/page": 16,
  middleware: 14,
  "job/worker": 14,
  CLI: 12,
  "hook/controller": 10,
  utility: 8,
  "UI component": 7,
  config: 5,
  migration: 3,
  test: 1,
  script: 1,
  generated: 0,
};

const KIND_PRIORITY = {
  route: 100,
  flag: 90,
  class: 70,
  interface: 70,
  type: 68,
  struct: 68,
  function: 55,
  method: 35,
  constant: 32,
  event: 28,
};

function buildSymbolIndex(modules = [], { contracts = [], flags = [], graph = null, maxSymbols = Infinity } = {}) {
  const entries = [];
  const seen = new Set();

  const push = (symbol, kind, relPath, line, endLine = line, priority = 20) => {
    if (!symbol || symbol.length < 2) return;
    const key = `${symbol}|${kind}|${relPath}|${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ symbol, kind, relPath, line, endLine, priority });
  };

  for (const mod of modules) {
    const s = mod.structure || {};
    const roleScore = ROLE_PRIORITY[s.role] ?? 8;
    const fanIn = Math.min(20, graph?.inEdges?.get(mod.relPath)?.size || 0);
    const modScore = roleScore + fanIn;

    for (const c of s.classes || []) {
      if (c.exported !== false) {
        push(c.name, c.kind || "class", mod.relPath, c.line, c.endLine || c.line, (KIND_PRIORITY[c.kind] || KIND_PRIORITY.class) + modScore);
      }
    }
    for (const t of s.types || []) {
      if (t.exported !== false) {
        push(t.name, t.kind || "type", mod.relPath, t.line, t.endLine || t.line, (KIND_PRIORITY[t.kind] || KIND_PRIORITY.type) + modScore);
      }
    }
    for (const f of s.functions || []) {
      if (f.exported !== false) {
        const k = f.isMethod ? "method" : "function";
        push(f.name, k, mod.relPath, f.line, f.endLine || f.line, KIND_PRIORITY[k] + modScore);
      }
    }
    for (const k of s.constants || []) {
      if (k.exported !== false) {
        push(k.name, "constant", mod.relPath, k.line, k.endLine || k.line, KIND_PRIORITY.constant + modScore);
      }
    }
    const evList = (s.talksTo?.eventEntries && s.talksTo.eventEntries.length > 0) ? s.talksTo.eventEntries : (s.talksTo?.events || []);
    for (const ev of evList) {
      const evName = typeof ev === "string" ? ev : ev?.name;
      const evLine = typeof ev === "object" && ev?.line ? ev.line : 1;
      if (evName) push(evName, "event", mod.relPath, evLine, evLine, KIND_PRIORITY.event + Math.floor(modScore / 2));
    }
  }

  for (const c of contracts) {
    if (c.path && c.handlerFile) {
      push(`${c.method || "RPC"} ${c.path}`, "route", c.handlerFile, c.handlerLine || 1, c.handlerLine || 1, KIND_PRIORITY.route + 20);
    }
  }

  for (const fl of flags) {
    if (fl.name && fl.file) {
      push(fl.name, "flag", fl.file, fl.line || 1, fl.line || 1, KIND_PRIORITY.flag + 15);
    }
  }

  // Sort by priority descending first so budgeted trimming preserves high-value symbols across A-Z,
  // with alphabetical tie-breaking for determinism.
  entries.sort((a, b) => b.priority - a.priority || a.symbol.localeCompare(b.symbol) || a.relPath.localeCompare(b.relPath));
  if (Number.isFinite(maxSymbols)) {
    const sliced = entries.slice(0, maxSymbols);
    sliced.totalDiscovered = entries.length;
    return sliced;
  }
  entries.totalDiscovered = entries.length;
  return entries;
}

module.exports = { buildSymbolIndex };
