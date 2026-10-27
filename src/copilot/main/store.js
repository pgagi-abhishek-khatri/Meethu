// The copilot's own SQLite file (userData/copilot.db): meetings, their transcript, threads and cards,
// and the user's project folders. Separate from the notes database on purpose, so the copilot never
// touches existing tables or migrations. Synchronous (better-sqlite3); every call is small.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS copilot_sessions (
  id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER, title TEXT, summary TEXT
);
CREATE TABLE IF NOT EXISTS copilot_segments (
  session_id TEXT NOT NULL, seq INTEGER NOT NULL, source TEXT, speaker TEXT, text TEXT NOT NULL, at INTEGER,
  PRIMARY KEY (session_id, seq)
);
CREATE TABLE IF NOT EXISTS copilot_threads (
  session_id TEXT NOT NULL, thread_id TEXT NOT NULL, title TEXT NOT NULL, closed INTEGER DEFAULT 0,
  PRIMARY KEY (session_id, thread_id)
);
CREATE TABLE IF NOT EXISTS copilot_cards (
  session_id TEXT NOT NULL, job_id TEXT NOT NULL, thread_id TEXT NOT NULL, label TEXT, deliverable TEXT,
  proactive INTEGER, focus TEXT, title TEXT, body TEXT, confidence TEXT, sources_json TEXT, status TEXT,
  timing_json TEXT, created_at INTEGER, feedback TEXT,
  PRIMARY KEY (session_id, job_id)
);
CREATE TABLE IF NOT EXISTS copilot_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS copilot_project_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, kind TEXT NOT NULL, pattern TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS copilot_project_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL, added_at INTEGER
);
`;

const { createRagStore } = require("../rag/ragStore");

function openStore({ dbPath, Database = require("better-sqlite3"), now = Date.now }) {
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
  } catch {}
  db.exec(SCHEMA);
  // Columns added after the first release: older files get them in place.
  const addColumn = (table, column, type) => {
    const has = db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .some((c) => c.name === column);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  };
  addColumn("copilot_sessions", "project_id", "INTEGER");
  addColumn("copilot_projects", "instructions", "TEXT");
  addColumn("copilot_projects", "plan", "TEXT");
  const rag = createRagStore(db, { addColumn, now });

  const q = {
    startSession: db.prepare(
      "INSERT INTO copilot_sessions (id, started_at, title) VALUES (?, ?, ?)"
    ),
    endSession: db.prepare("UPDATE copilot_sessions SET ended_at = ?, summary = ? WHERE id = ?"),
    setSummary: db.prepare("UPDATE copilot_sessions SET summary = ? WHERE id = ?"),
    addSegment: db.prepare("INSERT OR REPLACE INTO copilot_segments VALUES (?, ?, ?, ?, ?, ?)"),
    saveThread: db.prepare(
      "INSERT OR REPLACE INTO copilot_threads (session_id, thread_id, title, closed) VALUES (?, ?, ?, ?)"
    ),
    saveCard: db.prepare(
      `INSERT OR REPLACE INTO copilot_cards (session_id, job_id, thread_id, label, deliverable, proactive, focus, title, body,
        confidence, sources_json, status, timing_json, created_at, feedback)
       VALUES (@session_id, @job_id, @thread_id, @label, @deliverable, @proactive, @focus, @title, @body, @confidence,
        @sources_json, @status, @timing_json, @created_at, COALESCE((SELECT feedback FROM copilot_cards WHERE session_id = @session_id AND job_id = @job_id), NULL))`
    ),
    feedback: db.prepare(
      "UPDATE copilot_cards SET feedback = ? WHERE session_id = ? AND job_id = ?"
    ),
    setSessionProject: db.prepare("UPDATE copilot_sessions SET project_id = ? WHERE id = ?"),
    setSessionTitle: db.prepare("UPDATE copilot_sessions SET title = ? WHERE id = ?"),
    projectRow: db.prepare(
      "SELECT id, name, instructions, plan FROM copilot_projects WHERE id = ?"
    ),
    updateProject: db.prepare(
      "UPDATE copilot_projects SET name = ?, instructions = ?, plan = ? WHERE id = ?"
    ),
    rules: db.prepare(
      "SELECT id, project_id, kind, pattern FROM copilot_project_rules ORDER BY id"
    ),
    addRule: db.prepare(
      "INSERT INTO copilot_project_rules (project_id, kind, pattern) VALUES (?, ?, ?)"
    ),
    removeRule: db.prepare("DELETE FROM copilot_project_rules WHERE id = ?"),
    removeProjectRules: db.prepare("DELETE FROM copilot_project_rules WHERE project_id = ?"),
    projectFiles: db.prepare(
      "SELECT id, project_id, path, name, status FROM copilot_project_files WHERE project_id = ? ORDER BY id"
    ),
    sessions: db.prepare(
      `SELECT s.id, s.started_at, s.ended_at, s.title, s.summary, s.project_id,
        (SELECT COUNT(*) FROM copilot_cards c WHERE c.session_id = s.id AND c.status = 'done') AS cards
       FROM copilot_sessions s ORDER BY s.started_at DESC LIMIT ?`
    ),
    session: db.prepare("SELECT * FROM copilot_sessions WHERE id = ?"),
    segments: db.prepare(
      "SELECT seq, source, speaker, text, at FROM copilot_segments WHERE session_id = ? ORDER BY seq"
    ),
    threads: db.prepare(
      "SELECT thread_id AS id, title FROM copilot_threads WHERE session_id = ? AND closed = 0"
    ),
    cards: db.prepare(
      "SELECT * FROM copilot_cards WHERE session_id = ? ORDER BY created_at, rowid"
    ),
    deleteSession: [
      "DELETE FROM copilot_cards WHERE session_id = ?",
      "DELETE FROM copilot_threads WHERE session_id = ?",
      "DELETE FROM copilot_segments WHERE session_id = ?",
      "DELETE FROM copilot_sessions WHERE id = ?",
    ].map((sql) => db.prepare(sql)),
    projects: db.prepare(
      "SELECT id, name, active, instructions, plan FROM copilot_projects ORDER BY id"
    ),
    files: db.prepare("SELECT * FROM copilot_project_files ORDER BY id"),
    addProject: db.prepare(
      "INSERT INTO copilot_projects (name, active, created_at) VALUES (?, 1, ?)"
    ),
    renameProject: db.prepare("UPDATE copilot_projects SET name = ? WHERE id = ?"),
    activeProject: db.prepare("UPDATE copilot_projects SET active = ? WHERE id = ?"),
    removeProject: db.prepare("DELETE FROM copilot_projects WHERE id = ?"),
    removeProjectFiles: db.prepare("DELETE FROM copilot_project_files WHERE project_id = ?"),
    addFile: db.prepare(
      "INSERT INTO copilot_project_files (project_id, path, name, added_at) VALUES (?, ?, ?, ?)"
    ),
    removeFile: db.prepare("DELETE FROM copilot_project_files WHERE id = ?"),
    activeFiles: db.prepare(
      `SELECT f.id, f.project_id, f.path, f.name, f.status FROM copilot_project_files f JOIN copilot_projects p ON p.id = f.project_id
       WHERE p.active = 1 ORDER BY f.id`
    ),
  };

  const parse = (json, fallback) => {
    try {
      return json ? JSON.parse(json) : fallback;
    } catch {
      return fallback;
    }
  };

  return {
    startSession: (id, title) => q.startSession.run(id, now(), title ?? null),
    endSession: (id, summary) => q.endSession.run(now(), summary ?? null, id),
    setSummary: (id, summary) => q.setSummary.run(summary, id),
    setSessionProject: (id, projectId) => q.setSessionProject.run(projectId ?? null, id),
    setSessionTitle: (id, title) => q.setSessionTitle.run(String(title).slice(0, 120), id),
    addSegment: (sessionId, seg) =>
      q.addSegment.run(
        sessionId,
        seg.id,
        seg.source ?? null,
        seg.speaker ?? null,
        seg.text,
        seg.at ?? null
      ),
    saveThread: (sessionId, thread, closed = false) =>
      q.saveThread.run(sessionId, thread.id, thread.title, closed ? 1 : 0),
    // status: running | done | error | skipped | cancelled. A card is saved when it starts and again when it ends.
    saveCard: (sessionId, c) =>
      q.saveCard.run({
        session_id: sessionId,
        job_id: c.id,
        thread_id: c.threadId ?? "main",
        label: c.label ?? null,
        deliverable: c.deliverable ?? null,
        proactive: c.proactive ? 1 : 0,
        focus: c.focus ?? null,
        title: c.title ?? null,
        body: c.body ?? null,
        confidence: c.confidence ?? null,
        sources_json: c.sources ? JSON.stringify(c.sources) : null,
        status: c.status,
        timing_json: c.timing ? JSON.stringify(c.timing) : null,
        created_at: c.createdAt ?? now(),
      }),
    setFeedback: (sessionId, jobId, feedback) => q.feedback.run(feedback ?? null, sessionId, jobId),
    listSessions: (limit = 50) => q.sessions.all(limit),
    getSession(id) {
      const session = q.session.get(id);
      if (!session) return null;
      return {
        session,
        segments: q.segments.all(id),
        threads: [{ id: "main", title: "Main" }, ...q.threads.all(id)],
        cards: q.cards.all(id).map((c) => ({
          id: c.job_id,
          threadId: c.thread_id,
          label: c.label,
          deliverable: c.deliverable,
          proactive: !!c.proactive,
          focus: c.focus,
          title: c.title,
          body: c.body,
          confidence: c.confidence,
          sources: parse(c.sources_json, []),
          status: c.status,
          timing: parse(c.timing_json, null),
          feedback: c.feedback,
        })),
      };
    },
    deleteSession: (id) => db.transaction(() => q.deleteSession.forEach((st) => st.run(id)))(),
    // Meetings that never ended (the app closed mid-meeting) are closed at start-up.
    closeOpenSessions: () =>
      db.prepare("UPDATE copilot_sessions SET ended_at = started_at WHERE ended_at IS NULL").run(),
    // Retention: forget meetings older than `days` (0 = keep forever).
    prune(days) {
      if (!days) return 0;
      const old = db
        .prepare("SELECT id FROM copilot_sessions WHERE started_at < ?")
        .all(now() - days * 86400000);
      old.forEach((r) => this.deleteSession(r.id));
      return old.length;
    },
    projects: {
      get: (id) => q.projectRow.get(id) ?? null,
      // name, instructions (how to talk in this project), plan (standing notes: goals, pricing, who is who)
      update(id, { name, instructions, plan }) {
        const cur = q.projectRow.get(id);
        if (!cur) return;
        q.updateProject.run(
          String(name ?? cur.name).trim() || cur.name,
          String(instructions ?? cur.instructions ?? "").slice(0, 8000),
          String(plan ?? cur.plan ?? "").slice(0, 8000),
          id
        );
      },
      files: (id) => q.projectFiles.all(id),
      rules: () => q.rules.all(),
      addRule(projectId, kind, pattern) {
        const p = String(pattern ?? "")
          .trim()
          .slice(0, 200);
        if (!p || !["title", "domain", "meet_url"].includes(kind)) return 0;
        const dup = q.rules
          .all()
          .find(
            (r) =>
              r.project_id === projectId &&
              r.kind === kind &&
              r.pattern.toLowerCase() === p.toLowerCase()
          );
        return dup ? dup.id : Number(q.addRule.run(projectId, kind, p).lastInsertRowid);
      },
      removeRule: (id) => q.removeRule.run(id),
      list() {
        const files = q.files.all();
        const rules = q.rules.all();
        return q.projects.all().map((p) => ({
          id: p.id,
          name: p.name,
          active: !!p.active,
          instructions: p.instructions ?? "",
          plan: p.plan ?? "",
          rules: rules
            .filter((r) => r.project_id === p.id)
            .map((r) => ({ id: r.id, kind: r.kind, pattern: r.pattern })),
          files: files
            .filter((f) => f.project_id === p.id)
            .map((f) => ({
              id: f.id,
              path: f.path,
              name: f.name,
              kind: f.kind ?? null,
              status: f.status ?? "queued",
              stage: f.stage ?? null,
              error: f.error ?? null,
              note: f.note ?? null,
              summary: f.summary ?? null,
              bytes: f.bytes ?? null,
              chunks: f.chunk_count ?? 0,
              cost: f.cost ?? 0,
            })),
        }));
      },
      create: (name) =>
        Number(q.addProject.run(String(name).trim() || "Project", now()).lastInsertRowid),
      rename: (id, name) => q.renameProject.run(String(name).trim() || "Project", id),
      setActive: (id, active) => q.activeProject.run(active ? 1 : 0, id),
      remove: (id) =>
        db.transaction(
          () => (
            db
              .prepare("SELECT id FROM copilot_project_files WHERE project_id = ?")
              .all(id)
              .forEach((f) => rag.removeFile(f.id, id)),
            q.removeProjectFiles.run(id),
            q.removeProjectRules.run(id),
            q.removeProject.run(id)
          )
        )(),
      addFile: (projectId, filePath, name) =>
        Number(q.addFile.run(projectId, filePath, name, now()).lastInsertRowid),
      removeFile(id) {
        const f = rag.file(id);
        if (f) rag.removeFile(id, f.project_id);
        q.removeFile.run(id);
      },
      activeFiles: () => q.activeFiles.all(),
      activeIds: () =>
        db
          .prepare("SELECT id FROM copilot_projects WHERE active = 1")
          .all()
          .map((r) => r.id),
      addFileRow(projectId, filePath, name) {
        const id = Number(q.addFile.run(projectId, filePath, name, now()).lastInsertRowid);
        return { id, project_id: projectId, path: filePath, name };
      },
    },
    rag,
    close: () => db.close(),
  };
}

module.exports = { openStore };
