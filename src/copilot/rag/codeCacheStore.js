// src/copilot/rag/codeCacheStore.js
// Incremental mtime+size cache for parsed vectorless code modules (0 native dependencies required).
// Supports both injected SQLite db (Electron main) and atomic JSON snapshots (Node CLI / fallback).

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const CACHE_SCHEMA_VERSION = 5;
const DEFAULT_CACHE_DIR = path.join(os.tmpdir(), "meethu-code-cache");

function repoKey(repoDir) {
  return crypto
    .createHash("sha256")
    .update(path.resolve(String(repoDir || "")))
    .digest("hex")
    .slice(0, 20);
}

function ensureSqliteTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS copilot_code_cache (
      repo_dir TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      mtime_ms REAL NOT NULL,
      size_bytes INTEGER NOT NULL,
      module_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (repo_dir, rel_path)
    );
    CREATE INDEX IF NOT EXISTS idx_code_cache_repo ON copilot_code_cache (repo_dir);
  `);
}

function createCodeCacheStore({ db = null, cacheDir = DEFAULT_CACHE_DIR, log = () => {} } = {}) {
  const absCacheDir = path.resolve(String(cacheDir || DEFAULT_CACHE_DIR));

  if (db) {
    ensureSqliteTable(db);
    const selectStmt = db.prepare(
      `SELECT rel_path, mtime_ms, size_bytes, module_json
       FROM copilot_code_cache
       WHERE repo_dir = ?`
    );
    const upsertStmt = db.prepare(
      `INSERT INTO copilot_code_cache (repo_dir, rel_path, mtime_ms, size_bytes, module_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_dir, rel_path) DO UPDATE SET
         mtime_ms = excluded.mtime_ms,
         size_bytes = excluded.size_bytes,
         module_json = excluded.module_json,
         updated_at = excluded.updated_at`
    );
    const deleteEntryStmt = db.prepare(
      `DELETE FROM copilot_code_cache WHERE repo_dir = ? AND rel_path = ?`
    );
    const clearRepoStmt = db.prepare(`DELETE FROM copilot_code_cache WHERE repo_dir = ?`);

    return {
      backend: "sqlite",
      loadRepoCache(repoDir) {
        const absRepo = path.resolve(String(repoDir || ""));
        const rows = selectStmt.all(absRepo);
        const map = new Map();
        for (const r of rows) {
          try {
            map.set(r.rel_path, {
              mtimeMs: Number(r.mtime_ms),
              sizeBytes: Number(r.size_bytes),
              module: JSON.parse(r.module_json),
            });
          } catch (error) {
            // One bad row costs one file a re-parse; the rest of the cache stays usable.
            log({ event: "code_cache_row_corrupt", relPath: r.rel_path, error: error.message });
          }
        }
        return map;
      },
      saveRepoCache(repoDir, entriesMap, { dirtyEntries = null, deleteStaleRelPaths = [] } = {}) {
        const absRepo = path.resolve(String(repoDir || ""));
        const now = Date.now();
        const toUpsert = dirtyEntries || entriesMap;
        const tx = db.transaction(() => {
          for (const relPath of deleteStaleRelPaths) {
            deleteEntryStmt.run(absRepo, relPath);
          }
          for (const [relPath, entry] of toUpsert.entries()) {
            upsertStmt.run(
              absRepo,
              relPath,
              Number(entry.mtimeMs),
              Number(entry.sizeBytes),
              JSON.stringify(entry.module),
              now
            );
          }
        });
        tx();
      },
      clearRepoCache(repoDir) {
        const absRepo = path.resolve(String(repoDir || ""));
        clearRepoStmt.run(absRepo);
      },
    };
  }

  // File-backed JSON snapshot cache (zero native binary dependencies)
  const snapshotPath = (repoDir) => path.join(absCacheDir, `${repoKey(repoDir)}.json`);

  return {
    backend: "json",
    loadRepoCache(repoDir) {
      const file = snapshotPath(repoDir);
      const map = new Map();
      try {
        if (!fs.existsSync(file)) return map;
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!parsed || parsed.version !== CACHE_SCHEMA_VERSION || !parsed.entries) {
          return map;
        }
        for (const [relPath, entry] of Object.entries(parsed.entries)) {
          if (entry && entry.module) {
            map.set(relPath, {
              mtimeMs: Number(entry.mtimeMs),
              sizeBytes: Number(entry.sizeBytes),
              module: entry.module,
            });
          }
        }
      } catch (error) {
        // A corrupt or unreadable snapshot falls back to a cold parse, but the reason is recorded.
        log({ event: "code_cache_load_failed", error: error.message });
      }
      return map;
    },
    saveRepoCache(repoDir, fullEntriesMap) {
      const absRepo = path.resolve(String(repoDir || ""));
      try {
        fs.mkdirSync(absCacheDir, { recursive: true });
        const entries = {};
        for (const [relPath, entry] of fullEntriesMap.entries()) {
          entries[relPath] = {
            mtimeMs: Number(entry.mtimeMs),
            sizeBytes: Number(entry.sizeBytes),
            module: entry.module,
          };
        }
        const payload = JSON.stringify({
          version: CACHE_SCHEMA_VERSION,
          repoDir: absRepo,
          updatedAt: Date.now(),
          entries,
        });
        const target = snapshotPath(absRepo);
        const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmp, payload, "utf8");
        fs.renameSync(tmp, target);
      } catch (error) {
        // Non-fatal: a cache write failure must never break code search, but it must not be invisible either.
        log({ event: "code_cache_write_failed", error: error.message });
      }
    },
    clearRepoCache(repoDir) {
      try {
        const file = snapshotPath(repoDir);
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch (error) {
        log({ event: "code_cache_clear_failed", error: error.message });
      }
    },
  };
}

module.exports = {
  CACHE_SCHEMA_VERSION,
  DEFAULT_CACHE_DIR,
  createCodeCacheStore,
  ensureSqliteTable,
};
