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

      // queries: the moment itself, plus what the query model wrote (`expand`); the search waits for it unless
      // `queryWaitMs` caps the wait.
      // The moment's embedding starts at once (usually cached by the prefetch), so the written queries
      // only add their own embedding after them, and a slow query model costs nothing but its queries.
      const queries = [q];
      // Every wait is cleared once it is no longer needed: a pending 2.5 s timer per search adds up.
      const timers = new Set();
      const timeout = (ms, value) =>
        new Promise((r) => {
          const t = setTimeout(() => (timers.delete(t), r(value)), ms);
          timers.add(t);
        });
      const clearTimers = () => {
        for (const t of timers) clearTimeout(t);
        timers.clear();
      };
      const embedOf = (texts) =>
        cl
          ? cl.embed.embedQueries(texts).then(
              (r) => ({ r }),
              (e) => ({ e })
            )
          : null;
      const slow = { e: { code: "slow" } };
      const rawEmbed = embedOf([q]);
      // The moment's vector is only "slow" once the search has nothing else to wait for: while the query model
      // is still writing, waiting for it costs nothing. Its deadline is embedWaitMs from the start, or
      // `embedGraceMs` after the query model settled when that is later. A vector that misses it still lands in
      // the embed client's cache for the next search.
      const vectorWait = () =>
        rawEmbed
          ? Promise.race([
              rawEmbed,
              timeout(
                Math.max(embedWaitMs - (now() - t0), written ? (cfg.embedGraceMs ?? 300) : 0),
                slow
              ),
            ])
          : null;
      // The query model starts at once, beside the moment's embedding; it is aborted when its answer is no longer wanted.
      const writing = expand ? new AbortController() : null;
      const e0 = now();
      const written = expand
        ? Promise.resolve()
            .then(() => expand(q, { signal: writing.signal }))
            .then(
              (r) => ({ r }),
              (e) => ({ e })
            )
        : null;
      const weak = (best, embed) => {
        writing?.abort();
        clearTimers();
        const cost = embed.cost ?? 0;
        return done({
          log: {
            mode: embed.mode,
            embedMs: embed.ms,
            expandMs: null,
            expandError: expand ? "not_needed" : null,
            embedError: embed.error,
            queries,
            cost,
            best: Number(best.toFixed(3)),
            reason: "weak_match",
          },
          out: { skipped: "weak_match", queries, cost, expandMs: null, embedMs: embed.ms },
        });
      };
      // Unprompted look: only the moment's own words decide whether anything is close enough to look further,
      // so a moment with nothing in the files never waits for the query model.
      if (minScore) {
        if (!rawEmbed) return weak(-1, { mode: "keyword", ms: null, error: null });
        const m0 = now();
        const raw = await Promise.race([rawEmbed, timeout(embedWaitMs, slow)]);
        const ms = now() - m0;
        const vec = raw.r?.vectors?.[0];
        let top = -1;
        if (vec) {
          const kwIds = cfg.scoreKeywordHits && rag.similarity ? [] : null;
          for (const pid of ids) {
            for (const h of rag.vector(pid, vec, 12)) top = Math.max(top, h.score);
            if (kwIds) {
              const hits = rag.keyword(pid, q, 12);
              if (hits.length)
                for (const s of rag.similarity(pid, hits, vec).values()) top = Math.max(top, s);
            }
          }
        }
        if (top < minScore)
          return weak(top, {
            mode: vec ? "hybrid" : "keyword",
            ms,
            error: raw.e?.code ?? raw.e?.message ?? null,
            cost: raw.r?.cost ?? 0,
          });
      }
      let expandMs = null;
      let expandCost = 0;
      let expandError = null;
      if (written) {
        const waitMs = deep ? cfg.queryWaitMs.deep : cfg.queryWaitMs.fast;
        const left = waitMs == null ? null : Math.max(0, waitMs - (now() - e0));
        const res = await (left == null ? written : Promise.race([written, timeout(left, null)]));
        if (!res) {
          expandError = "slow";
          writing.abort(); // its queries would arrive too late to be used
        } else if (res.e) {
          expandError = res.e.code ?? res.e.message ?? "error";
        } else {
          const got = res.r;
          const list = Array.isArray(got) ? got : (got?.queries ?? []);
          expandCost = got?.cost ?? 0;
          for (const x of list.slice(0, 3)) {
            const c = clean(x);
            if (c && !queries.includes(c)) queries.push(c);
          }
        }
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

      // vectors, but never let a slow embedding hold the card: keyword-only after embedWaitMs.
      // Written queries are embedded too only with `embedWritten`: the embedding call is a full round trip
      // (about a second) the moment's own prefetched vector does not pay; without it they search by keyword.
      const vectorLists = [];
      const vectorWeights = [];
      const cos = new Map(); // chunk id -> best cosine over all queries
      const near = new Set(); // chunks within `margin` of the best match of a query that found them
      let embedMs = null;
      let embedCost = 0;
      let mode = "keyword";
      let embedError = null;
      if (cl) {
        const e0 = now();
        const [raw, extra] = await Promise.all([
          vectorWait(),
          queries.length > 1 && cfg.embedWritten
            ? Promise.race([embedOf(queries.slice(1)), timeout(embedWaitMs, slow)])
            : { r: { vectors: [] } },
        ]);
        embedMs = now() - e0;
        const vectors = [...(raw.r?.vectors ?? []), ...(extra.r?.vectors ?? [])];
        const written = (vi) => vi > 0 || !raw.r; // the moment's own vector is first, when it came back
        embedCost = (raw.r?.cost ?? 0) + (extra.r?.cost ?? 0);
        embedError = raw.e?.code ?? raw.e?.message ?? extra.e?.code ?? extra.e?.message ?? null;
        // A chunk only the keyword search found has no cosine yet: it is scored against the same vectors, so an
        // exact name or number outside the vector top 12 is judged on its meaning rather than dropped.
        const kwIds = cfg.scoreKeywordHits && rag.similarity ? [...kwRank.keys()] : [];
        for (const pid of ids)
          vectors.forEach((vec, vi) => {
            const hits = rag.vector(pid, vec, 12);
            vectorLists.push(hits.map((h) => h.id));
            vectorWeights.push(written(vi) ? cfg.writtenWeight : 1);
            const scores = new Map(hits.map((h) => [h.id, h.score]));
            const extra = kwIds.filter((id) => !scores.has(id));
            if (extra.length)
              for (const [id, s] of rag.similarity(pid, extra, vec)) scores.set(id, s);
            // "not far behind the best" is judged per query: a broad written query matching a general
            // passage well must not push out what the moment's own words matched
            const top = hits[0]?.score ?? -1;
            for (const [id, s] of scores) {
              cos.set(id, Math.max(cos.get(id) ?? -1, s));
              if (s >= top - cfg.margin) near.add(id);
            }
          });
        if (vectors.length) mode = "hybrid";
      }
      clearTimers(); // every wait has been decided

      const fused = rag.rrf([...vectorLists, ...keywordLists], {
        weights: [
          ...vectorWeights,
          ...keywordLists.map((_, li) => 0.8 * (li % queries.length ? cfg.writtenWeight : 1)),
        ],
      });
      const candidates = fused.length;
      const best = Math.max(-1, ...cos.values());
      // Unprompted look (the decider did not ask for the files): only when something matches this closely.
      if (minScore && best < minScore)
        return done({
          log: {
            mode,
            embedMs,
            expandMs,
            expandError,
            embedError,
            queries,
            cost: expandCost + embedCost,
            best: Number(best.toFixed(3)),
            reason: "weak_match",
          },
          out: { skipped: "weak_match", queries, cost: expandCost + embedCost, expandMs, embedMs },
        });
      const kept = fused
        .filter((f) => {
          const c = cos.get(f.id) ?? -1;
          // close enough in meaning (and not far behind the best match), or it holds the very words asked for
          const exact = (kwRank.get(f.id) ?? 99) < cfg.strongKeyword;
          // the very words asked for count, but not when the meaning is far off (or there is no embedding to check)
          return (
            (c >= cfg.floor && near.has(f.id)) ||
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
          expandError,
          embedError,
          queries,
          cost: expandCost + embedCost,
          candidates,
          kept: usedInfo,
          chars: used,
          reason: parts.length ? null : candidates ? "below_floor" : "no_match",
        },
        out: {
          text,
          queries,
          cost: expandCost + embedCost,
          expandMs,
          embedMs,
          used: usedInfo,
          skipped: parts.length ? null : candidates ? "below_floor" : "no_match",
        },
      });
    },
  };
}

module.exports = { createRetriever, clean };
