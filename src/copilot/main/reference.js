// Text of the files in the ticked projects, for the main model. No search yet (RAG comes later): small
// text files are inlined, the first part of each, within one shared budget. PDF/DOCX are listed but not read.
const fs = require("fs");
const { ANSWER_BUDGET } = require("../config/budgets");

const TEXT = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".tsv",
  ".json",
  ".log",
  ".yaml",
  ".yml",
  ".html",
  ".xml",
]);
const ext = (p) => (p.match(/\.[^./\\]+$/)?.[0] ?? "").toLowerCase();

// files: [{path, name}]. Returns one string, each file under its own header.
function readReference(files, { budget = ANSWER_BUDGET.reference, read = null } = {}) {
  const readable = files.filter((f) => TEXT.has(ext(f.path)));
  if (!readable.length) return "";
  const each = Math.floor(budget / readable.length);
  // Only the first part of a file is needed: never load a huge log whole, on every card.
  const head = (p) => {
    const fd = fs.openSync(p, "r");
    try {
      const buf = Buffer.alloc(each * 4 + 16);
      return buf.toString("utf8", 0, fs.readSync(fd, buf, 0, buf.length, 0));
    } finally {
      fs.closeSync(fd);
    }
  };
  const readIt = read ?? head;
  const parts = [];
  for (const f of readable) {
    try {
      const text = readIt(f.path).replace(/\0/g, "").trim();
      if (text)
        parts.push(`FILE ${f.name}\n${text.length > each ? `${text.slice(0, each)} [cut]` : text}`);
    } catch {}
  }
  return parts.join("\n\n");
}

module.exports = { readReference, TEXT_EXTENSIONS: TEXT };
