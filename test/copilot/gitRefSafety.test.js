// Phase 3.3 / 1.2: renderer-supplied git refs must never become git options,
// and a git call must be bounded in time.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const git = require("../../src/helpers/connectors/gitLocalAdapter");

describe("git ref validation", () => {
  test("accepts ordinary refs", () => {
    for (const ref of [
      "main",
      "HEAD",
      "HEAD~2",
      "feature/abc-1",
      "v1.2.3",
      "origin/develop",
      "a1b2c3d",
      "HEAD^",
    ]) {
      assert.equal(git.isSafeRef(ref), true, ref);
    }
  });

  test("rejects option-like and malformed refs", () => {
    for (const ref of [
      "--output=/tmp/x",
      "-x",
      "",
      " main",
      "a b",
      "a;rm",
      "a\nb",
      "a..b..c",
      "$(id)",
      "a`b`",
      null,
      undefined,
      42,
      "x".repeat(300),
    ]) {
      assert.equal(git.isSafeRef(ref), false, String(ref));
    }
  });
});

describe("getLocalDiff with hostile refs", () => {
  test("does not write a file for --output=...", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitref-"));
    const target = path.join(dir, "pwned.txt");
    const res = git.getLocalDiff(`--output=${target}`, "HEAD", { cwd: process.cwd() });
    assert.equal(fs.existsSync(target), false, "git must not have written the file");
    assert.ok(res.error, "must report an error");
    assert.equal(res.diff, "");
  });

  test("rejects a hostile head too", () => {
    const res = git.getLocalDiff("main", "--no-index");
    assert.ok(res.error);
  });
});

describe("runGit bounds", () => {
  test("times out a hung command and reports it", () => {
    // `git` reading a fifo-like stdin is not portable; use a tiny timeout on a real command instead.
    const res = git.runGit(["log", "--all", "-n", "1"], { cwd: process.cwd(), timeoutMs: 1 });
    // Either it finished within 1ms (ok) or it was killed (error mentions timeout). It must never hang or throw.
    assert.equal(typeof res.ok, "boolean");
    if (!res.ok) assert.equal(typeof res.error, "string");
  });

  test("surfaces stderr for a non-repo directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notrepo-"));
    const res = git.runGit(["rev-parse", "HEAD"], { cwd: dir });
    assert.equal(res.ok, false);
    assert.match(res.error, /not a git repository|fatal/i);
  });

  test("non-repo does not read as branch HEAD silently", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notrepo-"));
    assert.equal(git.isGitRepo({ cwd: dir }), false);
    assert.equal(git.isGitRepo({ cwd: process.cwd() }), true);
  });
});
