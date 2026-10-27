// Turns one project file into searchable chunks: read -> split -> (embed || summarise) -> save.
// The steps that wait on the network run side by side (batches of embeddings, parts of a long recording,
// the summary), and a few files go through at once. Every stage is logged with its time, tokens and cost.
// Electron-free: the model clients, ffmpeg and the store are injected.
const fs = require("fs");
const crypto = require("crypto");
const { RAG, LIMITS, MIME, classify, checkSize, extOf } = require("./config");
const { chunkText, planWindows, mmss } = require("./chunker");
const { readText, readOffice, splitPdf } = require("./extract");
const { mediaPart } = require("./embedClient");
const { pool } = require("./openrouter");

const FRIENDLY = {
  no_key: "Add your OpenRouter key in the Copilot settings, then retry.",
  auth: "OpenRouter did not accept the key.",
  credits: "OpenRouter credits ran out.",
  ffmpeg: "Could not read this audio or video file.",
  too_big: "The file is too big for the model to read.",
  model: "The reading model is not available on this key.",
  cancelled: "Cancelled.",
};
const friendly = (e) =>
  FRIENDLY[e.code] ?? `Could not index this file: ${String(e.message ?? e).slice(0, 160)}`;

const sha256 = (file) =>
  new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
// Like Promise.all, but waits for every sibling before failing: the temp folder is removed after this, and a
// sibling still cutting or billing must not run into a deleted folder.
async function settleAll(promises) {
  const r = await Promise.allSettled(promises);
  const bad = r.find((x) => x.status === "rejected");
  if (bad) throw bad.reason;
  return r.map((x) => x.value);
}
// A heading alone, "Figure: logo", "AND MANY MORE": nothing a search should ever hand to a model.
const worthIndexing = (c) =>
  c.text
    .replace(/^#+\s.*$/gm, "")
    .replace(/^Figure:.*$/gim, "")
    .trim().length >= 20;
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");

function createIngestor({
  rag,
  clients,
  media,
  log = () => {},
  now = Date.now,
  cfg: baseCfg = RAG,
  getCfg = null, // live overrides (settings)
  onChange = () => {},
}) {
  const slots = pool(baseCfg.filesAtOnce);
  const running = new Map(); // file id -> promise

  async function run(file) {
    const cfg = getCfg ? { ...baseCfg, ...getCfg() } : baseCfg; // settings changed since the last file apply from this one
    const t0 = now();
    const rec = (stage, extra = {}) =>
      log({ event: "ingest", fileId: file.id, file: file.name, stage, ms: now() - t0, ...extra });
    const set = (patch) => (rag.setFile(file.id, patch), onChange(file.id));
    let tokens = 0;
    let cost = 0;
    const bill = (r) => ((tokens += r?.tokens ?? 0), (cost += r?.cost ?? 0));
    let workDir = null;
    try {
      const cl = clients();
      if (!cl) throw Object.assign(new Error("no key"), { code: "no_key" });
      const kind = classify(file.name);
      let stat;
      try {
        stat = fs.statSync(file.path);
      } catch {
        throw Object.assign(new Error("File not found: it was moved or deleted."), {
          code: "missing",
        });
      }
      const size = checkSize(kind, stat.size);
      if (!size.ok)
        throw Object.assign(new Error(size.reason), { code: "limit", friendly: size.reason });
      if (rag.projectBytes(file.project_id) > LIMITS.project.maxBytes)
        throw Object.assign(new Error("limit"), {
          code: "limit",
          friendly: "This project is over its 1 GB limit.",
        });
      set({ kind, bytes: stat.size, status: "reading", stage: "Reading", error: null, note: null });
      const hash = await sha256(file.path);
      rec("read", { kind, bytes: stat.size });

      // ---- prepare: chunks = [{ text, meta, native?: {...} }] and the text the summary reads
      let chunks = [];
      let note = null;
      if (kind === "text" || kind === "office") {
        const r = kind === "text" ? readText(file.path) : await readOffice(file.path);
        if (r.partial) note = "Only the first part of this file was indexed (it is very long).";
        chunks = chunkText(r.text, {
          target: cfg.chunkChars,
          overlap: cfg.chunkOverlap,
          min: cfg.minChunkChars,
        })
          .filter(worthIndexing)
          .map((c) => ({ text: c.text, meta: { heading: c.heading, page: c.page } }));
      } else if (kind === "pdf") {
        set({ status: "analysing", stage: "Reading the PDF" });
        // Long PDFs are cut into parts of PDF_PAGES pages and the parts are read at the same time.
        const parts = await splitPdf(fs.readFileSync(file.path), cfg.pdfPages);
        if (parts.length > 1) set({ stage: `Reading ${parts.length} parts at once` });
        const reads = await settleAll(
          parts.map((p) => cl.analyze.readPdf(p.buf, file.name, p.from))
        );
        reads.forEach(bill);
        const r = {
          text: reads.map((x) => x.text).join("\n\n"),
          partial: reads.some((x) => x.partial),
        };
        if (r.partial) note = "Part of this PDF could not be read in full.";
        chunks = chunkText(r.text, {
          target: cfg.chunkChars,
          overlap: cfg.chunkOverlap,
          min: cfg.minChunkChars,
        })
          .filter(worthIndexing)
          .map((c) => ({ text: c.text, meta: { heading: c.heading, page: c.page } }));
      } else if (kind === "image") {
        set({ status: "analysing", stage: "Looking at the image" });
        const buf = fs.readFileSync(file.path);
        const mime = MIME[extOf(file.name)] ?? "image/png";
        const r = await cl.analyze.readImage(buf, mime);
        bill(r);
        // The write-up can be long (a diagram with many labels): split it like any text. The first piece is embedded
        // together with the picture itself, the others from their words.
        chunks = chunkText(r.text, { target: cfg.chunkChars, overlap: 0, min: cfg.minChunkChars })
          .filter(worthIndexing)
          .map((c) => ({ text: c.text, meta: {} }));
        if (!chunks.length) chunks = [{ text: r.text, meta: {} }];
        chunks[0].native = { kind: "image", mime, buf };
      } else if (kind === "audio" || kind === "video") {
        if (!media.available())
          throw Object.assign(new Error("ffmpeg missing"), { code: "ffmpeg" });
        set({
          status: "analysing",
          stage: kind === "video" ? "Preparing the video" : "Preparing the audio",
        });
        workDir = media.makeDir();
        const dur = await media.duration(file.path);
        if (!dur) throw Object.assign(new Error("unreadable"), { code: "ffmpeg" });
        const maxS = LIMITS[kind].maxSeconds;
        if (dur > maxS)
          throw Object.assign(new Error("long"), {
            code: "limit",
            friendly: `Too long: ${Math.round(dur / 60)} min, the limit is ${Math.round(maxS / 60)} min.`,
          });
        const work = await media.workingCopy(kind, file.path, workDir);
        rec("transcoded", { seconds: Math.round(dur) });
        const mime = kind === "video" ? "video/mp4" : "audio/mpeg";
        const parts = planWindows(dur, cfg.partSeconds, 0);
        set({ stage: `Reading ${parts.length} part${parts.length > 1 ? "s" : ""} at once` });
        const lines = (
          await settleAll(
            parts.map(async (p, i) => {
              const cut = await media.cut(
                kind,
                work,
                workDir,
                p.start,
                p.end - p.start,
                `part${i}`
              );
              const r = await cl.analyze.readMedia(kind, fs.readFileSync(cut), mime, p.start);
              bill(r);
              return r.lines;
            })
          )
        )
          .flat()
          .sort((a, b) => a.t - b.t);
        const win = kind === "video" ? cfg.videoWindow : cfg.audioWindow;
        const over = kind === "video" ? cfg.videoOverlap : cfg.audioOverlap;
        let nativeLeft = cfg.mediaEmbedMinutes * 60;
        for (const w of planWindows(dur, win, over)) {
          const text = lines
            .filter((l) => l.t >= w.start && l.t < w.end)
            .map((l) => `[${mmss(l.t)}] ${l.text}`)
            .join("\n");
          if (!text.trim()) continue; // nothing was said or shown: nothing to answer from
          const len = w.end - w.start;
          const native =
            nativeLeft >= len ? { kind, mime, work, start: w.start, length: len } : null;
          if (native) nativeLeft -= len;
          chunks.push({
            text,
            meta: { start: Math.round(w.start), end: Math.round(w.end) },
            native,
          });
        }
        if (nativeLeft < 0 || chunks.some((c) => !c.native))
          note = `Searched by its transcript after the first ${cfg.mediaEmbedMinutes} min (audio and video embedding is capped to keep the cost down).`;
      } else
        throw Object.assign(new Error("unsupported"), {
          code: "limit",
          friendly: "This file type is not supported yet.",
        });

      if (!chunks.length)
        throw Object.assign(new Error("empty"), {
          code: "limit",
          friendly: "Nothing readable was found in this file.",
        });
      if (
        rag.chunkCount(file.project_id) - (rag.file(file.id)?.chunk_count ?? 0) + chunks.length >
        LIMITS.project.maxChunks
      )
        throw Object.assign(new Error("limit"), {
          code: "limit",
          friendly: "This project already holds the most text it can index.",
        });
      rec("prepared", {
        chunks: chunks.length,
        native: chunks.filter((c) => c.native).length,
        tokens,
        cost,
      });

      // ---- embed and summarise at the same time
      set({ status: "embedding", stage: `Embedding ${chunks.length} pieces`, note });
      const dims = cl.embed.dims;
      const docText = chunks.map((c) => c.text).join("\n\n");
      const summaryP = cl.analyze
        .summarize({ name: file.name, kind, text: docText })
        .then((r) => (bill(r), r.summary))
        .catch(
          (e) => (
            rec("summary_failed", { error: e.message }),
            docText.slice(0, 240).replace(/\s+/g, " ")
          )
        );

      const titleOf = (c) => `${file.name}${c.meta.heading ? ` · ${c.meta.heading}` : ""}`;
      // chunks embedded from text: cache first (same words, same vector)
      const asText = chunks.filter((c) => !c.native);
      asText.forEach((c) => (c.hash = sha1(`${dims}|${titleOf(c)}|${c.text}`)));
      const cached = rag.cachedVectors(
        asText.map((c) => c.hash),
        dims
      );
      const toEmbed = asText.filter((c) => !cached.has(c.hash));
      const textP = cl.embed
        .embedDocs(toEmbed.map((c) => ({ title: titleOf(c), text: c.text })))
        .then((r) => {
          bill(r);
          toEmbed.forEach((c, i) => (c.vec = r.vectors[i]));
        });
      const nativeFailed = [];
      const nativeP = Promise.all(
        chunks
          .filter((c) => c.native)
          .map(async (c) => {
            try {
              const n = c.native;
              let parts;
              if (n.kind === "image")
                parts = [{ type: "text", text: c.text }, mediaPart("image", n.buf, n.mime)];
              else {
                const cut = await media.cut(
                  n.kind,
                  n.work,
                  workDir,
                  n.start,
                  n.length,
                  `emb${c.meta.start}`
                );
                parts = [mediaPart(n.kind, fs.readFileSync(cut), n.mime)];
              }
              const r = await cl.embed.embedMedia(parts);
              bill(r);
              c.vec = r.vector;
              c.embed = "media";
            } catch (e) {
              rec("native_embed_failed", { error: e.message, code: e.code });
              nativeFailed.push(c); // the transcript still finds it
            }
          })
      );
      const [summary] = await settleAll([summaryP, textP, nativeP]);
      if (nativeFailed.length) {
        const r = await cl.embed.embedDocs(
          nativeFailed.map((c) => ({ title: titleOf(c), text: c.text }))
        );
        bill(r);
        nativeFailed.forEach(
          (c, i) => ((c.vec = r.vectors[i]), (c.hash = sha1(`${dims}|${titleOf(c)}|${c.text}`)))
        );
      }
      for (const c of asText) if (!c.vec) c.vec = cached.get(c.hash);
      rec("embedded", {
        texts: toEmbed.length,
        cached: asText.length - toEmbed.length,
        native: chunks.filter((c) => c.embed === "media").length,
        tokens,
        cost,
      });

      // The file may have been removed while it was being read: do not leave its chunks behind.
      if (!rag.file(file.id)) return rec("removed");
      rag.replaceChunks(
        file.id,
        file.project_id,
        chunks.map((c) => ({
          text: c.text,
          meta: c.meta,
          embed: c.embed ?? "text",
          hash: c.hash ?? null,
          vec: c.vec,
        })),
        dims
      );
      set({
        status: "ready",
        stage: null,
        summary,
        hash,
        chunk_count: chunks.length,
        tokens,
        cost,
        indexed_at: now(),
        note,
        error: null,
      });
      rec("done", { chunks: chunks.length, tokens, cost, summary: summary.slice(0, 120) });
    } catch (e) {
      rec("error", { code: e.code, error: String(e.message).slice(0, 200) });
      set({
        status: "error",
        stage: null,
        error: e.friendly ?? (e.code === "missing" ? e.message : friendly(e)),
        tokens,
        cost,
      });
    } finally {
      if (workDir) media.cleanup(workDir);
    }
  }

  return {
    // Starts (or restarts) the file; resolves when it is ready or failed. The same file is never indexed twice at once.
    ingest(file) {
      if (running.has(file.id)) return running.get(file.id);
      rag.setFile(file.id, { status: "queued", stage: "Waiting", error: null });
      onChange(file.id);
      const p = slots.run(() => run(file)).finally(() => running.delete(file.id));
      running.set(file.id, p);
      return p;
    },
    isRunning: (id) => running.has(id),
    idle: () => Promise.all([...running.values()]),
  };
}

module.exports = { createIngestor, friendly };
