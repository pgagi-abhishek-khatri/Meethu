const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") {
    return { app: { getPath: () => os.tmpdir() } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { migrateFromOpenWhispr } = require("../../src/helpers/postMigrationDetector");

test("migrateFromOpenWhispr copies legacy userData DBs, .env, and copilot files without overwriting", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meethu-migration-test-"));
  try {
    const legacyDir = path.join(root, "OpenWhispr");
    const targetDir = path.join(root, "Meethu");
    fs.mkdirSync(path.join(legacyDir, "copilot-files", "1"), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "transcriptions.db"), "legacy-db-bytes");
    fs.writeFileSync(path.join(legacyDir, "copilot.db"), "legacy-copilot-bytes");
    fs.writeFileSync(path.join(legacyDir, ".env"), "OPENAI_API_KEY=sk-test\n");
    fs.writeFileSync(path.join(legacyDir, "copilot-files", "1", "doc.txt"), "hello");

    const migrated = migrateFromOpenWhispr({
      appDataDir: root,
      userDataDir: targetDir,
      channel: "production",
    });
    assert.equal(migrated, true);
    assert.equal(fs.readFileSync(path.join(targetDir, "transcriptions.db"), "utf8"), "legacy-db-bytes");
    assert.equal(fs.readFileSync(path.join(targetDir, "copilot.db"), "utf8"), "legacy-copilot-bytes");
    assert.equal(fs.readFileSync(path.join(targetDir, ".env"), "utf8"), "OPENAI_API_KEY=sk-test\n");
    assert.equal(
      fs.readFileSync(path.join(targetDir, "copilot-files", "1", "doc.txt"), "utf8"),
      "hello"
    );
    assert.equal(fs.existsSync(path.join(targetDir, ".openwhispr-migrated")), true);

    // Second run is a no-op and never overwrites existing Meethu data.
    fs.writeFileSync(path.join(targetDir, "transcriptions.db"), "new-meethu-db");
    const secondRun = migrateFromOpenWhispr({
      appDataDir: root,
      userDataDir: targetDir,
      channel: "production",
    });
    assert.equal(secondRun, false);
    assert.equal(fs.readFileSync(path.join(targetDir, "transcriptions.db"), "utf8"), "new-meethu-db");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
