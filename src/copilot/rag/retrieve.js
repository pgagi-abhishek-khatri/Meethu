// Finds the pieces of the project's files a question needs, fast. Keyword (FTS5) and vector hits are merged, weak
// matches are dropped, and the rest is worded for the answer model with where each came from. It is only called
// when the moment needs the project's own documents (the decider's `needs_project`, a typed question, a high-effort
// rerun). `prefetch` lets the question's embedding start while the decider is still thinking.
const { RAG } = require("./config");
const { mmss } = require("./chunker");

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
// the speaker label ("OTHER-1:") is not part of the question
const clean = (q) =>
  String(q ?? "")
    .replace(/\b(?:USER|OTHER-?\d*|NEARBY-?\d*)\s*:/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-400);

function createRetriever({
  rag,
  clients,
  cfg = RAG,
  log = () => {},
  now = Date.now,
  embedWaitMs = 2500,
}) {
  const indexed = (projectIds) => projectIds.filter((id) => rag.hasIndex(id));

  return {
    hasIndex: (projectIds) => indexed(projectIds).length > 0,

    // Always in the answer prompt when the project has indexed files: what exists, so the model (and the decider)
    // can tell whether looking inside would help. No model call.
    // The same catalog as short lines for the decider: "file: what it is".
    catalogLines(projectIds) {
      return indexed(projectIds)
        .flatMap((id) => rag.catalog(id))
        .slice(0, 8)
        .map(
          (r) => `${r.name}: ${clip(String(r.summary ?? r.kind ?? "").split(/(?<=\.)\s/)[0], 100)}`
        );
    },

    catalog(projectIds) {
      const rows = indexed(projectIds)
        .flatMap((id) => rag.catalog(id))
        .slice(0, cfg.catalogFiles);
      if (!rows.length) return "";
      return `The USER's project files (what each holds; the matching passages come below when they are needed):\n${rows.map((r) => `- ${r.name}: ${clip(r.summary ?? r.kind ?? "", cfg.catalogChars)}`).join("\n")}`;
    },

    // Fire and forget: warm the query embedding while the decider runs, so the real search finds it cached.
    prefetch(query, projectIds) {
      const q = clean(query);
      const cl = clients();
      if (!q || !cl || !indexed(projectIds).length) return;
      cl.embed.embedQueries([q]).catch(() => {});
    },

    // -> { text, used: [{ file, where, score }], skipped: null | reason, ms }
    async retrieve({ query, projectIds, deep = false, why = "", expand = null, minScore = 0 }) {
      const t0 = now();
      const q = clean(query);
      const done = (r) => {
        log({ event: "retrieve", question: clip(q, 160), why, deep, ...r.log, ms: now() - t0 });
        return { text: "", used: [], skipped: null, ...r.out, ms: now() - t0 };
      };
      const ids = indexed(projectIds);
      if (!q)
        return done({
          log: { mode: "skipped", reason: "empty_query" },
          out: { skipped: "empty_query" },
        });
      if (!ids.length)
        return done({ log: { mode: "skipped", reason: "no_index" }, out: { skipped: "no_index" } });
      const cl = clients();
      const lim = deep ? cfg.deep : cfg.fast;

      // queries: the question itself; a high-effort rerun also asks a cheap model for other ways to put it
      const queries = [q];
      let expandMs = 0;
      if (deep && expand) {
        const e0 = now();
        try {
          for (const x of (
            await Promise.race([
              expand(q),
              new Promise((r) => setTimeout(() => r([]), embedWaitMs)),
            ])
          ).slice(0, 3))
            if (x && !queries.includes(x)) queries.push(clean(x));
        } catch {}
        expandMs = now() - e0;
      }

      const keywordLists = [];
      const kwRank = new Map(); // chunk id -> best keyword rank
      for (const pid of ids)
        for (const query of queries) {
          const hits = rag.keyword(pid, query, 12);
          keywordLists.push(hits);
          hits.forEach((id, r) => kwRank.set(id, Math.min(kwRank.get(id) ?? 99, r)));
        }

      // vectors, but never let a slow embedding hold the card: keyword-only after embedWaitMs
      let vectorLists = [];
      const cos = new Map(); // chunk id -> best cosine
      let embedMs = null;
      let mode = "keyword";
      let embedError = null;
      if (cl) {
        const e0 = now();
        try {
          const r = await Promise.race([
            cl.embed.embedQueries(queries),
            new Promise((_, rej) =>
              setTimeout(() => rej(Object.assign(new Error("slow"), { code: "slow" })), embedWaitMs)
            ),
          ]);
          embedMs = now() - e0;
          for (const pid of ids)
            for (const vec of r.vectors) {
              const hits = rag.vector(pid, vec, 12);
              vectorLists.push(hits.map((h) => h.id));
              for (const h of hits) cos.set(h.id, Math.max(cos.get(h.id) ?? -1, h.score));
            }
          mode = "hybrid";
        } catch (e) {
          embedMs = now() - e0;
          embedError = e.code ?? e.message;
        }
      }

      const fused = rag.rrf([...vectorLists, ...keywordLists], {
        weights: [...vectorLists.map(() => 1), ...keywordLists.map(() => 0.8)],
      });
      const candidates = fused.length;
      const best = Math.max(-1, ...cos.values());
      // Unprompted look (the decider did not ask for the files): only when something matches this closely.
      if (minScore && best < minScore)
        return done({
          log: {
            mode,
            embedMs,
            embedError,
            queries: queries.length,
            best: Number(best.toFixed(3)),
            reason: "weak_match",
          },
          out: { skipped: "weak_match" },
        });
      const kept = fused
        .filter((f) => {
          const c = cos.get(f.id) ?? -1;
          // close enough in meaning (and not far behind the best match), or it holds the very words asked for
          const exact = (kwRank.get(f.id) ?? 99) < cfg.strongKeyword;
          // the very words asked for count, but not when the meaning is far off (or there is no embedding to check)
          return (
            (c >= cfg.floor && c >= best - cfg.margin) ||
            (exact && (mode === "keyword" || c >= cfg.keywordFloor))
          );
        })
        .slice(0, lim.k);
      let used = 0;
      const parts = [];
      const usedInfo = [];
      for (const f of kept) {
        const c = rag.chunk(f.id);
        if (!c) continue;
        const where =
          c.meta.page != null
            ? `p.${c.meta.page}`
            : c.meta.start != null
              ? mmss(c.meta.start)
              : c.meta.heading || "";
        const body = clip(c.text, 900);
        if (used + body.length > lim.chars && parts.length) break;
        used += body.length;
        parts.push(`[${c.file}${where ? ` · ${where}` : ""}]\n${body}`);
        usedInfo.push({
          file: c.file,
          where,
          score: Number((cos.get(f.id) ?? 0).toFixed(3)),
          kw: kwRank.get(f.id) ?? null,
        });
      }
      const text = parts.length
        ? `Passages from the USER's project files that match this moment (use them when they answer it; say where a fact comes from in plain words, like "from the pricing sheet"; never quote a path):\n\n${parts.join("\n\n")}`
        : "";
      return done({
        log: {
          mode,
          embedMs,
          expandMs,
          embedError,
          queries: queries.length,
          candidates,
          kept: usedInfo,
          chars: used,
          reason: parts.length ? null : candidates ? "below_floor" : "no_match",
        },
        out: {
          text,
          used: usedInfo,
          skipped: parts.length ? null : candidates ? "below_floor" : "no_match",
        },
      });
    },
  };
}

module.exports = { createRetriever, clean };
