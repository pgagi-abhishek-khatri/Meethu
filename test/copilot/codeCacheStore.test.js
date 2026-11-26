// test/copilot/codeCacheStore.test.js
// Verifies mtime+size incremental caching: zero re-parses on unchanged files & selective invalidation.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createLocalCodeIndex } = require("../../src/copilot/rag/vectorlessCodeSearch");

describe("Incremental Code Cache Store (v3.0)", () => {
  test("warm index load skips unchanged files and selectively re-parses modified files", async () => {
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "meethu-cache-repo-"));
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "meethu-cache-dir-"));

    const fileA = path.join(tmpRepo, "alpha.ts");
    const fileB = path.join(tmpRepo, "beta.ts");
    fs.writeFileSync(fileA, `export function alphaFn() { return "alpha"; }\n`, "utf8");
    fs.writeFileSync(fileB, `export function betaFn() { return "beta"; }\n`, "utf8");

    // 1. Cold parse
    const cold = createLocalCodeIndex(tmpRepo, { useCache: true, cacheDir });
    assert.strictEqual(cold.stats.codeModules, 2);
    assert.strictEqual(cold.stats.parsedFiles, 2);
    assert.strictEqual(cold.stats.cachedFiles, 0);
    assert.strictEqual(cold.stats.cacheHit, false);
    assert.strictEqual(cold.stats.cacheBackend, "json");

    // 2. Warm load (unchanged files -> 0 parsed, 2 cached)
    const warm = createLocalCodeIndex(tmpRepo, { useCache: true, cacheDir });
    assert.strictEqual(warm.stats.codeModules, 2);
    assert.strictEqual(warm.stats.parsedFiles, 0);
    assert.strictEqual(warm.stats.cachedFiles, 2);
    assert.strictEqual(warm.stats.cacheHit, true);

    // 3. Mutate only fileB (ensure mtime & size differ)
    await new Promise((r) => setTimeout(r, 25));
    fs.writeFileSync(
      fileB,
      `export function betaFn() { return "beta-v2"; }\nexport function gammaHelper() { return 42; }\n`,
      "utf8"
    );

    const incremental = createLocalCodeIndex(tmpRepo, { useCache: true, cacheDir });
    assert.strictEqual(incremental.stats.parsedFiles, 1, "Only modified fileB should be re-parsed");
    assert.strictEqual(incremental.stats.cachedFiles, 1, "Unchanged fileA must come from cache");

    const res = incremental.search("gammaHelper", { topK: 3 });
    assert.strictEqual(res.hits[0].relPath, "beta.ts");

    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });
});

// Phase 6.4: cache failures are reported, never swallowed (and still never break code search).
const { test: t64 } = require("node:test");
const assert64 = require("node:assert/strict");
const fs64 = require("node:fs");
const os64 = require("node:os");
const path64 = require("node:path");
const { createCodeCacheStore: make64 } = require("../../src/copilot/rag/codeCacheStore");

const events64 = () => {
  const log = [];
  const fn = (e) => log.push(e);
  fn.log = log;
  return fn;
};

t64("a corrupt JSON snapshot loads as empty and is reported", () => {
  const dir = fs64.mkdtempSync(path64.join(os64.tmpdir(), "cc-"));
  const log = events64();
  const store = make64({ cacheDir: dir, log });
  store.saveRepoCache("/repo/a", new Map([["a.js", { mtimeMs: 1, sizeBytes: 2, module: { kind: "code" } }]]));
  const file = fs64.readdirSync(dir).find((f) => f.endsWith(".json"));
  fs64.writeFileSync(path64.join(dir, file), "{ not json");
  assert64.equal(store.loadRepoCache("/repo/a").size, 0);
  assert64.ok(log.log.some((e) => e.event === "code_cache_load_failed"));
});

t64("a cache that cannot be written is reported and does not throw", () => {
  const base = fs64.mkdtempSync(path64.join(os64.tmpdir(), "cc-"));
  const blocker = path64.join(base, "blocker");
  fs64.writeFileSync(blocker, "a file where the cache directory should be");
  const log = events64();
  const store = make64({ cacheDir: path64.join(blocker, "sub"), log });
  assert64.doesNotThrow(() => store.saveRepoCache("/repo/a", new Map([["a.js", { mtimeMs: 1, sizeBytes: 2, module: {} }]])));
  assert64.ok(log.log.some((e) => e.event === "code_cache_write_failed"));
});

t64("clearing a cache that cannot be removed is reported", () => {
  const dir = fs64.mkdtempSync(path64.join(os64.tmpdir(), "cc-"));
  const log = events64();
  const store = make64({ cacheDir: dir, log });
  store.saveRepoCache("/repo/a", new Map([["a.js", { mtimeMs: 1, sizeBytes: 2, module: {} }]]));
  const file = path64.join(dir, fs64.readdirSync(dir).find((f) => f.endsWith(".json")));
  fs64.rmSync(file);
  fs64.mkdirSync(file); // unlink on a directory fails
  assert64.doesNotThrow(() => store.clearRepoCache("/repo/a"));
  assert64.ok(log.log.some((e) => e.event === "code_cache_clear_failed"));
});

t64("a malformed SQLite row is skipped and reported", () => {
  let Database;
  try {
    Database = require("better-sqlite3");
    new Database(":memory:").close();
  } catch {
    return; // needs Electron's build: ELECTRON_RUN_AS_NODE=1 npx electron --test ...
  }
  const db = new Database(":memory:");
  const log = events64();
  const store = make64({ db, log });
  store.saveRepoCache("/repo/a", new Map([["ok.js", { mtimeMs: 1, sizeBytes: 2, module: { kind: "code" } }]]));
  db.prepare(
    "INSERT INTO copilot_code_cache (repo_dir, rel_path, mtime_ms, size_bytes, module_json, updated_at) VALUES (?,?,?,?,?,?)"
  ).run(path64.resolve("/repo/a"), "bad.js", 1, 2, "{broken", Date.now());
  const map = store.loadRepoCache("/repo/a");
  assert64.deepEqual([...map.keys()], ["ok.js"]);
  assert64.ok(log.log.some((e) => e.event === "code_cache_row_corrupt" && e.relPath === "bad.js"));
});
