// A catch that does nothing hides the failure that explains a wrong answer. Every catch in
// src/copilot must log, rethrow or do something observable; the allowlist below is the
// closed set of places where swallowing is deliberate.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "../../src/copilot");

// "relative/path.js:<n>" is keyed by the nth empty catch in that file, so edits elsewhere
const ALLOWLIST = {
  "core/okf/featureRegistry.js#1": "mocked fs objects in unit tests may not support readdirSync; fall back to single file path",
  "main/behavior.js#1": "behavior state file may not exist yet on fresh profiles",
  "main/behavior.js#2": "failed behavior save is non-fatal and will retry on next state transition",
  "main/engine.js#1": "panel IPC window may be reloading or closed while events are dispatched",
  "main/engine.js#2": "trace file append failure must never crash the live copilot session",
  "main/engine.js#3": "JSON log file append failure must never crash the live copilot session",
  "main/engine.js#4": "sufficiency telemetry logging failure must not alter card emission verdict",
  "main/memProbe.js#1": "background memory probe diagnostics append is non-fatal",
  "main/projectMatch.js#1": "calendar conference_data may be malformed JSON or lack entryPoints",
  "main/reference.js#1": "unreadable or locked reference file is omitted from the reference context",
  "main/service.js#1": "promise queue chain: settings error was returned to the caller; queue chain must stay resolved",
  "main/store.js#1": "WAL journal mode may be unsupported on in-memory or read-only test databases",
  "main/window.js#1": "window may be closed before the copilot renderer finishes loading",
  "rag/retrieve.js#1": "background embedding prefetch failure is non-fatal and search will fall back to sync embed",
};

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.name.endsWith(".js") ? [p] : [];
  });
}

// Replaces comments and string/template/regex contents with spaces (newlines kept) so brace
// matching and "is the body empty" are not fooled by text inside them.
function mask(src) {
  const out = src.split("");
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  let lastSig = "";
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      const e = src.indexOf("\n", i);
      const end = e === -1 ? src.length : e;
      blank(i, end);
      i = end;
    } else if (c === "/" && n === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e === -1 ? src.length : e + 2;
      blank(i, end);
      i = end;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
      lastSig = c;
    } else if (c === "/" && (lastSig === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(lastSig))) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== "\n") {
        if (src[j] === "\\") j += 2;
        else if (src[j] === "[") (inClass = true), j++;
        else if (src[j] === "]") (inClass = false), j++;
        else if (src[j] === "/" && !inClass) break;
        else j++;
      }
      blank(i + 1, j);
      i = j + 1;
      lastSig = "/";
    } else {
      if (!/\s/.test(c)) lastSig = c;
      i++;
    }
  }
  return out.join("");
}

function silentCatches(src) {
  const masked = mask(src);
  const lineOf = (idx) => src.slice(0, idx).split("\n").length;
  const found = [];
  const block = /\bcatch\s*(?:\([^)]*\))?\s*\{([^{}]*)\}/g;
  for (let m; (m = block.exec(masked)); ) {
    if (m[1].trim() === "") found.push(lineOf(m.index));
  }
  // promise form: .catch(() => {}) / .catch((e) => {})
  const promise = /\.catch\(\s*(?:\(\s*[\w$]*\s*\)|[\w$]+)\s*=>\s*\{\s*\}\s*\)/g;
  for (let m; (m = promise.exec(masked)); ) found.push(lineOf(m.index));
  return found.sort((a, b) => a - b);
}

test("scanner flags empty and comment-only catches but not ones with a statement", () => {
  assert.equal(silentCatches("try { a() } catch {}").length, 1);
  assert.equal(silentCatches("try { a() } catch (e) {}").length, 1);
  assert.equal(silentCatches("try { a() } catch (e) {\n // why\n}").length, 1);
  assert.equal(silentCatches("p.catch(() => {});").length, 1);
  assert.equal(silentCatches("try { a() } catch (e) { log(e); }").length, 0);
  assert.equal(silentCatches("const s = 'catch {}'; // catch {}").length, 0);
});

test("no silent catch in src/copilot outside the allowlist", () => {
  const used = new Set();
  const offenders = [];
  for (const file of walk(ROOT)) {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    silentCatches(fs.readFileSync(file, "utf8")).forEach((line, idx) => {
      const key = `${rel}#${idx + 1}`;
      if (ALLOWLIST[key]) used.add(key);
      else offenders.push(`${rel}:${line}`);
    });
  }
  const stale = Object.keys(ALLOWLIST).filter((k) => !used.has(k));
  assert.deepEqual(offenders, [], `silent catch (log it, rethrow it, or allowlist with a reason):\n${offenders.join("\n")}`);
  assert.deepEqual(stale, [], `stale allowlist entries: ${stale.join(", ")}`);
});
