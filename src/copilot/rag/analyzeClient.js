// The reading model (google/gemini-3.8-flash through OpenRouter): turns a PDF, an image, an audio or a video part
// into text the answer models can read, and writes the few-line summary of each file. It sees the whole file, so
// nothing is chunked for it. Electron-free; the HTTP layer is injected like the embed client's.
const { postJson, pool } = require("./openrouter");
const { RAG } = require("./config");
const { mmss } = require("./chunker");

const dataUri = (mime, buf) => `data:${mime};base64,${buf.toString("base64")}`;

function createAnalyzer({
  apiKey,
  model = RAG.analysisModel,
  concurrency = RAG.analysisConcurrency,
  baseUrl,
  fetchImpl,
  sleep,
  cfg = RAG,
} = {}) {
  const slots = pool(concurrency);
  const http = { apiKey, baseUrl, fetchImpl, sleep, timeoutMs: 180000 };

  // parts: OpenRouter content parts. Returns { text, tokens, cost }.
  // json: ask for one JSON object back (file profiles).
  const ask = (parts, { system, maxTokens = 4000, json = false } = {}) =>
    slots.run(async () => {
      const res = await postJson(
        "/chat/completions",
        {
          model,
          max_tokens: maxTokens,
          temperature: 0.1,
          reasoning: { effort: "low" },
          ...(json ? { response_format: { type: "json_object" } } : {}),
          messages: [
            ...(system ? [{ role: "system", content: system }] : []),
            { role: "user", content: parts },
          ],
        },
        http
      );
      return {
        text: String(res.choices?.[0]?.message?.content ?? "").trim(),
        finish: res.choices?.[0]?.finish_reason ?? null,
        tokens: res.usage?.total_tokens ?? 0,
        cost: Number(res.usage?.cost) || 0,
      };
    });

  return {
    model,
    ask,
    // A PDF to markdown with page markers. Scans are read too (it is a vision model).
    async readPdf(buffer, name, firstPage = 1) {
      const r = await ask(
        [
          {
            type: "text",
            text: `Convert this document to Markdown for a search index. Keep every word, number, table (as Markdown tables) and heading (as # headings). Describe each chart or picture in one line starting with 'Figure:'. Put a line [[page N]] before the content of each page; the first page of this file is page ${firstPage}. Output only the Markdown.`,
          },
          {
            type: "file",
            file: { filename: name || "file.pdf", file_data: dataUri("application/pdf", buffer) },
          },
        ],
        { maxTokens: 64000 }
      );
      return { ...r, partial: r.finish === "length" };
    },
    // An image: what it shows and every piece of text on it.
    async readImage(buffer, mime) {
      return ask(
        [
          {
            type: "text",
            text: "Write this image up for a search index. First two sentences: what it is and what it shows. Then copy out ALL the text, numbers, labels, step names and table contents on it exactly, section by section, one item per line. If it is a diagram or flow, list the steps in order. Plain text, no preamble.",
          },
          { type: "image_url", image_url: { url: dataUri(mime, buffer) } },
        ],
        { maxTokens: 2500 }
      );
    },
    // A part of an audio or video file: timestamped lines. `offset` is where the part starts in the whole file.
    async readMedia(kind, buffer, mime, offset = 0) {
      const what =
        kind === "video"
          ? "Write what is said (a transcript) and, on their own lines starting with 'Shown:', what is visible on screen (slides, text, charts, demos)."
          : "Write a transcript of what is said; note speaker changes as a new line.";
      const r = await ask(
        [
          {
            type: "text",
            text: `${what} Start every line with its time as [mm:ss] counted from the start of this clip. Keep it faithful; no summary, no preamble.`,
          },
          kind === "video"
            ? { type: "video_url", video_url: { url: dataUri(mime, buffer) } }
            : {
                type: "input_audio",
                input_audio: {
                  data: buffer.toString("base64"), // the chat API takes bare base64 here; the embeddings API takes a data URL
                  format: mime.includes("wav") ? "wav" : "mp3",
                },
              },
        ],
        { maxTokens: 16000 }
      );
      return { ...r, lines: parseTimed(r.text, offset) };
    },
    // 2-3 plain sentences: what the file is and what it holds, so a model can tell whether to look inside.
    async summarize({ name, kind, text }) {
      const s = String(text ?? "");
      const partLimit = cfg.summaryPartChars ?? 400_000;
      const maxWords = cfg.summaryMaxWords ?? 60;

      if (s.length <= partLimit) {
        const r = await ask(
          [
            {
              type: "text",
              text: `File: ${name} (${kind})\n\nContent:\n${s}\n\nWrite at most ${maxWords} words in plain English: what this file is, what it contains (the main topics, names and numbers worth knowing), and when it would be useful in a meeting. No preamble, no bullet points.`,
            },
          ],
          { maxTokens: 300 }
        );
        return { ...r, summary: r.text.replace(/\s+/g, " ").slice(0, 500) };
      }

      // Map-reduce over parts split at heading/paragraph boundaries
      const parts = splitSummaryParts(s, partLimit);
      let totalTokens = 0;
      let totalCost = 0;

      const partSummaries = [];
      for (let i = 0; i < parts.length; i++) {
        const r = await ask(
          [
            {
              type: "text",
              text: `File: ${name} (${kind})\nPart ${i + 1} of ${parts.length}\n\nContent:\n${parts[i]}\n\nWrite at most ${Math.round(maxWords * 0.8)} words in plain English: what this part covers, key topics, names and numbers worth knowing. No preamble, no bullet points.`,
            },
          ],
          { maxTokens: 250 }
        );
        totalTokens += r.tokens || 0;
        totalCost += r.cost || 0;
        partSummaries.push(r.text.trim());
      }

      const reducePrompt = `File: ${name} (${kind})\nBelow are summaries of the file's ${parts.length} parts, in order:\n\n${partSummaries.map((ps, i) => `--- Part ${i + 1} ---\n${ps}`).join("\n\n")}\n\nWrite at most ${maxWords} words in plain English: what this file is, what it contains (the main topics, names and numbers worth knowing across all parts), and when it would be useful in a meeting. No preamble, no bullet points.`;

      const reduceRes = await ask(
        [
          {
            type: "text",
            text: reducePrompt,
          },
        ],
        { maxTokens: 300 }
      );
      totalTokens += reduceRes.tokens || 0;
      totalCost += reduceRes.cost || 0;

      return {
        ...reduceRes,
        summary: reduceRes.text.replace(/\s+/g, " ").slice(0, 500),
        tokens: totalTokens,
        cost: totalCost,
      };
    },
  };
}

// "[01:23] text" lines -> [{t (seconds, whole file), text}]. A line without a time continues the previous one.
function parseTimed(text, offset = 0) {
  const out = [];
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^\[?(?:(\d+):)?(\d{1,2}):(\d{2})\]?\s*[-–:]?\s*(.*)$/.exec(line);
    if (m)
      out.push({
        t: offset + (Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3])),
        text: m[4],
      });
    else if (out.length) out.at(-1).text += " " + line;
    else out.push({ t: offset, text: line });
  }
  return out;
}

// Splits long text on paragraph / heading boundaries into parts under maxChars
function splitSummaryParts(text, maxChars) {
  const paragraphs = String(text ?? "").split(/\n\s*\n/);
  const parts = [];
  let cur = "";

  for (const p of paragraphs) {
    if (!p.trim()) continue;
    if (cur && cur.length + p.length + 2 > maxChars) {
      parts.push(cur.trim());
      cur = "";
    }
    if (p.length > maxChars) {
      if (cur) {
        parts.push(cur.trim());
        cur = "";
      }
      for (let i = 0; i < p.length; i += maxChars) {
        parts.push(p.slice(i, i + maxChars).trim());
      }
    } else {
      cur = cur ? `${cur}\n\n${p}` : p;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.length ? parts : [String(text ?? "")];
}

module.exports = { createAnalyzer, parseTimed, splitSummaryParts, mmss };
