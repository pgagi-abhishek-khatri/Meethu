// Pre-read special file classification, secret deny-list, safe text decoding, and specialized compact parsers.
const fs = require("fs");
const path = require("path");
const { isSecretPath } = require("../core/validation/pathPolicy");
const { classify } = require("./config");

const EXTRA_SECRET_PATTERNS = [
  /^\.env(\.(?!example$|sample$|template$).+)?$/i,
  /^service[-_]?account.*\.json$/i,
  /^google-services\.json$/i,
  /^GoogleService-Info\.plist$/i,
  /\.tfstate(\.backup)?$/i,
  /\.tfvars(\.json)?$/i,
  /^htpasswd$/i,
  /^\.htpasswd$/i,
  /^\.pypirc$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.docker\/config\.json$/i,
  /(?:^|\/)secrets?\//i,
  /\.secrets?(?:\.|$)/i,
  /(?:^|\/)credentials?\.(?:json|ya?ml|xml|txt|ini|conf)$/i,
  /(?:^|\/).*[-_.]tokens?\.(?:json|ya?ml|txt|key)$/i,
  /^id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?$/i,
  /\.(?:keystore|jks|p12|pfx|pem|key)$/i,
];

const SAFE_ENV_EXAMPLES = /(?:^|\.)(?:example|sample|template)(?:\.[^./]+)?$/i;

const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "cargo.lock",
  "poetry.lock",
  "pipfile.lock",
  "go.sum",
  "composer.lock",
  "gemfile.lock",
]);

const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tiff", ".svgz",
  ".mp3", ".wav", ".ogg", ".flac", ".aac", ".opus", ".m4a",
  ".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v",
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar", ".tgz",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".o", ".a", ".lib", ".wasm",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".sqlite", ".sqlite3", ".db", ".pdb", ".pyc", ".pyo", ".class", ".jar",
  ".pdf", ".docx", ".xlsx", ".pptx", ".doc", ".xls", ".ppt",
]);

const CONFIG_NAMES = new Set([
  "package.json", "tsconfig.json", "jsconfig.json", "vite.config.js", "vite.config.ts",
  "webpack.config.js", "eslint.config.js", "eslint.config.mjs", ".eslintrc.json",
  "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "cargo.toml",
  "go.mod", "go.work", "dockerfile", "docker-compose.yml", "docker-compose.yaml",
  "makefile", "cmakelists.txt", "flake.nix", "app.json", "app.config.js", "app.config.ts",
  "capacitor.config.json", "androidmanifest.xml", "info.plist", "electron-builder.json",
]);

const TRANSLATION_DIR_RE = /(?:^|\/)(?:locales?|i18n|translations?|lang)\//i;
const PERSONAL_DATA_RE = /(?:^|\/)(?:dumps?|exports?|fixtures?\/.*(?:users|contacts|customers|leads|emails)|.*\.log)$/i;
const REPETITIVE_DIR_RE = /(?:^|\/)(?:migrations?|alembic\/versions|__snapshots__|fixtures?)\//i;
const VENDOR_DIR_RE = /(?:^|\/)(?:vendor|third_party|external|vendored)\//i;

const SCHEMA_EXTS = new Set([".prisma", ".graphql", ".gql", ".proto"]);
const DATA_ASSET_EXTS = new Set([".json", ".yaml", ".yml", ".toml", ".xml", ".plist", ".svg", ".css", ".scss", ".less", ".html", ".htm", ".csv", ".tsv"]);

function isSecretFilePath(relOrAbsPath, extraPatterns = []) {
  const norm = String(relOrAbsPath || "").replace(/\\/g, "/");
  const name = path.basename(norm);
  if (SAFE_ENV_EXAMPLES.test(name)) return false;
  if (isSecretPath(relOrAbsPath)) return true;
  if (EXTRA_SECRET_PATTERNS.some((re) => re.test(name) || re.test(norm))) return true;
  for (const raw of Array.isArray(extraPatterns) ? extraPatterns : []) {
    try {
      const re = raw instanceof RegExp ? raw : new RegExp(String(raw), "i");
      if (re.test(name) || re.test(norm)) return true;
    } catch {}
  }
  return false;
}

function classifySpecialFile(relPath, sizeBytes = 0, { extraSecretPatterns = [] } = {}) {
  const norm = String(relPath || "").replace(/\\/g, "/");
  const base = path.basename(norm);
  const low = base.toLowerCase();
  const ext = path.extname(low);

  if (isSecretFilePath(norm, extraSecretPatterns)) return "secret";
  if (LOCKFILE_NAMES.has(low)) return "lockfile";
  if (/\.min\.(?:js|css)$/i.test(low) || /\.bundle\.js$/i.test(low) || /\.map$/i.test(low)) {
    return low.endsWith(".map") ? "sourcemap" : "minified";
  }
  if (ext === ".ipynb") return "notebook";
  if (ext === ".patch" || ext === ".diff") return "patch";
  if (BINARY_EXTS.has(ext)) return "binary";
  if (TRANSLATION_DIR_RE.test(norm) && (ext === ".json" || ext === ".yml" || ext === ".yaml")) {
    return "translation";
  }
  if (VENDOR_DIR_RE.test(norm)) return "vendored";
  if (PERSONAL_DATA_RE.test(norm) && (ext === ".csv" || ext === ".json" || ext === ".jsonl" || ext === ".log" || ext === ".sql")) {
    return "personal_data";
  }
  if (
    CONFIG_NAMES.has(low) ||
    SCHEMA_EXTS.has(ext) ||
    SAFE_ENV_EXAMPLES.test(low) ||
    /^\.github\/workflows\/.+\.ya?ml$/i.test(norm) ||
    /^electron-builder\..+\.json$/i.test(low) ||
    /^(?:tsconfig|jsconfig)(?:\.[^.]+)?\.json$/i.test(low) ||
    /^(?:openapi|swagger)\.(?:json|ya?ml)$/i.test(low) ||
    /^(?:biome|vercel|turbo|eas|firebase|nx)\.json$/i.test(low)
  ) {
    return "config";
  }
  if (ext === ".md" || ext === ".markdown" || ext === ".txt" || ext === ".rst" || ext === ".adoc") {
    return "doc";
  }
  if (REPETITIVE_DIR_RE.test(norm)) return "repetitive";
  if (classify(base) === "code") {
    return "code";
  }
  if (DATA_ASSET_EXTS.has(ext)) return "data_asset";
  if (sizeBytes === 0) return "empty";
  return "other";
}

function readSafeText(absPath, maxBytes = 512 * 1024) {
  let fd = null;
  try {
    const stat = fs.statSync(absPath);
    const toRead = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(toRead);
    fd = fs.openSync(absPath, "r");
    const bytesRead = fs.readSync(fd, buf, 0, toRead, 0);
    const slice = buf.subarray(0, bytesRead);

    let encoding = "utf8";
    let startOffset = 0;
    if (slice.length >= 2 && slice[0] === 0xff && slice[1] === 0xfe) {
      encoding = "utf16le";
      startOffset = 2;
    } else if (slice.length >= 2 && slice[0] === 0xfe && slice[1] === 0xff) {
      // UTF-16 BE -> swap bytes into UTF-16 LE buffer
      const swapped = Buffer.from(slice.subarray(2));
      for (let i = 0; i + 1 < swapped.length; i += 2) {
        const tmp = swapped[i];
        swapped[i] = swapped[i + 1];
        swapped[i + 1] = tmp;
      }
      const textBe = swapped.toString("utf16le").replace(/\r\n?/g, "\n");
      return { ok: true, text: textBe, isBinary: false, truncatedBytes: stat.size > maxBytes, encoding: "utf16be" };
    } else if (slice.length >= 3 && slice[0] === 0xef && slice[1] === 0xbb && slice[2] === 0xbf) {
      startOffset = 3;
    } else {
      // Sniff null bytes in first 4KB to reject binary disguised as text
      const probeLen = Math.min(slice.length, 4096);
      for (let i = 0; i < probeLen; i++) {
        if (slice[i] === 0) {
          return { ok: false, isBinary: true, reason: "binary_null_bytes" };
        }
      }
    }

    const text = slice.subarray(startOffset).toString(encoding).replace(/\r\n?/g, "\n");
    return { ok: true, text, isBinary: false, truncatedBytes: stat.size > maxBytes, encoding };
  } catch (error) {
    return { ok: false, isBinary: false, reason: error?.message || "read_error" };
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function isLfsPointer(text) {
  return typeof text === "string" && text.startsWith("version https://git-lfs.github.com/spec/v1");
}

function detectGeneratedHeader(text) {
  const head = String(text || "").slice(0, 600);
  const m = /(?:DO NOT EDIT|@generated|Code generated by|auto-generated|autogenerated|This file is generated)[^\n]*/i.exec(head);
  if (!m) return null;
  const srcMatch = /(?:from|source|schema|spec)\s*[:=]?\s*([A-Za-z0-9_./-]+)/i.exec(head);
  return { marker: m[0].trim(), sourceHint: srcMatch ? srcMatch[1] : null };
}

function parseShebangLanguage(text) {
  const first = String(text || "").split("\n", 1)[0] || "";
  if (!first.startsWith("#!")) return null;
  if (/python/i.test(first)) return "python";
  if (/node|deno|bun/i.test(first)) return "javascript";
  if (/bash|sh|zsh/i.test(first)) return "bash";
  if (/ruby/i.test(first)) return "ruby";
  return "script";
}

function parseLockfileVersions(relPath, text) {
  const base = path.basename(relPath).toLowerCase();
  const versions = new Map();
  try {
    if (base === "package-lock.json") {
      const parsed = JSON.parse(text);
      const pkgs = parsed.packages || {};
      for (const [pkgPath, info] of Object.entries(pkgs)) {
        const m = /node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(pkgPath);
        if (m && info?.version) versions.set(m[1], info.version);
      }
      if (versions.size === 0 && parsed.dependencies) {
        for (const [name, info] of Object.entries(parsed.dependencies)) {
          if (info?.version) versions.set(name, info.version);
        }
      }
    } else if (base === "cargo.lock") {
      const blocks = text.split(/\[\[package\]\]/);
      for (const b of blocks) {
        const name = /name\s*=\s*"([^"]+)"/.exec(b)?.[1];
        const ver = /version\s*=\s*"([^"]+)"/.exec(b)?.[1];
        if (name && ver) versions.set(name, ver);
      }
    } else if (base === "poetry.lock") {
      const blocks = text.split(/\[\[package\]\]/);
      for (const b of blocks) {
        const name = /name\s*=\s*"([^"]+)"/.exec(b)?.[1];
        const ver = /version\s*=\s*"([^"]+)"/.exec(b)?.[1];
        if (name && ver) versions.set(name, ver);
      }
    } else if (base === "go.sum") {
      for (const line of text.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) versions.set(parts[0], parts[1].replace(/\/go\.mod$/, ""));
      }
    } else if (base === "yarn.lock") {
      let curName = null;
      for (const line of text.split("\n")) {
        const hdr = /^"?(@?[^@\s"]+)@[^:]+:/.exec(line);
        if (hdr) curName = hdr[1];
        const ver = /^\s+version\s+"([^"]+)"/.exec(line);
        if (curName && ver) {
          versions.set(curName, ver[1]);
          curName = null;
        }
      }
    } else if (base === "pnpm-lock.yaml") {
      const re = /^\s{2,4}'?(@?[^@\s':]+)@([0-9][^':\s]*)/gm;
      let m;
      while ((m = re.exec(text)) !== null) {
        versions.set(m[1], m[2]);
      }
    }
  } catch {
    // malformed lockfile returns empty version map
  }
  return versions;
}

function extractNotebookSummary(text) {
  try {
    const nb = JSON.parse(text);
    const cells = Array.isArray(nb.cells) ? nb.cells : [];
    const headings = [];
    const codeLines = [];
    for (const cell of cells) {
      const src = Array.isArray(cell.source) ? cell.source.join("") : String(cell.source || "");
      if (cell.cell_type === "markdown") {
        for (const line of src.split("\n")) {
          if (/^#{1,3}\s+/.test(line.trim())) headings.push(line.trim());
        }
      } else if (cell.cell_type === "code") {
        codeLines.push(src);
      }
    }
    return {
      ok: true,
      headings,
      codeText: codeLines.join("\n\n"),
      cellCount: cells.length,
    };
  } catch {
    return { ok: false, headings: [], codeText: "", cellCount: 0 };
  }
}

function flattenJsonKeys(obj, prefix = "", out = []) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flattenJsonKeys(v, key, out);
    else out.push(key);
  }
  return out;
}

function summarizeTranslationFile(relPath, text) {
  try {
    const parsed = JSON.parse(text);
    const keys = flattenJsonKeys(parsed);
    const norm = relPath.replace(/\\/g, "/");
    const localeMatch = /(?:locales?|i18n|translations?|lang)\/([A-Za-z0-9_-]+)/i.exec(norm);
    const locale = localeMatch ? localeMatch[1] : path.basename(norm, path.extname(norm));
    return { locale, keyCount: keys.length, keys: new Set(keys), topPrefixes: [...new Set(keys.map((k) => k.split(".")[0]))].slice(0, 12) };
  } catch {
    return null;
  }
}

module.exports = {
  LOCKFILE_NAMES,
  BINARY_EXTS,
  CONFIG_NAMES,
  isSecretFilePath,
  classifySpecialFile,
  readSafeText,
  isLfsPointer,
  detectGeneratedHeader,
  parseShebangLanguage,
  parseLockfileVersions,
  extractNotebookSummary,
  summarizeTranslationFile,
};
