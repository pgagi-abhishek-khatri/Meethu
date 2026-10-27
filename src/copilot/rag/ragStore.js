// Chunks, their vectors and the keyword index, inside the copilot's own SQLite file. Search is a plain loop over
// the project's vectors held in memory (a few thousand chunks = a few ms) merged with SQLite FTS5 keyword hits.
const { toBuffer, fromBuffer, topK, rrf } = require("./vectors");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS copilot_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER NOT NULL, project_id INTEGER NOT NULL, ord INTEGER NOT NULL,
  text TEXT NOT NULL, meta TEXT, embed TEXT, hash TEXT, dims INTEGER, vec BLOB
);
CREATE INDEX IF NOT EXISTS copilot_chunks_file ON copilot_chunks(file_id);
CREATE INDEX IF NOT EXISTS copilot_chunks_project ON copilot_chunks(project_id);
CREATE INDEX IF NOT EXISTS copilot_chunks_hash ON copilot_chunks(hash);
CREATE VIRTUAL TABLE IF NOT EXISTS copilot_chunks_fts USING fts5(text, tokenize = 'unicode61 remove_diacritics 2');
`;

// File columns added to copilot_project_files: what happened when it was indexed.
const FILE_COLUMNS = [
  ["kind", "TEXT"],
  ["status", "TEXT"], // queued | reading | analysing | embedding | ready | error
  ["stage", "TEXT"],
  ["error", "TEXT"],
  ["note", "TEXT"], // e.g. "partial: only the first 64k tokens were read"
  ["summary", "TEXT"],
  ["hash", "TEXT"],
  ["bytes", "INTEGER"],
  ["chunk_count", "INTEGER"],
  ["tokens", "INTEGER"],
  ["cost", "REAL"],
  ["indexed_at", "INTEGER"],
];

// Words that say nothing about the subject; a question's "what is the" must not match every chunk.
const STOP = new Set(
  "the and for are but not you your yours his her its our their they them this that these those with from into over about what which who whom whose when where why how does did doing done have has had was were been being will would could should can cant cannot may might must shall than then there here also just very much many more most some any all each every other such only own same too out off per via get got let say said tell told know want need like make made give gave take took see saw look looks look going".split(
    " "
  )
);

// FTS5 query from free text: each word quoted (so punctuation cannot break the syntax), joined by OR; short words dropped.
function ftsQuery(text) {
  const words = [
    ...new Set(
      String(text)
        .toLowerCase()
        .match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? []
    ),
  ]
    .filter((w) => w.length > 2 && !STOP.has(w))
    .slice(0, 24);
  return words.map((w) => `"${w.replace(/"/g, "")}"`).join(" OR ");
}

function createRagStore(db, { addColumn, now = Date.now } = {}) {
  db.exec(SCHEMA);
  for (const [c, t] of FILE_COLUMNS) addColumn("copilot_project_files", c, t);

  const q = {
    file: db.prepare("SELECT * FROM copilot_project_files WHERE id = ?"),
    insert: db.prepare(
      "INSERT INTO copilot_chunks (file_id, project_id, ord, text, meta, embed, hash, dims, vec) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ),
    insertFts: db.prepare("INSERT INTO copilot_chunks_fts (rowid, text) VALUES (?, ?)"),
    ids: db.prepare("SELECT id FROM copilot_chunks WHERE file_id = ?"),
    delFts: db.prepare("DELETE FROM copilot_chunks_fts WHERE rowid = ?"),
    delChunks: db.prepare("DELETE FROM copilot_chunks WHERE file_id = ?"),
    byHash: db.prepare(
      "SELECT hash, vec FROM copilot_chunks WHERE hash IN (SELECT value FROM json_each(?)) AND dims = ?"
    ),
    vectors: db.prepare(
      "SELECT id, vec FROM copilot_chunks WHERE project_id = ? AND dims = ? AND vec IS NOT NULL"
    ),
    count: db.prepare("SELECT COUNT(*) AS n FROM copilot_chunks WHERE project_id = ?"),
    countAll: db.prepare("SELECT COUNT(*) AS n FROM copilot_chunks"),
    ready: db.prepare(
      "SELECT COUNT(*) AS n FROM copilot_project_files WHERE project_id = ? AND status = 'ready'"
    ),
    readyFiles: db.prepare(
      "SELECT id, name, kind, summary FROM copilot_project_files WHERE project_id = ? AND status = 'ready' ORDER BY id"
    ),
    fts: db.prepare(
      `SELECT c.id AS id FROM copilot_chunks_fts f JOIN copilot_chunks c ON c.id = f.rowid
       WHERE copilot_chunks_fts MATCH ? AND c.project_id = ? ORDER BY bm25(copilot_chunks_fts) LIMIT ?`
    ),
    chunk: db.prepare(
      `SELECT c.id, c.file_id, c.ord, c.text, c.meta, c.embed, f.name AS file FROM copilot_chunks c
       JOIN copilot_project_files f ON f.id = c.file_id WHERE c.id = ?`
    ),
    projectBytes: db.prepare(
      "SELECT COALESCE(SUM(bytes), 0) AS n FROM copilot_project_files WHERE project_id = ?"
    ),
    unindexed: db.prepare(
      "SELECT id, project_id, path, name FROM copilot_project_files WHERE status IS NULL OR status IN ('queued','reading','analysing','embedding')"
    ),
  };

  // project id -> { ids, data } kept until the project's chunks change
  const matrices = new Map();

  return {
    file: (id) => q.file.get(id) ?? null,
    setFile(id, patch) {
      const keys = Object.keys(patch).filter((k) => FILE_COLUMNS.some(([c]) => c === k));
      if (!keys.length) return;
      db.prepare(
        `UPDATE copilot_project_files SET ${keys.map((k) => `${k} = @${k}`).join(", ")} WHERE id = @id`
      ).run({ ...patch, id });
    },
    // Files that were mid-index when the app closed (or never indexed): to be started again.
    unfinished: () => q.unindexed.all(),
    projectBytes: (projectId) => q.projectBytes.get(projectId).n,
    chunkCount: (projectId) => q.count.get(projectId).n,
    totalChunks: () => q.countAll.get().n,
    hasIndex: (projectId) => q.ready.get(projectId).n > 0,

    // chunks: [{ text, meta, embed: "text"|"media", hash, vec: Float32Array|null }] replace the file's old ones in one step.
    replaceChunks(fileId, projectId, chunks, dims) {
      db.transaction(() => {
        for (const { id } of q.ids.all(fileId)) q.delFts.run(id);
        q.delChunks.run(fileId);
        chunks.forEach((c, ord) => {
          const id = Number(
            q.insert.run(
              fileId,
              projectId,
              ord,
              c.text,
              JSON.stringify(c.meta ?? {}),
              c.embed ?? "text",
              c.hash ?? null,
              c.vec ? dims : null,
              c.vec ? toBuffer(c.vec) : null
            ).lastInsertRowid
          );
          q.insertFts.run(id, c.text);
        });
      })();
      for (const key of matrices.keys()) if (key.startsWith(`${projectId}:`)) matrices.delete(key);
    },
    removeFile(fileId, projectId) {
      this.replaceChunks(fileId, projectId, [], 0);
    },
    // hash -> Float32Array for chunks whose text was embedded before (an edited file re-embeds only what changed).
    cachedVectors(hashes, dims) {
      const out = new Map();
      if (!hashes.length) return out;
      for (const r of q.byHash.all(JSON.stringify(hashes), dims))
        out.set(r.hash, fromBuffer(r.vec));
      return out;
    },

    // Everything a project holds, as one matrix.
    matrix(projectId, dims) {
      const key = `${projectId}:${dims}`;
      if (matrices.has(key)) return matrices.get(key);
      const rows = q.vectors.all(projectId, dims);
      const data = new Float32Array(rows.length * dims);
      rows.forEach((r, i) => data.set(fromBuffer(r.vec), i * dims));
      const m = { ids: rows.map((r) => r.id), data };
      matrices.set(key, m);
      return m;
    },
    keyword(projectId, text, k = 12) {
      const query = ftsQuery(text);
      if (!query) return [];
      try {
        return q.fts.all(query, projectId, k).map((r) => r.id);
      } catch {
        return []; // a syntax edge case must never break an answer
      }
    },
    vector(projectId, vec, k = 12) {
      const m = this.matrix(projectId, vec.length);
      return m.ids.length ? topK(m, vec, k) : [];
    },
    chunk(id) {
      const r = q.chunk.get(id);
      return r ? { ...r, meta: JSON.parse(r.meta || "{}") } : null;
    },
    // One line per ready file: what it is. Always in the answer prompt.
    catalog: (projectId) => q.readyFiles.all(projectId),
    rrf,
  };
}

module.exports = { createRagStore, ftsQuery, FILE_COLUMNS };
