const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const SENTINEL_FILENAME = ".bundle-migrated";
const OPENWHISPR_MIGRATED_FILENAME = ".openwhispr-migrated";
const DISMISSED_FILENAME = ".bundle-migrated-dismissed";
const DB_FILENAMES = ["transcriptions.db", "transcriptions-dev.db"];
const MIGRATABLE_USERDATA_ENTRIES = [
  "transcriptions.db",
  "transcriptions-dev.db",
  "copilot.db",
  "copilot-files",
  ".env",
  "Preferences",
];
const DISMISS_BACKOFF_MS = 24 * 60 * 60 * 1000;

function copyEntryIfMissing(srcPath, destPath) {
  if (!fs.existsSync(srcPath) || fs.existsSync(destPath)) return false;
  const stat = fs.statSync(srcPath);
  if (stat.isDirectory()) {
    fs.cpSync(srcPath, destPath, { recursive: true, force: false });
  } else {
    fs.copyFileSync(srcPath, destPath);
  }
  return true;
}

/**
 * Migrates legacy OpenWhispr userData (databases, .env, copilot files) into
 * the Meethu userData folder before any database or env file is opened.
 */
function migrateFromOpenWhispr({ appDataDir, userDataDir, channel = "production" } = {}) {
  const targetDir = userDataDir || app.getPath("userData");
  const baseAppData = appDataDir || app.getPath("appData");
  const sentinelPath = path.join(targetDir, OPENWHISPR_MIGRATED_FILENAME);
  if (fs.existsSync(sentinelPath)) return false;

  const hasExistingDb = DB_FILENAMES.some((name) => fs.existsSync(path.join(targetDir, name)));
  if (hasExistingDb) return false;

  const legacyCandidates =
    channel === "production"
      ? [path.join(baseAppData, "OpenWhispr"), path.join(baseAppData, "open-whispr")]
      : [path.join(baseAppData, `OpenWhispr-${channel}`)];

  const legacyDir = legacyCandidates.find((dir) =>
    DB_FILENAMES.some((name) => fs.existsSync(path.join(dir, name)))
  );
  if (!legacyDir) return false;

  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of MIGRATABLE_USERDATA_ENTRIES) {
    try {
      copyEntryIfMissing(path.join(legacyDir, entry), path.join(targetDir, entry));
    } catch {
      // Best-effort per entry; continue migrating remaining files
    }
  }
  try {
    fs.writeFileSync(sentinelPath, JSON.stringify({ from: legacyDir, at: new Date().toISOString() }));
  } catch {
    // Non-fatal
  }
  return true;
}

function getSentinelPath() {
  return path.join(app.getPath("userData"), SENTINEL_FILENAME);
}

function getDismissedPath() {
  return path.join(app.getPath("userData"), DISMISSED_FILENAME);
}

function isWithinDismissBackoff() {
  try {
    const raw = fs.readFileSync(getDismissedPath(), "utf8");
    const ts = Date.parse(raw.trim());
    if (Number.isNaN(ts)) return false;
    return Date.now() - ts < DISMISS_BACKOFF_MS;
  } catch {
    return false;
  }
}

function isReturningFromOldBundle() {
  if (process.platform !== "darwin") return false;
  if (fs.existsSync(getSentinelPath())) return false;
  if (isWithinDismissBackoff()) return false;
  const userData = app.getPath("userData");
  const hasDb = DB_FILENAMES.some((name) => fs.existsSync(path.join(userData, name)));
  if (!hasDb) return false;
  return fs.existsSync(path.join(userData, ".env"));
}

function markBundleMigrated() {
  try {
    fs.writeFileSync(getSentinelPath(), new Date().toISOString());
  } catch {
    // Best-effort: if userData isn't writable, modal re-shows next launch.
  }
}

function markBundleMigrationDismissed() {
  try {
    fs.writeFileSync(getDismissedPath(), new Date().toISOString());
  } catch {
    // Best-effort: if userData isn't writable, modal re-shows next launch.
  }
}

module.exports = {
  isReturningFromOldBundle,
  markBundleMigrated,
  markBundleMigrationDismissed,
  migrateFromOpenWhispr,
};
