// One JSON line per indexing stage and per search, so a missed answer can be traced from the question to the chunk
// (see docs/copilot/RAG_PLAN.md). File is cut when it passes MAX_BYTES. Electron-free.
//
// Questions come from live meeting transcripts, so by default only their length and a short hash are written
// (repeats stay traceable, words do not). `logContent: true` or COPILOT_LOG_CONTENT=1 keeps the text for debugging.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MAX_BYTES = 4 * 1024 * 1024;
const CONTENT_KEYS = ["question", "query"];

const shortHash = (text) => crypto.createHash("sha256").update(text).digest("hex").slice(0, 12);

function withoutContent(record) {
  const out = { ...record };
  for (const key of CONTENT_KEYS) {
    if (typeof out[key] !== "string") continue;
    out[`${key}_len`] = out[key].length;
    out[`${key}_hash`] = shortHash(out[key]);
    delete out[key];
  }
  return out;
}

function createRagLog({
  dir,
  echo = false,
  now = Date.now,
  logContent = process.env.COPILOT_LOG_CONTENT === "1",
  onError = (error) =>
    console.error("[copilot-rag] could not write the retrieval log:", error?.message),
}) {
  if (!dir) return () => {};
  const file = path.join(dir, "copilot-rag.jsonl");
  let reported = false;
  return (record) => {
    const safe = logContent ? record : withoutContent(record);
    const line = JSON.stringify({ at: new Date(now()).toISOString(), ...safe });
    if (echo) console.log(`[copilot-rag] ${line}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) fs.rmSync(file);
      fs.appendFileSync(file, line + "\n", { mode: 0o600 });
    } catch (error) {
      if (!reported) {
        reported = true; // once: a full disk must not turn every question into a log line about the log
        onError(error);
      }
    }
  };
}

module.exports = { createRagLog };
