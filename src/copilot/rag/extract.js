// Reads the files that need no model: plain text and the Office formats (a zip of XML). Electron-free.
const fs = require("fs");
const { LIMITS, extOf } = require("./config");

const decode = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");

function readText(filePath) {
  let t = fs.readFileSync(filePath, "utf8").replace(/\0/g, "");
  const e = extOf(filePath);
  if (e === ".html" || e === ".htm" || e === ".xml")
    t = decode(
      t
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
        .replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
    ).replace(/[ \t]+/g, " ");
  else if (e === ".rtf")
    t = t
      .replace(/\\par[d]?/g, "\n")
      .replace(/\\'[0-9a-f]{2}/gi, "")
      .replace(/[{}]|\\[a-z]+-?\d* ?/gi, "");
  const cut = t.length > LIMITS.text.maxChars;
  return { text: cut ? t.slice(0, LIMITS.text.maxChars) : t, partial: cut };
}

// docx: paragraphs, headings as #; pptx: one "# Slide n" per slide; xlsx: one "# sheet" with rows joined by " | ".
async function readOffice(filePath) {
  const unzipper = require("unzipper");
  const dir = await unzipper.Open.file(filePath);
  const files = new Map(dir.files.map((f) => [f.path, f]));
  const MAX_ENTRY = 50 * 1024 * 1024; // a zip bomb must not inflate in the main process
  const read = async (p) =>
    files.has(p) && (files.get(p).uncompressedSize ?? 0) <= MAX_ENTRY
      ? (await files.get(p).buffer()).toString("utf8")
      : "";
  const names = (re) =>
    [...files.keys()]
      .filter((k) => re.test(k))
      .sort((a, b) => Number(a.match(/(\d+)\.xml$/)?.[1]) - Number(b.match(/(\d+)\.xml$/)?.[1]));
  const e = extOf(filePath);
  const out = [];

  if (e === ".docx") {
    const xml = await read("word/document.xml");
    for (const p of xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []) {
      const text = decode(
        (p.match(/<w:t[^>]*>[\s\S]*?<\/w:t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, "")).join("")
      );
      if (!text.trim()) continue;
      const h = /<w:pStyle w:val="(?:Heading|Title)(\d?)"/.exec(p);
      out.push(h ? `${"#".repeat(Math.min(6, Number(h[1] || 1)))} ${text}` : text, "");
    }
  } else if (e === ".pptx") {
    let n = 0;
    for (const name of names(/^ppt\/slides\/slide\d+\.xml$/)) {
      const xml = await read(name);
      const paras = (xml.match(/<a:p>[\s\S]*?<\/a:p>/g) ?? [])
        .map((p) =>
          decode(
            (p.match(/<a:t>[\s\S]*?<\/a:t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, "")).join("")
          )
        )
        .filter((t) => t.trim());
      out.push(`# Slide ${++n}`, ...paras, "");
    }
  } else if (e === ".xlsx") {
    const shared = ((await read("xl/sharedStrings.xml")).match(/<si>[\s\S]*?<\/si>/g) ?? []).map(
      (si) =>
        decode(
          (si.match(/<t[^>]*>[\s\S]*?<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, "")).join("")
        )
    );
    const wb = await read("xl/workbook.xml");
    const sheetNames = [...wb.matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => decode(m[1]));
    let i = 0;
    for (const name of names(/^xl\/worksheets\/sheet\d+\.xml$/)) {
      const xml = await read(name);
      out.push(`# ${sheetNames[i++] ?? `Sheet ${i}`}`);
      for (const row of xml.match(/<row[ >][\s\S]*?<\/row>/g) ?? []) {
        const cells = [...row.matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map(
          ([, attrs, inner = ""]) => {
            const v =
              /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ??
              /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner)?.[1] ??
              "";
            return /t="s"/.test(attrs) ? (shared[Number(v)] ?? "") : decode(v);
          }
        );
        if (cells.some((c) => String(c).trim())) out.push(cells.join(" | "));
      }
      out.push("");
    }
  }
  const text = out.join("\n").replace(/\n{3,}/g, "\n\n");
  const cut = text.length > LIMITS.office.maxChars;
  return { text: cut ? text.slice(0, LIMITS.office.maxChars) : text, partial: cut };
}

// A PDF cut into parts of `perPart` pages, so several can be read at once. [{ buf, from }] ; one part when short or unreadable.
async function splitPdf(buffer, perPart) {
  try {
    const { PDFDocument } = require("pdf-lib");
    const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const n = src.getPageCount();
    if (n <= perPart) return [{ buf: buffer, from: 1, pages: n }];
    const parts = [];
    for (let from = 0; from < n; from += perPart) {
      const doc = await PDFDocument.create();
      const idx = Array.from({ length: Math.min(perPart, n - from) }, (_, i) => from + i);
      (await doc.copyPages(src, idx)).forEach((p) => doc.addPage(p));
      parts.push({ buf: Buffer.from(await doc.save()), from: from + 1, pages: idx.length });
    }
    return parts;
  } catch {
    return [{ buf: buffer, from: 1, pages: null }];
  }
}

module.exports = { readText, readOffice, splitPdf, decode };
