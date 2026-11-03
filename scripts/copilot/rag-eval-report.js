// Writes a detailed, per-moment report of a saved rag-query-eval run: what each model was given and what it
// returned (decider, query writer, embedding, search, answer card), old code next to new. No network calls: the
// inputs are rebuilt with the same pure builders the app uses, the outputs come from the saved run.
//   node scripts/copilot/rag-eval-report.js <rag-query-eval-*.json> <copilot.db> [--rep 0] [--out <file.md>]
// Not saved by the run, so not in the report: the decider's other probabilities, per-passage scores, card titles.
const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");
const d = require("../../src/copilot/core/decision");
const { createRetriever, clean } = require("../../src/copilot/rag/retrieve");
const { SYSTEM: QUERY_SYSTEM, userText } = require("../../src/copilot/rag/queryWriter");
const { buildAnswerMessages } = require("../../src/copilot/core/answer/contextPack");
const { MOMENTS } = require("./rag-eval-moments");

const args = process.argv.slice(2);
const arg = (n, dflt) => (args.includes(n) ? args[args.indexOf(n) + 1] : dflt);
const [jsonFile, dbFile] = args;
const rep = Number(arg("--rep", 0));
const outFile = arg("--out", jsonFile.replace(/\.json$/, `-detailed.md`));
const { summary, rows } = JSON.parse(fs.readFileSync(jsonFile, "utf8"));

// ---- the project catalog, exactly as the run saw it
const db = new DatabaseSync(dbFile, { readOnly: true });
const pids = db
  .prepare("SELECT DISTINCT project_id AS id FROM copilot_project_files WHERE status = 'ready' ORDER BY project_id")
  .all()
  .map((r) => r.id);
const readyFiles = db.prepare(
  "SELECT id, name, kind, summary FROM copilot_project_files WHERE project_id = ? AND status = 'ready' ORDER BY id"
);
const files = (pid) => readyFiles.all(pid);
const chunkCount = db.prepare("SELECT COUNT(*) AS n FROM copilot_chunks").get().n;
const offline = createRetriever({
  rag: { hasIndex: () => true, catalog: (pid) => files(pid) },
  clients: () => null,
});
const catalogLines = offline.catalogLines(pids);
const catalogText = offline.catalog(pids);

// ---- helpers
const VARIANTS = ["current", "fix", "kw", "embed"];
const LABEL = {
  current: "Old code (committed)",
  fix: "Fix only",
  kw: "New code (shipped)",
  embed: "New + embedded queries",
};
const fence = (s, lang = "text") => `~~~~${lang}\n${s}\n~~~~`;
const details = (title, body) => `<details><summary>${title}</summary>\n\n${body}\n\n</details>`;
const toRegex = (s) => {
  const m = /^\/(.*)\/(\w*)$/s.exec(s);
  return new RegExp(m[1], m[2]);
};
const pct = (p) => (p == null ? "–" : `${Math.round(p * 100)}%`);
const money = (x) => `$${(x ?? 0).toFixed(6)}`;
// "Passages from …:\n\n[file · where]\nbody\n\n[file · where]\nbody" -> [{ where, body }]
const splitPassages = (text) =>
  text
    ? text
        .split(/\n\n(?=\[[^\]\n]+\]\n)/)
        .slice(1)
        .map((p) => {
          const nl = p.indexOf("\n");
          return { where: p.slice(1, nl - 1), body: p.slice(nl + 1) };
        })
    : [];
const marks = (list, f) => list.map((r) => (f(r) == null ? "·" : f(r) ? "✓" : "✗")).join("");

function transcriptOf(lines, now) {
  return lines.map((l, k) => {
    const [who, ...rest] = l.split(":");
    const n = /OTHER-(\d)/.exec(who)?.[1];
    return {
      id: k + 1,
      source: who === "USER" ? "mic" : "system",
      speaker: n ? `system:${n}` : undefined,
      text: rest.join(":").trim(),
      at: now - (lines.length - k) * 4000,
      final: true,
    };
  });
}
const gistOf = (lines) =>
  [...lines]
    .reverse()
    .find((l) => l.includes("?"))
    ?.replace(/^[A-Z0-9-]+:\s*/, "") ?? lines.join(" ");

// ---- the questions the decider is asked (the same for every moment here)
const settings = { ...d.DEFAULT_SETTINGS, projectFiles: true };
const { questions } = d.buildQuestions({ settings, running: [], signals: {}, hasCards: false });

const out = [];
const p = (...xs) => out.push(...xs);
const S = summary;
const v = S.variants;

p(
  `# Copilot project search: old code vs new code, model by model`,
  "",
  `Run ${S.at} · ${S.moments} meeting moments x ${S.repeat} repeats · project: ${catalogLines.length} files, ${chunkCount} chunks · detailed walk-through below is repeat ${rep + 1}; the ✓/✗ strings show all ${S.repeat} repeats.`,
  "",
  "Every model call below is real: these are the inputs the run sent and the outputs it got back. Inputs are rebuilt offline with the same code the app uses (deterministic builders, same data); outputs are the saved results of the run.",
  "",
  "## The pipeline for one card",
  "",
  "1. **D1 decider** (`perplexity/pplx-decider-v1.2`): reads the moment, decides whether a card is worth making and whether it needs the project files (`needs_project`).",
  "2. **Query writer** (`google/gemma-4-31b-it:nitro`, new): turns the noisy moment into up to 3 short search queries. Runs only in the new code.",
  "3. **Embedding** (`google/gemini-embedding-2`, 768 dims): turns the query text into a vector. The moment's own text is embedded while D1 runs (prefetch).",
  "4. **Search** (`retrieve.js`, local): keyword search (SQLite FTS5) + vector search over the indexed chunks, merged with RRF, weak hits dropped, up to 2,800 characters of passages kept.",
  "5. **Answer card** (`qwen/qwen3.8-27b:nitro`): writes the card from the transcript, the file catalog and the kept passages.",
  "",
  "## What changed between old and new code",
  "",
  "| | Old code (committed) | New code (shipped) |",
  "|---|---|---|",
  "| Search queries | the moment's last 400 characters, filler included | the same, plus up to 3 queries Gemma writes (keyword search only, waits at most 900 ms) |",
  "| Chunk found only by keyword search | given cosine −1 and dropped | scored against the query vector, kept if close in meaning |",
  "| \"Not far behind the best match\" (0.05) | judged against the single best match of all queries | judged per query, so a broad query can't push out a specific hit |",
  "",
  "The two middle variants isolate each change: **Fix only** = the two search fixes without Gemma; **New + embedded queries** = also embeds Gemma's queries (one more ~1.1 s embedding call; rejected).",
  "",
  "## Results",
  "",
  `D1: p50 ${S.d1.p50} ms, p90 ${S.d1.p90} ms. It asked for the project files on ${S.d1.projectAskedOnAnswerable} answerable moments and ${S.d1.projectAskedOnOthers} of the others.`,
  "",
  "| | fact in kept passages | wrong passages on unrelated talk | moment → passages p50 / p90 | query writing p50 / p90 | card states the fact | card cost |",
  "|---|---|---|---|---|---|---|",
  ...VARIANTS.map(
    (n) =>
      `| ${LABEL[n]} | **${v[n].hit} (${v[n].hitPct}%)** | ${v[n].falsePositive} | ${v[n].readyMs.p50} / ${v[n].readyMs.p90} ms | ${v[n].expandMs.p50 ?? "–"} / ${v[n].expandMs.p90 ?? "–"} ms | ${v[n].answers?.correct ?? "not run"} | ${v[n].answers ? money(v[n].answers.costPerCard) : "–"} |`
  ),
  "",
  "\"Card states the fact\" is a strict text match (e.g. `AED 100 per car`), so it undercounts cards that say the fact in other words; read the cards below.",
  ""
);

// per-moment scoreboard
p("## Scoreboard: fact in passages / card states it (all repeats)", "", "| # | moment | Old | Fix only | New | New + embedded | card Old | card Fix | card New |", "|---|---|---|---|---|---|---|---|---|");
MOMENTS.forEach((m, k) => {
  const all = rows.filter((r) => r.i === k + 1);
  const hit = (n) => marks(all, (r) => (m.gold ? r.variants[n].hit : r.variants[n].falsePositive ? false : null));
  const card = (n) => marks(all, (r) => r.variants[n].answer?.correct ?? null);
  p(
    `| ${k + 1} | ${gistOf(m.lines).slice(0, 70)} | ${hit("current")} | ${hit("fix")} | ${hit("kw")} | ${hit("embed")} | ${card("current")} | ${card("fix")} | ${card("kw")} |`
  );
});
p("", "✓ found · ✗ missed · · nothing to find and nothing wrong returned. Moments 16 to 18 have nothing in the files.", "");

// prompts shared by every moment
const sysByDeliverable = new Map();
p(
  "## Fixed inputs (the same for every moment)",
  "",
  details("D1: the questions asked (typed questions, answered with probabilities)", fence(JSON.stringify(questions, null, 2), "json")),
  "",
  details("Gemma query writer: system prompt", fence(QUERY_SYSTEM)),
  "",
  details("Project file catalog given to D1 (one line per file)", fence(catalogLines.join("\n"))),
  ""
);

// ---- per moment
p("## Moment by moment", "");
for (const [k, m] of MOMENTS.entries()) {
  const row = rows.find((r) => r.i === k + 1 && r.rep === rep);
  if (!row) continue;
  const all = rows.filter((r) => r.i === k + 1);
  const gold = m.gold ? toRegex(String(m.gold)) : null;
  const now = Date.parse(S.at);
  const transcript = transcriptOf(m.lines, now);
  const focus = m.lines.join(" ");
  const gist = gistOf(m.lines);
  const state = d.buildDecisionState(
    {
      now,
      meeting: { title: "CarZilla phase 2 review", type: "client call" },
      summary: "Reviewing the CarZilla auction platform build and phase 2 features.",
      transcript,
      newFromId: 1,
      settings,
      signals: { endpoint: true, sinceLastCardMs: 60000 },
      projectFiles: catalogLines,
    },
    d.DEFAULT_DECISION_CONFIG
  );
  const raw = clean(focus);
  const written = row.variants.kw.queries.slice(1);
  const writtenEmbed = row.variants.embed.queries.slice(1);

  p(`### ${k + 1}. ${gist}`, "");
  p(`**Meeting moment** (what the copilot heard):`, "", fence(m.lines.join("\n")), "");
  p(gold ? `**The fact a correct search must find:** \`${gold}\`` : "**Nothing in the project files answers this.** A correct search returns nothing.", "");

  // verdict line
  const hits = Object.fromEntries(VARIANTS.map((n) => [n, row.variants[n].hit]));
  if (gold) {
    const verdict =
      hits.current === hits.kw
        ? hits.kw
          ? "Old and new code both found the fact."
          : "Neither old nor new code found the fact."
        : hits.kw
          ? "**Old code missed the fact; new code found it.**"
          : "**Old code found the fact; new code missed it.**";
    p(`**Verdict (this repeat):** ${verdict} Across all repeats: Old ${marks(all, (r) => r.variants.current.hit)}, Fix only ${marks(all, (r) => r.variants.fix.hit)}, New ${marks(all, (r) => r.variants.kw.hit)}.`, "");
  } else
    p(`**Verdict:** ${VARIANTS.some((n) => row.variants[n].falsePositive) ? "a variant returned passages for unrelated talk." : "no variant returned passages."}`, "");

  // 1. D1
  p(
    "#### 1. D1 decider (`perplexity/pplx-decider-v1.2`)",
    "",
    details("Input: state (questions above)", fence(JSON.stringify(state, null, 2), "json")),
    "",
    `**Output:** ${row.d1.kind === "run" ? `make a card, kind \`${row.d1.deliverable}\`` : `no card (\`${row.d1.kind}\`)`} · needs_project **${pct(row.d1.needsProject)}** (bar 50%) → ${row.d1.projectAsked ? "search the files" : row.d1.kind === "run" ? "unasked look only (closeness ≥ 0.69)" : "no search"} · ${row.d1.ms} ms`,
    ""
  );

  // 2. Gemma
  p(
    "#### 2. Query writer (`google/gemma-4-31b-it:nitro`), new code only",
    "",
    details("Input: user message", fence(userText({ moment: focus, gist, catalog: catalogLines.join("\n") }))),
    "",
    `**Output** (${row.variants.kw.expandMs ?? "–"} ms, ${money(row.variants.kw.cost)}): ` +
      (written.length
        ? `\n\n${written.map((q) => `- \`${q}\``).join("\n")}`
        : row.variants.kw.expandMs >= 890
          ? "none in time (900 ms cap); the card searched without them."
          : "no queries (NONE: nothing the files could hold)."),
    ""
  );

  // 3. Embedding
  const embedIn = (qs) => qs.map((q) => `task: search result | query: ${q}`).join("\n");
  p(
    "#### 3. Embedding (`google/gemini-embedding-2`, 768 dims)",
    "",
    "Old code, Fix only and New code embed the same single text: the moment, speaker labels removed, last 400 characters (prefetched while D1 runs). New code's Gemma queries go to keyword search, not to the embedder.",
    "",
    fence(embedIn([raw])),
    "",
    writtenEmbed.length ? details("New + embedded queries: the extra embedding call", fence(embedIn(writtenEmbed))) : "",
    "",
    `**Output:** one 768-number vector per text (not shown). Embedding wait after D1 (the old code does not report it): New ${row.variants.kw.embedMs ?? "–"} ms · New + embedded ${row.variants.embed.embedMs ?? "–"} ms.`,
    ""
  );

  // 4. Search
  p("#### 4. Search: passages kept for the card", "");
  p("| | queries searched | passages kept (✓ = holds the fact) | moment → passages |", "|---|---|---|---|");
  for (const n of ["current", "fix", "kw"]) {
    const x = row.variants[n];
    const ps = splitPassages(x.passages);
    const list = ps.length
      ? ps.map((q) => `${gold && gold.test(q.body) ? "✓ " : ""}${q.where}`).join("<br>")
      : `none (${x.skipped ?? "–"})`;
    // the committed retriever does not report its queries: it searched the moment alone
    const qn = n === "current" ? 1 : x.queries.length;
    p(`| ${LABEL[n]} | ${qn} | ${list} | ${x.readyMs} ms |`);
  }
  p("");
  for (const n of ["current", "kw"]) {
    const ps = splitPassages(row.variants[n].passages);
    if (ps.length)
      p(
        details(
          `${LABEL[n]}: full passages`,
          ps.map((q) => `**[${q.where}]**${gold && gold.test(q.body) ? " ✓ holds the fact" : ""}\n\n${fence(q.body)}`).join("\n\n")
        ),
        ""
      );
  }

  // 5. Card
  const cardRuns = ["current", "fix", "kw"].filter((n) => row.variants[n].answer);
  if (cardRuns.length) {
    const msgs = buildAnswerMessages({
      deliverable: row.d1.deliverable,
      web: false,
      proactive: true,
      focus,
      now,
      meeting: { title: "CarZilla phase 2 review" },
      summary: "",
      transcript,
      contextSeconds: 120,
      thread: [],
      catalog: catalogText,
      passages: row.variants.kw.passages,
    });
    sysByDeliverable.set(row.d1.deliverable, msgs[0].content);
    p(
      "#### 5. Answer card (`qwen/qwen3.8-27b:nitro`)",
      "",
      `Input: the system prompt for \`${row.d1.deliverable}\` (appendix) and this user message. It is the same for every variant except the passages block (step 4).`,
      "",
      details("Input: user message (New code's passages)", fence(msgs[1].content)),
      ""
    );
    for (const n of cardRuns) {
      const a = row.variants[n].answer;
      const verdict = a.skipped ? "skipped by the model" : a.error ? `error ${a.error}` : gold ? (a.correct ? "✓ states the fact" : "✗ fact not stated in those words") : "";
      p(
        `**${LABEL[n]}** card · ${verdict} · ${a.ms} ms · ${a.tokensIn ?? "–"} in / ${a.tokensOut ?? "–"} out tokens · ${money(a.cost)}`,
        "",
        a.body ? a.body.split("\n").map((l) => `> ${l}`).join("\n") : "> (no card)",
        ""
      );
    }
  } else p("#### 5. Answer card", "", "No card: D1 decided not to make one.", "");
  p("---", "");
}

// ---- appendix
p("## Appendix: answer model system prompts", "");
for (const [k, s] of sysByDeliverable) p(details(`System prompt for \`${k}\` cards`, fence(s)), "");
p(
  "## What this run did not save",
  "",
  "- D1's other probabilities (act, chatter, kind, needs_web …); only needs_project and the final decision were saved.",
  "- Per-passage cosine and keyword scores, so the report shows **which** passages each version kept, not the score that made the old code drop one.",
  "- Card titles (the body is shown).",
  "",
  "A run with full recording would add those; it costs OpenRouter credits, so it was not done."
);

fs.writeFileSync(outFile, out.join("\n") + "\n");
console.log(`Wrote ${outFile} (${Math.round(fs.statSync(outFile).size / 1024)} KB)`);
