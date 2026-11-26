// A deterministic rewrite of what was just said into keyword queries, with no model call. Identifiers are kept whole
// and split into their words ("retrieveChunks" -> retrievechunks, retrieve, chunks), so a question that names a
// function finds the passage that spells it snake_case or in a path. Electron-free.
const STOP = new Set(
  `a an the and or but if then than that this these those is are was were be been being am do does did done have has
  had having can could would should will shall may might must of in on at by for with from to into onto about over under
  as it its it's i me my we us our you your he she they them their his her what whats which who whom whose when where why
  how there here so just also very really actually please tell show give let know think mean means said say says like okay
  ok yeah yes no not uh um hmm mm well right sure thanks thank hi hello hey get got use used using any some all each
  every more most much many one two`
    .split(/\s+/)
    .filter(Boolean)
);
const MAX_TERMS = 16;

function splitIdentifier(id) {
  return String(id)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

// A word that is clearly a code name: a path, camelCase, PascalCase with a lower-case run, snake_case, kebab-case.
const isSymbol = (w) =>
  /[/\\]/.test(w) ||
  /^[a-z]+(?:[A-Z][a-z0-9]*)+$/.test(w) ||
  /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$/.test(w) ||
  /^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+$/.test(w) ||
  /^[A-Za-z]+(?:-[A-Za-z0-9]+){1,}$/.test(w) ||
  /\.[a-z]{1,5}$/.test(w);

function rewriteQuery(raw) {
  const text = String(raw ?? "");
  const symbols = [];
  const terms = [];
  const seen = new Set();
  const add = (t) => {
    const low = t.toLowerCase();
    if (!low || low.length < 2 || STOP.has(low) || seen.has(low) || terms.length >= MAX_TERMS)
      return;
    seen.add(low);
    terms.push(low);
  };

  // `code` and "quoted" text are what the speaker pointed at
  const quoted = [...text.matchAll(/`([^`]{2,80})`|"([^"]{2,80})"/g)].map((m) =>
    (m[1] ?? m[2]).trim()
  );
  const pool = [
    ...quoted,
    ...(text.replace(/`[^`]*`|"[^"]*"/g, " ").match(/[A-Za-z0-9_./\\-]+/g) ?? []),
  ];

  for (const word of pool) {
    const w = word.replace(/^[./\\-]+|[./\\-]+$/g, "");
    if (!w) continue;
    if (quoted.includes(word) || isSymbol(w)) {
      if (!symbols.includes(w)) symbols.push(w);
      add(w);
      for (const part of splitIdentifier(w)) add(part);
    } else {
      add(w);
    }
  }

  const queries = [];
  if (terms.length) queries.push(terms.join(" "));
  // the exact symbols alone: a precise second query that the broader one cannot dilute
  if (symbols.length && symbols.join(" ").toLowerCase() !== queries[0])
    queries.push(symbols.join(" "));
  return { queries, terms, symbols, needsModel: terms.length < 2 };
}

module.exports = { rewriteQuery, splitIdentifier, isSymbol };
