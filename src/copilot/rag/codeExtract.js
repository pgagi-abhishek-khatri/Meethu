// src/copilot/rag/codeExtract.js
// Code-to-MD Context Engine & cAST Syntax-Aware Chunker.
// Converts source code into structured Markdown (.md) with symbol schemas,
// achieving parity with PDF extraction (Claude Code & Aider RepoMap architecture).
// Electron-free, zero-throw, high-performance CPU execution.

const path = require("path");

// Supported extensions for language-specific syntax awareness
const MAX_SIGNATURE_LINES = 8;
// Words that can precede `(...) {` without defining anything.
const NOT_METHOD = new Set([
  "if", "for", "while", "switch", "catch", "with", "return", "function", "else", "do", "try", "await", "typeof", "new", "super", "constructor",
]);

const LANGUAGE_MAP = {
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".sh": "bash",
  ".bash": "bash",
  ".sql": "sql",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
};

/**
 * Extracts language-specific structural elements:
 * - Module imports / dependencies
 * - Classes and interfaces
 * - Function signatures and methods
 * - Export statements
 * - Docstrings and top-level comments
 */
function extractCodeStructure(sourceCode, filename = "") {
  const ext = path.extname(filename).toLowerCase();
  const lang = LANGUAGE_MAP[ext] || "text";
  const lines = String(sourceCode || "").replace(/\r\n?/g, "\n").split("\n");

  const imports = [];
  const exportsList = [];
  const classes = [];
  const functions = [];
  let fileDoc = "";
  let insideMultiComment = false;
  let multiCommentBuf = [];

  // 1. First pass: Top-level file docstring extraction
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    const line = lines[i].trim();
    if (i === 0 && line.startsWith("#!")) continue; // shebang
    if (line.startsWith("/*") || line.startsWith("/**")) {
      insideMultiComment = true;
      multiCommentBuf.push(line.replace(/^\/\*\*?/, ""));
      if (line.includes("*/")) {
        insideMultiComment = false;
        fileDoc = multiCommentBuf.join(" ").replace(/\*\/$/, "").trim();
        break;
      }
      continue;
    }
    if (insideMultiComment) {
      multiCommentBuf.push(line.replace(/^\* ?/, ""));
      if (line.includes("*/")) {
        insideMultiComment = false;
        fileDoc = multiCommentBuf.join(" ").replace(/\*\/$/, "").trim();
        break;
      }
      continue;
    }
    if (line.startsWith("//") || (lang === "python" && line.startsWith("#"))) {
      fileDoc += (fileDoc ? " " : "") + line.replace(/^(\/\/|#) ?/, "").trim();
    } else if (line.length > 0 && !line.startsWith("import") && !line.startsWith("const") && !line.startsWith("require")) {
      break;
    }
  }

  // 2. Structural Line-by-Line Symbol Extraction
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const trimmed = line.trim();
    const lineNum = idx + 1;

    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#")) continue;

    // --- Imports ---
    // JS/TS: import ... from "..." or const ... = require("...")
    if (/^\s*(?:import\s+.+?\s+from\s+['"][^'"]+['"]|const\s+.+?=\s*require\(['"][^'"]+['"]\))/i.test(trimmed)) {
      imports.push(trimmed.replace(/;$/, ""));
    }
    // Python: import ... or from ... import ...
    else if (lang === "python" && /^\s*(?:from\s+[^\s]+\s+import\s+[^\s]+|import\s+[^\s]+)/.test(trimmed)) {
      imports.push(trimmed);
    }
    // Go: import (...)
    else if (lang === "go" && /^\s*import\s+['"][^'"]+['"]/.test(trimmed)) {
      imports.push(trimmed);
    }

    // --- Classes & Interfaces ---
    const classMatch = /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)(?:\s+extends\s+[A-Za-z0-9_$.]+)?(?:\s+implements\s+[A-Za-z0-9_$,\s]+)?/i.exec(trimmed);
    if (classMatch) {
      classes.push({ name: classMatch[1], line: lineNum, signature: trimmed.replace(/\{?$/, "").trim() });
      continue;
    }
    const interfaceMatch = /^\s*(?:export\s+)?interface\s+([A-Za-z0-9_$]+)(?:\s+extends\s+[A-Za-z0-9_$,\s]+)?/i.exec(trimmed);
    if (interfaceMatch) {
      classes.push({ name: interfaceMatch[1], kind: "interface", line: lineNum, signature: trimmed.replace(/\{?$/, "").trim() });
      continue;
    }
    if (lang === "python" && /^\s*class\s+([A-Za-z0-9_$]+)(?:\([^)]*\))?:/i.test(trimmed)) {
      const pyClassMatch = /^\s*class\s+([A-Za-z0-9_$]+)/.exec(trimmed);
      classes.push({ name: pyClassMatch[1], line: lineNum, signature: trimmed });
      continue;
    }

    // --- Functions & Methods ---
    // A signature may span lines: join up to MAX_SIGNATURE_LINES until its closing ")" so the name and parameters match.
    let defText = trimmed;
    if (
      /^(?:export\s+)?(?:default\s+)?(?:pub\s+)?(?:async\s+)?(?:function\b|def\b|func\b|fn\b)/.test(trimmed) &&
      trimmed.includes("(") &&
      !trimmed.slice(trimmed.indexOf("(")).includes(")")
    ) {
      const parts = [trimmed];
      for (let k = idx + 1; k < lines.length && k <= idx + MAX_SIGNATURE_LINES; k++) {
        parts.push(lines[k].trim());
        if (lines[k].includes(")")) break;
      }
      defText = parts.join(" ");
    }
    // JS/TS: function foo(...) or async function foo(...) or const foo = (...) =>
    const fnMatch = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(([^)]*)\)/i.exec(defText);
    if (fnMatch) {
      functions.push({ name: fnMatch[1], line: lineNum, signature: `${fnMatch[1]}(${fnMatch[2].trim()})` });
      continue;
    }
    const arrowMatch = /^\s*(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*(?::\s*[^=]+)?\s*=>/i.exec(trimmed);
    if (arrowMatch) {
      functions.push({ name: arrowMatch[1], line: lineNum, signature: `${arrowMatch[1]}(${arrowMatch[2].trim()})` });
      continue;
    }
    // JS/TS class and object methods: `name(args) {`, with modifiers; control flow keywords are not methods.
    if ((lang === "javascript" || lang === "typescript") && /^\s/.test(line)) {
      const m =
        /^\s+(?:(?:public|private|protected|static|async|override|readonly|abstract|get|set)\s+)*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(?::\s*[^{=]+)?\s*\{/.exec(
          line
        );
      if (m && !NOT_METHOD.has(m[1])) {
        functions.push({ name: m[1], line: lineNum, signature: `${m[1]}(${m[2].trim()})` });
        continue;
      }
    }
    // Python: def foo(...):
    if (lang === "python") {
      const pyFn = /^\s*(?:async\s+)?def\s+([A-Za-z0-9_$]+)\s*\(([^)]*)\)/.exec(defText);
      if (pyFn) {
        functions.push({ name: pyFn[1], line: lineNum, signature: `${pyFn[1]}(${pyFn[2].trim()})` });
        continue;
      }
    }
    // Go: func foo(...)
    if (lang === "go") {
      const goFn = /^\s*func\s+(?:\([^)]+\)\s+)?([A-Za-z0-9_$]+)\s*\(([^)]*)\)/.exec(defText);
      if (goFn) {
        functions.push({ name: goFn[1], line: lineNum, signature: `${goFn[1]}(${goFn[2].trim()})` });
        continue;
      }
    }
    // Rust: fn foo(...)
    if (lang === "rust") {
      const rsFn = /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_$]+)\s*(?:<[^>]+>)?\s*\(([^)]*)\)/.exec(defText);
      if (rsFn) {
        functions.push({ name: rsFn[1], line: lineNum, signature: `${rsFn[1]}(${rsFn[2].trim()})` });
        continue;
      }
    }

    // --- Exports ---
    if (/^\s*(?:module\.exports\s*=|export\s+(?:default\s+)?|exports\.[A-Za-z0-9_$]+\s*=)/i.test(trimmed)) {
      exportsList.push(trimmed.replace(/;$/, ""));
    }
  }

  return {
    language: lang,
    filename: path.basename(filename || "code"),
    filepath: filename,
    fileDoc: fileDoc.trim(),
    totalLines: lines.length,
    imports,
    classes,
    functions,
    exportsList,
  };
}

/**
 * Converts source code into clean, structured Markdown (.md) representation
 * (Claude Code format & parity with PDF extract output).
 */
function convertCodeToMarkdown(sourceCode, filename = "") {
  const structure = extractCodeStructure(sourceCode, filename);
  const out = [];

  out.push(`# Module: ${structure.filename}`);
  if (structure.fileDoc) {
    out.push(`> ${structure.fileDoc}\n`);
  }
  out.push(`- **Language**: \`${structure.language}\``);
  out.push(`- **Total Lines**: ${structure.totalLines}`);

  if (structure.exportsList.length > 0) {
    out.push(`\n## Exports`);
    for (const exp of structure.exportsList.slice(0, 15)) {
      out.push(`- \`${exp.length > 90 ? exp.slice(0, 87) + "..." : exp}\``);
    }
  }

  if (structure.classes.length > 0) {
    out.push(`\n## Classes & Types`);
    for (const cls of structure.classes) {
      out.push(`- \`${cls.signature}\` (line ${cls.line})`);
    }
  }

  if (structure.functions.length > 0) {
    out.push(`\n## Function Signatures`);
    for (const fn of structure.functions) {
      out.push(`- \`${fn.signature}\` (line ${fn.line})`);
    }
  }

  if (structure.imports.length > 0) {
    out.push(`\n## Dependencies`);
    for (const imp of structure.imports.slice(0, 20)) {
      out.push(`- \`${imp.length > 90 ? imp.slice(0, 87) + "..." : imp}\``);
    }
  }

  return out.join("\n");
}

/**
 * cAST: Syntax-Aware AST Chunker (Carnegie Mellon / Augment Code Architecture).
 * Chunks source code at function, class, and statement boundaries rather than
 * arbitrary character cuts, ensuring zero broken function declarations.
 */
function chunkCodeAst(sourceCode, filename = "", { targetChars = 900, minChars = 160 } = {}) {
  const clean = String(sourceCode || "").replace(/\r\n?/g, "\n");
  const lines = clean.split("\n");
  const structure = extractCodeStructure(sourceCode, filename);
  const chunks = [];

  // Determine boundary points (lines where classes and functions begin)
  const boundaryLines = new Set([
    ...structure.classes.map((c) => c.line - 1),
    ...structure.functions.map((f) => f.line - 1),
  ]);

  let currentChunkLines = [];
  let currentBufChars = 0;
  let currentSymbol = structure.filename;
  let chunkStartLine = 1;
  let braceDepth = 0;
  let chunkEntryDepth = 0;
  let chunkEntryIndent = 0;
  const isPython = structure.language === "python";

  const symbolAtLine = new Map();
  for (const c of structure.classes) {
    if (!symbolAtLine.has(c.line - 1)) symbolAtLine.set(c.line - 1, c.name);
  }
  for (const f of structure.functions) {
    if (!symbolAtLine.has(f.line - 1)) symbolAtLine.set(f.line - 1, f.name);
  }

  const countBraces = (text) => {
    let delta = 0;
    let quote = null;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === "\\" && i + 1 < text.length) {
          i++;
          continue;
        }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "/" && text[i + 1] === "/") break;
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        continue;
      }
      if (ch === "{") delta++;
      else if (ch === "}") delta--;
    }
    return delta;
  };

  const flush = (nextSymbol = "") => {
    if (currentChunkLines.length === 0) {
      if (nextSymbol) currentSymbol = nextSymbol;
      return;
    }
    const startLine = chunkStartLine;
    const endLine = startLine + currentChunkLines.length - 1;
    const text = currentChunkLines.join("\n").trim();
    if (text.length >= minChars || boundaryLines.size === 0) {
      chunks.push({
        text: `// [[symbol: ${currentSymbol} in ${path.basename(filename)} (L${startLine}-L${endLine})]]\n` + text,
        meta: {
          heading: currentSymbol,
          page: startLine,
          endLine,
          filename: path.basename(filename),
          kind: "code",
        },
      });
    }
    currentChunkLines = [];
    currentBufChars = 0;
    if (nextSymbol) currentSymbol = nextSymbol;
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const trimmed = line.trim();
    const isBoundary = boundaryLines.has(idx);
    const indentMatch = line.search(/\S/);
    const lineIndent = indentMatch === -1 ? chunkEntryIndent : indentMatch;

    if (isBoundary && currentChunkLines.length > 0) {
      const atOuterScope = isPython ? lineIndent <= chunkEntryIndent : braceDepth <= chunkEntryDepth;
      if (currentBufChars >= targetChars * 0.65 || (atOuterScope && currentBufChars >= minChars)) {
        flush(symbolAtLine.get(idx) || structure.filename);
      }
    }

    if (currentChunkLines.length === 0) {
      chunkStartLine = idx + 1;
      chunkEntryDepth = braceDepth;
      chunkEntryIndent = indentMatch === -1 ? 0 : indentMatch;
      if (symbolAtLine.has(idx)) {
        currentSymbol = symbolAtLine.get(idx);
      }
    }

    currentChunkLines.push(line);
    currentBufChars += line.length + 1;

    if (!isPython) {
      braceDepth = Math.max(0, braceDepth + countBraces(line));
    }

    if (currentBufChars >= targetChars) {
      const nextLine = idx + 1 < lines.length ? lines[idx + 1] : "";
      const nextNonEmpty = nextLine.trim();
      const nextIndent = nextLine.search(/\S/);
      const closedPythonBlock =
        isPython && nextNonEmpty.length > 0 && nextIndent !== -1 && nextIndent <= chunkEntryIndent;
      const closedBraceBlock = !isPython && braceDepth <= chunkEntryDepth && trimmed.endsWith("}");
      const hardCapReached = currentBufChars >= targetChars * 1.8;

      if (
        closedBraceBlock ||
        closedPythonBlock ||
        hardCapReached ||
        (braceDepth <= chunkEntryDepth && (trimmed.endsWith(";") || (isPython && trimmed.endsWith(":"))))
      ) {
        flush(currentSymbol);
      }
    }
  }

  flush(currentSymbol);

  // If no syntax boundaries matched, fallback to single clean chunk
  if (chunks.length === 0 && clean.trim()) {
    chunks.push({
      text: clean.slice(0, targetChars * 2),
      meta: {
        heading: structure.filename,
        page: 1,
        endLine: lines.length,
        filename: path.basename(filename),
        kind: "code",
      },
    });
  }

  return chunks;
}

module.exports = {
  LANGUAGE_MAP,
  extractCodeStructure,
  convertCodeToMarkdown,
  chunkCodeAst,
};
