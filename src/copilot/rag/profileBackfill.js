// Backfills missing or stale file profiles from chunks already stored in SQLite.
// Runs sequentially in the background; never re-reads files from disk and never re-embeds vectors.
const { PROFILE_VERSION } = require("./profile");
const { buildProfile } = require("./profileBuilder");

async function backfillProfiles({
  rag,
  ask,
  log = () => {},
  now = Date.now,
  version = PROFILE_VERSION,
} = {}) {
  let done = 0;
  let failed = 0;

  if (!rag || typeof rag.staleProfiles !== "function" || typeof ask !== "function") {
    return { done, failed };
  }

  let stale = [];
  try {
    stale = rag.staleProfiles(version) || [];
  } catch (error) {
    log({ event: "profile_backfill_failed", error: error.message });
    return { done, failed };
  }

  for (const file of stale) {
    try {
      const chunks = typeof rag.fileChunks === "function" ? rag.fileChunks(file.id) : [];
      if (!chunks.length) continue;

      const res = await buildProfile({
        ask,
        name: file.name,
        kind: file.kind,
        chunks,
        log,
        now,
      });

      if (res && res.profile && typeof rag.setFile === "function") {
        rag.setFile(file.id, {
          profile: JSON.stringify(res.profile),
          profile_v: version,
        });
        done++;
      }
    } catch (error) {
      log({
        event: "profile_backfill_failed",
        file_id: file.id,
        error: error.message,
      });
      failed++;
    }
  }

  return { done, failed };
}

module.exports = { backfillProfiles };
