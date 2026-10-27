// One JSON line per indexing stage and per search, so a missed answer can be traced from the question to the chunk
// (see docs/copilot/RAG_PLAN.md). File is cut when it passes MAX_BYTES. Electron-free.
const fs = require("fs");
const path = require("path");

const MAX_BYTES = 4 * 1024 * 1024;

function createRagLog({ dir, echo = false, now = Date.now }) {
  if (!dir) return () => {};
  const file = path.join(dir, "copilot-rag.jsonl");
  return (record) => {
    const line = JSON.stringify({ at: new Date(now()).toISOString(), ...record });
    if (echo) console.log(`[copilot-rag] ${line}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) fs.rmSync(file);
      fs.appendFileSync(file, line + "\n");
    } catch {}
  };
}

module.exports = { createRagLog };
