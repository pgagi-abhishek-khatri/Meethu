// Splits text into pieces a search can return: about `chunkChars` long, cut at headings, blank lines and
// sentences (never mid-word), each remembering its heading and page. Pure.
const PAGE = /^\s*\[\[page\s+(\d+)\]\]\s*$/i;
const HEADING = /^(#{1,6})\s+(.+?)\s*$/;

// Longest piece first split by lines, then by sentences, then hard.
function splitLong(block, max) {
  if (block.length <= max) return [block];
  const out = [];
  let cur = "";
  const pieces = block.split(/(?<=[\n.!?;])\s+/);
  for (const p of pieces) {
    if (p.length > max) {
      if (cur) (out.push(cur), (cur = ""));
      for (let i = 0; i < p.length; i += max) out.push(p.slice(i, i + max));
      continue;
    }
    if (cur && cur.length + p.length + 1 > max) (out.push(cur), (cur = p));
    else cur = cur ? `${cur} ${p}` : p;
  }
  if (cur) out.push(cur);
  return out;
}

function chunkText(text, { target = 900, overlap = 120, min = 160 } = {}) {
  const clean = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\0/g, "")
    .replace(/[ \t]+\n/g, "\n");
  // First pass: blocks with the heading and page in force where each begins.
  const blocks = [];
  let heading = "";
  let page = null;
  let buf = [];
  const flush = () => {
    const t = buf.join("\n").trim();
    buf = [];
    if (t) blocks.push({ text: t, heading, page });
  };
  for (const line of clean.split("\n")) {
    const pm = PAGE.exec(line);
    if (pm) {
      flush();
      page = Number(pm[1]);
      continue;
    }
    const hm = HEADING.exec(line);
    if (hm) {
      flush();
      heading = hm[2].slice(0, 120);
      buf.push(line); // the heading line stays in the text, it is part of the passage
      continue;
    }
    if (!line.trim()) {
      if (!(buf.length === 1 && HEADING.test(buf[0]))) flush(); // a heading stays with the paragraph under it
    } else buf.push(line);
  }
  flush();

  // Second pass: pack blocks up to the target.
  const chunks = [];
  let cur = null;
  const push = () => {
    if (cur && cur.text.trim())
      chunks.push({ text: cur.text.trim(), heading: cur.heading, page: cur.page });
    cur = null;
  };
  for (const b of blocks) {
    for (const piece of splitLong(b.text, target)) {
      if (cur && (cur.text.length + piece.length + 2 > target || b.heading !== cur.heading)) {
        // a short tail is better joined to the next than left alone
        const tail = overlap && cur.text.length > overlap ? cur.text.slice(-overlap) : "";
        const sameHeading = b.heading === cur.heading;
        push();
        if (sameHeading && tail)
          cur = {
            text: tail.replace(/^\S*\s/, "") + "\n" + piece,
            heading: b.heading,
            page: b.page,
          };
      }
      if (!cur) cur = { text: piece, heading: b.heading, page: b.page };
      else if (!cur.text.endsWith(piece)) cur.text += "\n\n" + piece;
    }
  }
  push();
  // Fold slivers into their neighbour.
  const merged = [];
  for (const c of chunks) {
    const last = merged.at(-1);
    if (last && c.text.length < min && last.heading === c.heading) last.text += "\n\n" + c.text;
    else merged.push({ ...c });
  }
  return merged;
}

// Windows over a length in seconds: [{start, end}], the last short one folded into the previous.
function planWindows(duration, window, overlap = 0) {
  const out = [];
  if (!(duration > 0) || !(window > 0)) return out;
  const step = Math.max(1, window - overlap);
  for (let start = 0; start < duration; start += step) {
    out.push({ start, end: Math.min(duration, start + window) });
    if (start + window >= duration) break;
  }
  const last = out.at(-1);
  if (out.length > 1 && last.end - last.start < window * 0.25) {
    out.pop();
    out.at(-1).end = duration;
  }
  return out;
}

const mmss = (sec) => {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

module.exports = { chunkText, planWindows, mmss };
