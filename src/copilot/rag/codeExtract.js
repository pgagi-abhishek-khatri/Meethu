// src/copilot/rag/codeExtract.js
// Code-to-MD Context Engine & cAST Syntax-Aware Chunker.
// Extracts file roles, factual purpose, exported symbols with Lstart-Lend ranges,
// internal vs external imports, cross-boundary calls ("Talks to"), and thin pass-through detection.

const path = require("path");

let tsCompiler = null;
try {
  tsCompiler = require("typescript");
} catch {
  tsCompiler = null;
}

const MAX_SIGNATURE_LINES = 8;
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
  ".cc": "cpp",
  ".cxx": "cpp",
  ".cpp": "cpp",
  ".h": "c",
  ".hh": "cpp",
  ".hpp": "cpp",
  ".swift": "swift",
  ".m": "objc",
  ".mm": "objcpp",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".java": "java",
  ".cs": "csharp",
  ".rb": "ruby",
  ".php": "php",
  ".dart": "dart",
  ".scala": "scala",
  ".ex": "elixir",
  ".exs": "elixir",
  ".sh": "bash",
  ".bash": "bash",
  ".sql": "sql",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".prisma": "prisma",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".vue": "vue",
  ".svelte": "svelte",
  ".astro": "astro",
};

function stripParamComments(raw) {
  return String(raw || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitTopLevelParams(raw) {
  const s = stripParamComments(raw);
  if (!s) return [];
  const out = [];
  let cur = "";
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let angle = 0;
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      cur += ch;
      if (ch === "\\" && i + 1 < s.length) { cur += s[++i]; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; cur += ch; continue; }
    if (ch === "(") paren++;
    else if (ch === ")" && paren > 0) paren--;
    else if (ch === "[") bracket++;
    else if (ch === "]" && bracket > 0) bracket--;
    else if (ch === "{") brace++;
    else if (ch === "}" && brace > 0) brace--;
    else if (ch === "<") angle++;
    else if (ch === ">" && angle > 0 && s[i - 1] !== "=") angle--;
    else if (ch === "," && paren === 0 && bracket === 0 && brace === 0 && angle === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function stripTopLevelTypeAndDefault(param) {
  let s = param.replace(/^(?:private|public|protected|readonly)\s+/, "").trim();
  // Condense destructured object params `{ a, b = 1, c }` -> `{ a, b, ... }`
  if (s.startsWith("{")) {
    let endBrace = -1;
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "{") depth++;
      else if (s[i] === "}" && --depth === 0) { endBrace = i; break; }
    }
    if (endBrace > 0) {
      const inner = splitTopLevelParams(s.slice(1, endBrace)).map((k) => k.split(/[:=]/)[0].trim()).filter(Boolean);
      const body = inner.length > 3 ? `${inner.slice(0, 3).join(", ")}, …` : inner.join(", ");
      return `{ ${body} }`;
    }
  }
  // Cut `: Type` or `= default` ONLY at depth 0
  let paren = 0, bracket = 0, brace = 0, angle = 0;
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\" && i + 1 < s.length) { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
    if (ch === "(") paren++;
    else if (ch === ")" && paren > 0) paren--;
    else if (ch === "[") bracket++;
    else if (ch === "]" && bracket > 0) bracket--;
    else if (ch === "{") brace++;
    else if (ch === "}" && brace > 0) brace--;
    else if (ch === "<") angle++;
    else if (ch === ">" && angle > 0 && s[i - 1] !== "=") angle--;
    else if (paren === 0 && bracket === 0 && brace === 0 && angle === 0 && (ch === ":" || ch === "=")) {
      return s.slice(0, i).trim();
    }
  }
  return s;
}

/**
 * Shortens a function signature cleanly without cutting mid-token or inside destructuring/generics:
 * strips comments and drops TypeScript/Python type annotations and defaults before anything else.
 */
function shortenSignature(name, rawParams = "", maxLen = 72) {
  const cleanParams = stripParamComments(rawParams);
  const full = `${name}(${cleanParams})`;
  if (full.length <= maxLen) return full;

  const rawList = splitTopLevelParams(cleanParams);
  const params = rawList.map(stripTopLevelTypeAndDefault).filter(Boolean);

  const compact = `${name}(${params.join(", ")})`;
  if (compact.length <= maxLen) return compact;

  const kept = [];
  for (const p of params) {
    const candidate = `${name}(${[...kept, p, "…"].join(", ")})`;
    if (candidate.length > maxLen && kept.length > 0) break;
    kept.push(p);
  }
  return kept.length < params.length ? `${name}(${kept.join(", ")}, …)` : `${name}(${kept.join(", ")})`;
}

function classifyFileRole(relPath, structure = {}, sourceCode = "") {
  const norm = String(relPath || "").replace(/\\/g, "/").toLowerCase();
  const base = path.basename(norm);

  if (/\.(?:test|spec)\.[^.]+$/.test(base) || /(?:^|\/)(?:tests?|__tests__)\//.test(norm)) return "test";
  if (/(?:^|\/)(?:migrations?|alembic\/versions)\//.test(norm)) return "migration";
  if (/(?:^|\/)scripts?\//.test(norm)) return "script";
  if (/(?:^|\/)(?:cli|bin)\//.test(norm) || /^#!/.test(String(sourceCode || ""))) return "CLI";
  if (/\.d\.ts$/.test(base) || /(?:^|\/)(?:types?|schemas?|interfaces?)\//.test(norm)) return "type definitions";
  if (/(?:^|\/)(?:models?|entities|db\/schema)\//.test(norm) || base.endsWith(".prisma") || base.endsWith(".sql")) return "model/schema";
  if (/(?:^|\/)(?:stores?|state|redux|zustand)\//.test(norm) || /store\.(?:ts|js)$/i.test(base)) return "state store";
  if (/(?:^|\/)(?:middleware|interceptors?|guards?)\//.test(norm)) return "middleware";
  if (/(?:^|\/)(?:jobs?|workers?|queues?|cron)\//.test(norm)) return "job/worker";
  if (/(?:^|\/)(?:routes?|pages?|app\/.*\/page|screens?|views?|routers?|endpoints?)\//.test(norm)) return "route/page";
  if (/(?:^|\/)(?:hooks?|controllers?|handlers?)\//.test(norm) || /^use[A-Z]/.test(path.basename(relPath || ""))) return "hook/controller";
  if (/(?:^|\/)(?:services?|api|clients?|connectors?|adapters?|sdk)\//.test(norm) || /(?:service|client|api)\./i.test(base)) return "service/API client";
  if (/(?:^|\/)(?:components?|ui|widgets?)\//.test(norm) || base.endsWith(".tsx") || base.endsWith(".jsx") || base.endsWith(".vue") || base.endsWith(".svelte")) return "UI component";
  if (/^(?:main|index|app|server|cli)\.(?:js|ts|jsx|tsx|py|go|rs)$/.test(base)) return "entry point";
  if (/(?:config|settings)\.[^.]+$/.test(base) || /(?:^|\/)config\//.test(norm)) return "config";
  if ((structure.classes?.length || 0) === 0 && (structure.functions?.length || 0) === 0 && (structure.types?.length || 0) > 0) return "type definitions";
  return "utility";
}

function classifyImportTarget(spec) {
  const s = String(spec || "").trim();
  if (!s) return { kind: "external", target: "" };
  if (s.startsWith(".") || s.startsWith("@/") || s.startsWith("~/") || s.startsWith("app/") || s.startsWith("src/")) {
    return { kind: "internal", target: s };
  }
  const pkgName = s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.split("/")[0];
  return { kind: "external", target: pkgName };
}

function extractTalksTo(sourceCode) {
  const src = String(sourceCode || "");
  const httpCalls = new Set();
  const events = new Set();
  const eventEntries = [];
  const tables = new Set();
  const envVars = new Set();
  const flags = new Set();
  const lineOfIdx = (idx) => src.slice(0, idx).split("\n").length;

  // HTTP / fetch / axios calls
  const httpRe = /(?:fetch|axios\.(?:get|post|put|patch|delete)|api(?:Client)?\.(?:get|post|put|patch|delete)|(?:router|app)\.(?:get|post|put|patch|delete))\(\s*['"`]([^'"`\n]{2,100})['"`]/gi;
  let m;
  while ((m = httpRe.exec(src)) !== null) httpCalls.add(m[1]);

  // Electron IPC & EventEmitter channels
  const ipcRe = /(?:ipcMain\.handle|ipcMain\.on|ipcRenderer\.invoke|ipcRenderer\.send|ipcRenderer\.on|webContents\.send|\bemit)\(\s*['"`]([a-zA-Z0-9_.:/-]{2,80})['"`]/g;
  while ((m = ipcRe.exec(src)) !== null) {
    if (!events.has(m[1])) eventEntries.push({ name: m[1], line: lineOfIdx(m.index) });
    events.add(m[1]);
  }

  // SQL table names
  const sqlRe = /\b(?:FROM|INTO|UPDATE|CREATE TABLE(?:\s+IF NOT EXISTS)?)\s+([a-zA-Z_][a-zA-Z0-9_]{1,50})\b/gi;
  while ((m = sqlRe.exec(src)) !== null) {
    const tbl = m[1].toLowerCase();
    if (!["select", "where", "values", "set"].includes(tbl)) tables.add(m[1]);
  }

  // Env vars (names only, never values)
  const envRe = /(?:process\.env\.([A-Z0-9_]{2,60})|os\.(?:getenv|environ\.get)\(\s*['"]([A-Z0-9_]{2,60})['"])/g;
  while ((m = envRe.exec(src)) !== null) envVars.add(m[1] || m[2]);

  // Feature flags
  const flagRe = /(?:isFeatureEnabled|hasFeature|featureFlag|useFlag|flags?)\(\s*['"]([a-zA-Z0-9_.-]{2,60})['"]/g;
  while ((m = flagRe.exec(src)) !== null) flags.add(m[1]);

  return {
    httpCalls: [...httpCalls].slice(0, 12),
    events: [...events].slice(0, 12),
    eventEntries: eventEntries.slice(0, 12),
    tables: [...tables].slice(0, 12),
    envVars: [...envVars].slice(0, 15),
    flags: [...flags].slice(0, 10),
  };
}

const NOISY_LEAD_DOC_RE = /^(?:eslint|@ts-|Copyright|Licensed|SPDX|TODO|FIXME|HACK|prettier-ignore|A\s+span\b|<[a-z]+>|Split\s+query|Note:)/i;

function extractLeadingDoc(lines, lang) {
  let fileDoc = "";
  let insideMultiComment = false;
  const multiCommentBuf = [];

  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    const line = lines[i].trim();
    if (i === 0 && line.startsWith("#!")) continue;
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
  const clean = fileDoc.replace(/\s+/g, " ").trim();
  if (!clean || NOISY_LEAD_DOC_RE.test(clean) || /^[a-z]/.test(clean) || /\b(?:span|div|inline-block)\b|<\/?[a-z]+>/i.test(clean)) return "";
  return clean;
}

function synthesizeFilePurpose(filename, struct) {
  const base = path.basename(filename || struct.filename || "module", path.extname(filename || ""));
  const role = struct.role || "module";
  const expClasses = (struct.classes || []).filter((c) => c.exported !== false).slice(0, 2).map((c) => c.name);
  const expFns = (struct.functions || []).filter((f) => f.exported !== false).slice(0, 3).map((f) => f.name);
  const expTypes = (struct.types || []).filter((t) => t.exported !== false).slice(0, 2).map((t) => t.name);
  const syms = [...expClasses, ...expFns, ...expTypes].slice(0, 3);
  const talks = [];
  if (struct.talksTo?.httpCalls?.length) talks.push(`calls ${struct.talksTo.httpCalls.slice(0, 2).join(", ")}`);
  if (struct.talksTo?.events?.length) talks.push(`IPC/events ${struct.talksTo.events.slice(0, 2).join(", ")}`);
  if (struct.talksTo?.tables?.length) talks.push(`tables ${struct.talksTo.tables.slice(0, 2).join(", ")}`);

  if (syms.length > 0 || talks.length > 0) {
    const symPart = syms.length ? `providing ${syms.join(", ")}` : "";
    const talkPart = talks.length ? `${symPart ? "; " : ""}${talks.join("; ")}` : "";
    return `${role[0].toUpperCase()}${role.slice(1)} (${base}) ${symPart}${talkPart}.`.replace(/\s+/g, " ").trim();
  }
  if (struct.internalImports?.length) {
    return `${role[0].toUpperCase()}${role.slice(1)} (${base}) wiring ${struct.internalImports.slice(0, 2).map((p) => path.basename(p)).join(", ")}.`;
  }
  return `${role} in ${path.dirname(filename || ".")}.`;
}

function computeBraceEndLines(lines) {
  // Helper for estimating block end lines when falling back to regex parsing
  return function findEndLine(startIdx, isPython) {
    if (isPython) {
      const baseIndent = lines[startIdx].search(/\S/);
      let end = startIdx + 1;
      for (let j = startIdx + 1; j < lines.length; j++) {
        const trimmed = lines[j].trim();
        if (!trimmed) continue;
        const indent = lines[j].search(/\S/);
        if (indent <= baseIndent) break;
        end = j + 1;
      }
      return end;
    }
    let depth = 0;
    let opened = false;
    for (let j = startIdx; j < lines.length; j++) {
      const text = lines[j];
      let quote = null;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
          if (ch === "\\" && i + 1 < text.length) { i++; continue; }
          if (ch === quote) quote = null;
          continue;
        }
        if (ch === "/" && text[i + 1] === "/") break;
        if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
        if (ch === "{") { depth++; opened = true; }
        else if (ch === "}") {
          depth--;
          if (opened && depth <= 0) return j + 1;
        }
      }
      if (!opened && text.trim().endsWith(";")) return j + 1;
    }
    return startIdx + 1;
  };
}

function extractJsTsWithCompiler(sourceCode, filename, lang) {
  if (!tsCompiler) return null;
  try {
    const scriptKind =
      filename.endsWith(".tsx")
        ? tsCompiler.ScriptKind.TSX
        : filename.endsWith(".jsx")
          ? tsCompiler.ScriptKind.JSX
          : lang === "typescript"
            ? tsCompiler.ScriptKind.TS
            : tsCompiler.ScriptKind.JS;
    const sf = tsCompiler.createSourceFile(
      filename || "file.ts",
      sourceCode,
      tsCompiler.ScriptTarget.Latest,
      true,
      scriptKind
    );
    const parseStatus = sf.parseDiagnostics?.length > 0 ? "partial" : "full";
    const lines = sourceCode.split("\n");
    const imports = [];
    const internalImports = [];
    const externalPackages = [];
    const exportsList = [];
    const classes = [];
    const functions = [];
    const types = [];
    const constants = [];

    const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
    const hasExportMod = (node) =>
      Boolean(
        tsCompiler.canHaveModifiers?.(node) &&
          tsCompiler.getModifiers?.(node)?.some((m) => m.kind === tsCompiler.SyntaxKind.ExportKeyword)
      );

    // Track CommonJS exports
    const cjsExported = new Set();
    const visitTop = (node) => {
      if (tsCompiler.isImportDeclaration(node) && tsCompiler.isStringLiteral(node.moduleSpecifier)) {
        const raw = node.getText(sf).replace(/;$/, "");
        imports.push(raw);
        const cls = classifyImportTarget(node.moduleSpecifier.text);
        if (cls.kind === "internal") internalImports.push(cls.target);
        else if (cls.target) externalPackages.push(cls.target);
      } else if (tsCompiler.isExportDeclaration(node)) {
        exportsList.push(node.getText(sf).replace(/;$/, ""));
        if (node.moduleSpecifier && tsCompiler.isStringLiteral(node.moduleSpecifier)) {
          const cls = classifyImportTarget(node.moduleSpecifier.text);
          if (cls.kind === "internal") internalImports.push(cls.target);
          else if (cls.target) externalPackages.push(cls.target);
        }
      } else if (tsCompiler.isExportAssignment(node)) {
        exportsList.push(node.getText(sf).replace(/;$/, ""));
      } else if (tsCompiler.isClassDeclaration(node) && node.name) {
        const line = lineOf(node.getStart(sf));
        const endLine = lineOf(node.getEnd());
        const sig = sourceCode.slice(node.getStart(sf), node.name.getEnd()).replace(/\s+/g, " ").trim();
        const isExp = hasExportMod(node);
        classes.push({ name: node.name.text, line, endLine, exported: isExp, signature: sig });
        if (isExp) exportsList.push(`export class ${node.name.text}`);
        for (const member of node.members) {
          if (
            (tsCompiler.isMethodDeclaration(member) ||
              tsCompiler.isGetAccessorDeclaration(member) ||
              tsCompiler.isSetAccessorDeclaration(member)) &&
            member.name
          ) {
            const mName = member.name.getText(sf);
            const mLine = lineOf(member.getStart(sf));
            const mEnd = lineOf(member.getEnd());
            const params = (member.parameters || []).map((p) => stripParamComments(p.getText(sf))).join(", ");
            functions.push({
              name: mName,
              line: mLine,
              endLine: mEnd,
              exported: isExp,
              isMethod: true,
              signature: `${mName}(${params})`,
            });
          }
        }
      } else if (tsCompiler.isInterfaceDeclaration(node)) {
        const line = lineOf(node.getStart(sf));
        const endLine = lineOf(node.getEnd());
        const isExp = hasExportMod(node);
        classes.push({ name: node.name.text, kind: "interface", line, endLine, exported: isExp, signature: `interface ${node.name.text}` });
        types.push({ name: node.name.text, kind: "interface", line, endLine, exported: isExp });
      } else if (tsCompiler.isTypeAliasDeclaration(node)) {
        const line = lineOf(node.getStart(sf));
        const endLine = lineOf(node.getEnd());
        const isExp = hasExportMod(node);
        types.push({ name: node.name.text, kind: "type", line, endLine, exported: isExp });
        if (isExp) exportsList.push(`export type ${node.name.text}`);
      } else if (tsCompiler.isFunctionDeclaration(node) && node.name) {
        const line = lineOf(node.getStart(sf));
        const endLine = lineOf(node.getEnd());
        const isExp = hasExportMod(node);
        const params = (node.parameters || []).map((p) => stripParamComments(p.getText(sf))).join(", ");
        functions.push({
          name: node.name.text,
          line,
          endLine,
          exported: isExp,
          signature: `${node.name.text}(${params})`,
        });
        if (isExp) exportsList.push(`export function ${node.name.text}`);
      } else if (tsCompiler.isVariableStatement(node)) {
        const isExp = hasExportMod(node);
        for (const decl of node.declarationList.declarations) {
          if (!tsCompiler.isIdentifier(decl.name)) continue;
          const vName = decl.name.text;
          const line = lineOf(decl.getStart(sf));
          const endLine = lineOf(decl.getEnd());
          const init = decl.initializer;
          if (init && tsCompiler.isCallExpression(init) && init.expression.getText(sf) === "require" && init.arguments.length === 1 && tsCompiler.isStringLiteral(init.arguments[0])) {
            imports.push(node.getText(sf).replace(/;$/, ""));
            const cls = classifyImportTarget(init.arguments[0].text);
            if (cls.kind === "internal") internalImports.push(cls.target);
            else if (cls.target) externalPackages.push(cls.target);
            continue;
          }
          if (init && (tsCompiler.isArrowFunction(init) || tsCompiler.isFunctionExpression(init))) {
            const params = (init.parameters || []).map((p) => stripParamComments(p.getText(sf))).join(", ");
            functions.push({
              name: vName,
              line,
              endLine,
              exported: isExp,
              signature: `${vName}(${params})`,
            });
            if (isExp) exportsList.push(`export const ${vName}`);
          } else if (init && tsCompiler.isObjectLiteralExpression(init)) {
            if (isExp || /^[A-Z0-9_]{3,}$/.test(vName)) {
              constants.push({ name: vName, kind: "const", line, endLine, exported: isExp });
            }
            for (const prop of init.properties) {
              if ((tsCompiler.isMethodDeclaration(prop) || (tsCompiler.isPropertyAssignment(prop) && (tsCompiler.isArrowFunction(prop.initializer) || tsCompiler.isFunctionExpression(prop.initializer)))) && prop.name) {
                const fnNode = tsCompiler.isMethodDeclaration(prop) ? prop : prop.initializer;
                const mName = prop.name.getText(sf);
                const params = (fnNode.parameters || []).map((p) => p.getText(sf)).join(", ");
                functions.push({
                  name: mName,
                  line: lineOf(prop.getStart(sf)),
                  endLine: lineOf(prop.getEnd()),
                  exported: isExp,
                  isMethod: true,
                  signature: `${mName}(${params})`,
                });
              }
            }
          } else if (isExp || /^[A-Z][A-Z0-9_]{2,}$/.test(vName)) {
            constants.push({ name: vName, kind: "const", line, endLine, exported: isExp });
            if (isExp) exportsList.push(`export const ${vName}`);
          }
        }
      } else if (tsCompiler.isExpressionStatement(node) && tsCompiler.isBinaryExpression(node.expression)) {
        const left = node.expression.left.getText(sf);
        if (left === "module.exports" || left.startsWith("exports.")) {
          exportsList.push(node.getText(sf).replace(/;$/, ""));
          const right = node.expression.right;
          if (tsCompiler.isObjectLiteralExpression(right)) {
            for (const p of right.properties) {
              if (tsCompiler.isShorthandPropertyAssignment(p)) cjsExported.add(p.name.text);
              else if (tsCompiler.isPropertyAssignment(p) && p.name) cjsExported.add(p.name.getText(sf));
            }
          } else if (tsCompiler.isIdentifier(right)) {
            cjsExported.add(right.text);
          }
        }
      }
    };

    for (const st of sf.statements) visitTop(st);
    for (const f of functions) if (cjsExported.has(f.name)) f.exported = true;
    for (const c of classes) if (cjsExported.has(c.name)) c.exported = true;
    for (const k of constants) if (cjsExported.has(k.name)) k.exported = true;

    const fileDoc = extractLeadingDoc(lines, lang);
    const talksTo = extractTalksTo(sourceCode);
    const isThinPassthrough =
      lines.length <= 25 &&
      functions.length === 0 &&
      classes.length === 0 &&
      exportsList.length > 0 &&
      internalImports.length > 0;

    return {
      language: lang,
      filename: path.basename(filename || "code"),
      filepath: filename,
      fileDoc,
      purpose: fileDoc ? fileDoc.split(/(?<=[.!?])\s+/)[0] : "",
      totalLines: lines.length,
      parseStatus,
      imports,
      internalImports: [...new Set(internalImports)],
      externalPackages: [...new Set(externalPackages)],
      classes,
      functions,
      types,
      constants,
      exportsList,
      talksTo,
      isThinPassthrough,
    };
  } catch {
    return null;
  }
}

/**
 * Extracts structural elements from source code:
 * - Module imports / internal vs external dependencies
 * - Classes, interfaces, types, constants
 * - Functions and methods with Lstart-Lend ranges
 * - Export statements, Talks-to cross-boundary calls, role & purpose
 */
function extractCodeStructure(sourceCode, filename = "") {
  const ext = path.extname(filename).toLowerCase();
  const lang = LANGUAGE_MAP[ext] || "text";
  const cleanSource = String(sourceCode || "").replace(/\r\n?/g, "\n");

  if (lang === "javascript" || lang === "typescript") {
    const astResult = extractJsTsWithCompiler(cleanSource, filename, lang);
    if (astResult) {
      astResult.role = classifyFileRole(filename, astResult, cleanSource);
      if (!astResult.purpose) astResult.purpose = synthesizeFilePurpose(filename, astResult);
      return astResult;
    }
  }

  const lines = cleanSource.split("\n");
  const findEndLine = computeBraceEndLines(lines);
  const imports = [];
  const internalImports = [];
  const externalPackages = [];
  const exportsList = [];
  const classes = [];
  const functions = [];
  const types = [];
  const constants = [];
  const fileDoc = extractLeadingDoc(lines, lang);
  const isPython = lang === "python";

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const trimmed = line.trim();
    const lineNum = idx + 1;
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#")) continue;

    // Imports
    if (/^\s*(?:import\s+.+?\s+from\s+['"][^'"]+['"]|const\s+.+?=\s*require\(['"][^'"]+['"]\))/i.test(trimmed)) {
      imports.push(trimmed.replace(/;$/, ""));
      const spec = /['"]([^'"]+)['"]/.exec(trimmed)?.[1];
      if (spec) {
        const cls = classifyImportTarget(spec);
        if (cls.kind === "internal") internalImports.push(cls.target);
        else if (cls.target) externalPackages.push(cls.target);
      }
    } else if (isPython && /^\s*(?:from\s+[^\s]+\s+import\s+[^\s]+|import\s+[^\s]+)/.test(trimmed)) {
      imports.push(trimmed);
      const pyFrom = /^from\s+([A-Za-z0-9_.]+)\s+import/.exec(trimmed);
      const pyImp = /^import\s+([A-Za-z0-9_.]+)/.exec(trimmed);
      const spec = pyFrom?.[1] || pyImp?.[1] || "";
      if (spec.startsWith(".") || spec.startsWith("app.") || spec.startsWith("src.")) {
        internalImports.push(spec);
      } else if (spec) {
        externalPackages.push(spec.split(".")[0]);
      }
    } else if (lang === "go" && /^\s*import\s+['"][^'"]+['"]/.test(trimmed)) {
      imports.push(trimmed);
    } else if ((lang === "swift" || lang === "kotlin" || lang === "java") && /^\s*import\s+([A-Za-z0-9_.*]+)/.test(trimmed)) {
      const imp = /^\s*import\s+([A-Za-z0-9_.*]+)/.exec(trimmed)[1];
      imports.push(trimmed);
      externalPackages.push(imp.split(".")[0]);
    } else if ((lang === "objc" || lang === "objcpp" || lang === "c" || lang === "cpp") && /^\s*#(?:import|include)\s+["<]([^">]+)[">]/.test(trimmed)) {
      const hm = /^\s*#(?:import|include)\s+(["<])([^">]+)[">]/.exec(trimmed);
      imports.push(trimmed);
      if (hm[1] === '"') internalImports.push(hm[2]);
      else externalPackages.push(hm[2].split("/")[0]);
    } else if (lang === "ruby" && /^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/.test(trimmed)) {
      const rm = /^\s*require(_relative)?\s+['"]([^'"]+)['"]/.exec(trimmed);
      imports.push(trimmed);
      if (rm[1]) internalImports.push(rm[2]);
      else externalPackages.push(rm[2].split("/")[0]);
    }

    // Classes, Interfaces, Swift/ObjC/Kotlin/Java/C++/Ruby/PHP types
    const classMatch = /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+|public\s+|private\s+|internal\s+|open\s+|final\s+|data\s+|sealed\s+)*(?:class|struct|protocol|enum|actor|extension|trait|module)\s+([A-Za-z0-9_$]+)/i.exec(trimmed);
    if (classMatch && !isPython && lang !== "go" && lang !== "rust") {
      classes.push({ name: classMatch[1], line: lineNum, endLine: findEndLine(idx, lang === "ruby"), exported: !/^\s*(?:private|fileprivate)\b/.test(trimmed), signature: trimmed.replace(/\{?$/, "").trim() });
      continue;
    }
    if ((lang === "objc" || lang === "objcpp") && /^\s*@(?:interface|implementation|protocol)\s+([A-Za-z0-9_]+)/.test(trimmed)) {
      const om = /^\s*@(?:interface|implementation|protocol)\s+([A-Za-z0-9_]+)/.exec(trimmed);
      classes.push({ name: om[1], line: lineNum, endLine: findEndLine(idx, false), exported: true, signature: trimmed });
      continue;
    }
    const interfaceMatch = /^\s*(?:export\s+)?interface\s+([A-Za-z0-9_$]+)(?:\s+extends\s+[A-Za-z0-9_$,\s]+)?/i.exec(trimmed);
    if (interfaceMatch) {
      classes.push({ name: interfaceMatch[1], kind: "interface", line: lineNum, endLine: findEndLine(idx, false), exported: /^export\b/.test(trimmed), signature: trimmed.replace(/\{?$/, "").trim() });
      types.push({ name: interfaceMatch[1], kind: "interface", line: lineNum, endLine: findEndLine(idx, false), exported: /^export\b/.test(trimmed) });
      continue;
    }
    if (isPython && /^\s*class\s+([A-Za-z0-9_$]+)(?:\([^)]*\))?:/i.test(trimmed)) {
      const pyClassMatch = /^\s*class\s+([A-Za-z0-9_$]+)/.exec(trimmed);
      classes.push({ name: pyClassMatch[1], line: lineNum, endLine: findEndLine(idx, true), exported: !pyClassMatch[1].startsWith("_"), signature: trimmed });
      continue;
    }
    if (lang === "go" && /^\s*type\s+([A-Za-z0-9_]+)\s+(?:struct|interface)\b/.test(trimmed)) {
      const gm = /^\s*type\s+([A-Za-z0-9_]+)/.exec(trimmed);
      classes.push({ name: gm[1], kind: "struct", line: lineNum, endLine: findEndLine(idx, false), exported: /^[A-Z]/.test(gm[1]), signature: trimmed.replace(/\{?$/, "").trim() });
      continue;
    }
    if (lang === "rust" && /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z0-9_]+)/.test(trimmed)) {
      const rm = /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z0-9_]+)/.exec(trimmed);
      classes.push({ name: rm[1], line: lineNum, endLine: findEndLine(idx, false), exported: /^\s*pub\b/.test(trimmed), signature: trimmed.replace(/\{?$/, "").trim() });
      continue;
    }

    // Functions & Methods
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

    const fnMatch = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(([^)]*)\)/i.exec(defText);
    if (fnMatch) {
      functions.push({ name: fnMatch[1], line: lineNum, endLine: findEndLine(idx, false), exported: /^export\b/.test(trimmed), signature: `${fnMatch[1]}(${fnMatch[2].trim()})` });
      continue;
    }
    const arrowMatch = /^\s*(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*(?::\s*[^=]+)?\s*=>/i.exec(trimmed);
    if (arrowMatch) {
      functions.push({ name: arrowMatch[1], line: lineNum, endLine: findEndLine(idx, false), exported: /^export\b/.test(trimmed), signature: `${arrowMatch[1]}(${arrowMatch[2].trim()})` });
      continue;
    }
    if ((lang === "javascript" || lang === "typescript") && /^\s/.test(line)) {
      const m = /^\s+(?:(?:public|private|protected|static|async|override|readonly|abstract|get|set)\s+)*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(?::\s*[^{=]+)?\s*\{/.exec(line);
      if (m && !NOT_METHOD.has(m[1])) {
        functions.push({ name: m[1], line: lineNum, endLine: findEndLine(idx, false), exported: false, isMethod: true, signature: `${m[1]}(${m[2].trim()})` });
        continue;
      }
    }
    if (isPython) {
      const pyFn = /^\s*(?:async\s+)?def\s+([A-Za-z0-9_$]+)\s*\(([^)]*)\)/.exec(defText);
      if (pyFn) {
        functions.push({ name: pyFn[1], line: lineNum, endLine: findEndLine(idx, true), exported: !pyFn[1].startsWith("_"), signature: `${pyFn[1]}(${pyFn[2].trim()})` });
        continue;
      }
    }
    if (lang === "go") {
      const goFn = /^\s*func\s+(?:\([^)]+\)\s+)?([A-Za-z0-9_$]+)\s*\(([^)]*)\)/.exec(defText);
      if (goFn) {
        functions.push({ name: goFn[1], line: lineNum, endLine: findEndLine(idx, false), exported: /^[A-Z]/.test(goFn[1]), signature: `${goFn[1]}(${goFn[2].trim()})` });
        continue;
      }
    }
    if (lang === "rust") {
      const rsFn = /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_$]+)\s*(?:<[^>]+>)?\s*\(([^)]*)\)/.exec(defText);
      if (rsFn) {
        functions.push({ name: rsFn[1], line: lineNum, endLine: findEndLine(idx, false), exported: /^\s*pub\b/.test(trimmed), signature: `${rsFn[1]}(${rsFn[2].trim()})` });
        continue;
      }
    }
    if (lang === "swift" || lang === "kotlin") {
      const skFn = /^\s*(?:public\s+|internal\s+|private\s+|fileprivate\s+|open\s+|override\s+|suspend\s+|static\s+|class\s+|@objc\s+)*(?:func|fun)\s+([A-Za-z0-9_]+)\s*(?:<[^>]+>)?\s*\(([^)]*)\)/.exec(defText);
      if (skFn) {
        functions.push({ name: skFn[1], line: lineNum, endLine: findEndLine(idx, false), exported: !/^\s*(?:private|fileprivate)\b/.test(trimmed), signature: `${skFn[1]}(${stripParamComments(skFn[2])})` });
        continue;
      }
    }
    if ((lang === "objc" || lang === "objcpp") && /^\s*[-+]\s*\([^)]+\)\s*([A-Za-z0-9_]+)/.test(trimmed)) {
      const ocFn = /^\s*[-+]\s*\([^)]+\)\s*([A-Za-z0-9_]+)/.exec(trimmed);
      functions.push({ name: ocFn[1], line: lineNum, endLine: findEndLine(idx, false), exported: true, isMethod: true, signature: `${ocFn[1]}()` });
      continue;
    }
    if (lang === "ruby" && /^\s*def\s+(?:self\.)?([A-Za-z0-9_!?=]+)/.test(trimmed)) {
      const rbFn = /^\s*def\s+(?:self\.)?([A-Za-z0-9_!?=]+)(?:\(([^)]*)\))?/.exec(trimmed);
      functions.push({ name: rbFn[1], line: lineNum, endLine: lineNum, exported: true, signature: `${rbFn[1]}(${rbFn[2] || ""})` });
      continue;
    }
    if (lang === "java" || lang === "csharp" || lang === "dart" || lang === "php" || lang === "c" || lang === "cpp") {
      const clikeFn = /^\s*(?:(?:public|private|protected|static|final|virtual|override|async|inline|extern|friend|explicit)\s+)*[A-Za-z0-9_:<>[\]*&\s]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*(?:const\s*)?(?:\{|throws\b|$)/.exec(trimmed);
      if (clikeFn && !NOT_METHOD.has(clikeFn[1])) {
        functions.push({ name: clikeFn[1], line: lineNum, endLine: findEndLine(idx, false), exported: !/^\s*private\b/.test(trimmed), signature: `${clikeFn[1]}(${stripParamComments(clikeFn[2])})` });
        continue;
      }
    }

    // Constants (top-level ALL_CAPS or exported)
    const constMatch = /^\s*(?:export\s+const|([A-Z][A-Z0-9_]{2,})\s*=)\s*/.exec(trimmed);
    if (constMatch) {
      const nameMatch = /(?:export\s+const\s+|)([A-Za-z0-9_$]+)/.exec(trimmed);
      if (nameMatch) constants.push({ name: nameMatch[1], kind: "const", line: lineNum, endLine: lineNum, exported: /^export\b/.test(trimmed) || /^[A-Z]/.test(nameMatch[1]) });
    }

    if (/^\s*(?:module\.exports\s*=|export\s+(?:default\s+)?|exports\.[A-Za-z0-9_$]+\s*=)/i.test(trimmed)) {
      exportsList.push(trimmed.replace(/;$/, ""));
    }
  }

  const talksTo = extractTalksTo(cleanSource);
  const struct = {
    language: lang,
    filename: path.basename(filename || "code"),
    filepath: filename,
    fileDoc,
    purpose: fileDoc ? fileDoc.split(/(?<=[.!?])\s+/)[0] : "",
    totalLines: lines.length,
    parseStatus: "partial", // Honest fallback status whenever regex heuristic extractor runs instead of AST compiler
    imports,
    internalImports: [...new Set(internalImports)],
    externalPackages: [...new Set(externalPackages)],
    classes,
    functions,
    types,
    constants,
    exportsList,
    talksTo,
    isThinPassthrough: lines.length <= 25 && functions.length === 0 && classes.length === 0 && exportsList.length > 0 && internalImports.length > 0,
  };
  struct.role = classifyFileRole(filename, struct, cleanSource);
  if (!struct.purpose) struct.purpose = synthesizeFilePurpose(filename, struct);
  return struct;
}

/**
 * Formats a compact Appendix-A style per-file entry (3-6 lines full, or 1-2 lines compact tier, no third-party imports, Lstart-Lend ranges).
 */
function formatCompactFileEntry(mod, { relPath, revision = null, estTokens = null, includePrivate = false, commitCount = 0, compact = false } = {}) {
  const s = mod.structure || {};
  const tokens = estTokens ?? Math.max(1, Math.round((mod.rawCodeChars || s.totalLines * 36) / 4));
  const revTag = revision ? ` · rev ${revision}` : "";
  const dirtyTag = mod.dirty ? " · [modified]" : "";
  const parseTag = s.parseStatus === "partial" ? " · [parse: partial]" : "";
  const churnTag = commitCount >= 5 ? ` · ${commitCount} commits` : "";
  const headerLine = `${relPath || s.filepath || s.filename} · ${s.role || "module"} · ${s.totalLines || 0} lines · ~${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tokens${revTag}${churnTag}${dirtyTag}${parseTag}`;

  const exportedSyms = [
    ...(s.classes || []).filter((c) => includePrivate || c.exported !== false).map((c) => `${c.name} L${c.line}-L${c.endLine || c.line}`),
    ...(s.functions || [])
      .filter((f) => includePrivate || f.exported !== false)
      .map((f) => `${shortenSignature(f.name, f.signature?.slice(f.name.length + 1, -1) || "")} L${f.line}-L${f.endLine || f.line}`),
  ];

  if (compact) {
    const symSlice = exportedSyms.slice(0, 5).join(" · ");
    const more = exportedSyms.length > 5 ? ` (+${exportedSyms.length - 5})` : "";
    return `${headerLine}${symSlice ? `\nExports: ${symSlice}${more}` : `\nPurpose: ${s.purpose || mod.purpose || `${s.role || "module"}`}`}`;
  }

  const lines = [headerLine];
  const purpose = s.purpose || mod.purpose || synthesizeFilePurpose(relPath, s);
  lines.push(`Purpose: ${purpose}`);

  if (exportedSyms.length > 0) {
    lines.push(`Exports: ${exportedSyms.slice(0, 14).join(" · ")}${exportedSyms.length > 14 ? ` · (+${exportedSyms.length - 14} more)` : ""}`);
  }

  const talks = [];
  if (s.talksTo?.httpCalls?.length) talks.push(`HTTP ${s.talksTo.httpCalls.slice(0, 4).join(", ")}`);
  if (s.talksTo?.events?.length) talks.push(`events ${s.talksTo.events.slice(0, 4).join(", ")}`);
  if (s.talksTo?.tables?.length) talks.push(`tables ${s.talksTo.tables.slice(0, 4).join(", ")}`);
  if (s.talksTo?.envVars?.length) talks.push(`env ${s.talksTo.envVars.slice(0, 4).join(", ")}`);
  if (s.talksTo?.flags?.length) talks.push(`flags ${s.talksTo.flags.slice(0, 4).join(", ")}`);
  if (talks.length > 0) lines.push(`Talks to: ${talks.join(" | ")}`);

  if (s.internalImports?.length > 0) {
    lines.push(`Uses: ${s.internalImports.slice(0, 10).join(" · ")}`);
  }

  return lines.join("\n");
}

/**
 * Legacy module Markdown converter (kept compatible for ingest.js and existing module views).
 */
function convertCodeToMarkdown(sourceCode, filename = "") {
  const structure = extractCodeStructure(sourceCode, filename);
  const out = [];

  out.push(`# Module: ${structure.filename}`);
  if (structure.fileDoc) out.push(`> ${structure.fileDoc}\n`);
  out.push(`- **Language**: \`${structure.language}\` · **Role**: ${structure.role}`);
  out.push(`- **Total Lines**: ${structure.totalLines}`);

  if (structure.exportsList.length > 0) {
    out.push(`\n## Exports`);
    for (const exp of structure.exportsList.slice(0, 15)) {
      out.push(`- \`${exp.replace(/\s+/g, " ").trim()}\``);
    }
  }

  if (structure.classes.length > 0) {
    out.push(`\n## Classes & Types`);
    for (const cls of structure.classes) {
      out.push(`- \`${cls.signature}\` (line ${cls.line}${cls.endLine && cls.endLine !== cls.line ? `-${cls.endLine}` : ""})`);
    }
  }

  if (structure.functions.length > 0) {
    out.push(`\n## Function Signatures`);
    for (const fn of structure.functions) {
      out.push(`- \`${fn.signature}\` (line ${fn.line}${fn.endLine && fn.endLine !== fn.line ? `-${fn.endLine}` : ""})`);
    }
  }

  if (structure.imports.length > 0) {
    out.push(`\n## Dependencies`);
    for (const imp of structure.imports.slice(0, 20)) {
      out.push(`- \`${imp.replace(/\s+/g, " ").trim()}\``);
    }
  }

  return out.join("\n");
}

/**
 * cAST: Syntax-Aware AST Chunker.
 */
function chunkCodeAst(sourceCode, filename = "", { targetChars = 900, minChars = 160 } = {}) {
  const clean = String(sourceCode || "").replace(/\r\n?/g, "\n");
  const lines = clean.split("\n");
  const structure = extractCodeStructure(sourceCode, filename);
  const chunks = [];

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
        if (ch === "\\" && i + 1 < text.length) { i++; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "/" && text[i + 1] === "/") break;
      if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
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
      if (symbolAtLine.has(idx)) currentSymbol = symbolAtLine.get(idx);
    }

    currentChunkLines.push(line);
    currentBufChars += line.length + 1;

    if (!isPython) braceDepth = Math.max(0, braceDepth + countBraces(line));

    if (currentBufChars >= targetChars) {
      const nextLine = idx + 1 < lines.length ? lines[idx + 1] : "";
      const nextNonEmpty = nextLine.trim();
      const nextIndent = nextLine.search(/\S/);
      const closedPythonBlock = isPython && nextNonEmpty.length > 0 && nextIndent !== -1 && nextIndent <= chunkEntryIndent;
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
  shortenSignature,
  classifyFileRole,
  extractTalksTo,
  extractCodeStructure,
  formatCompactFileEntry,
  convertCodeToMarkdown,
  chunkCodeAst,
};
