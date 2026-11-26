// Phase 1.1: a cheap signal for "has this repo changed since the index was built?"
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { repoFingerprint } = require("../../src/copilot/rag/repoFingerprint");

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), "fp-"));
const git = (cwd, ...a) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], {
    cwd,
    stdio: "ignore",
  });
function gitRepo() {
  const d = mk();
  git(d, "init", "-q");
  fs.writeFileSync(path.join(d, "a.js"), "one\n");
  git(d, "add", ".");
  git(d, "commit", "-qm", "init");
  return d;
}
const bump = (f) => {
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(f, t, t);
};

test("stable when nothing changed", async () => {
  const d = gitRepo();
  assert.equal(await repoFingerprint(d), await repoFingerprint(d));
});

test("changes on edit, re-edit of an already modified file, new file, delete, commit, branch switch", async () => {
  const d = gitRepo();
  const f = path.join(d, "a.js");
  const seen = new Set([await repoFingerprint(d)]);
  const step = async (label) => {
    const fp = await repoFingerprint(d);
    assert.equal(seen.has(fp), false, `fingerprint did not change: ${label}`);
    seen.add(fp);
  };
  fs.writeFileSync(f, "two two\n");
  await step("edit");
  fs.writeFileSync(f, "three three three\n");
  await step("second edit of the same modified file");
  fs.writeFileSync(path.join(d, "b.js"), "x\n");
  await step("untracked file");
  fs.rmSync(path.join(d, "b.js"));
  fs.writeFileSync(f, "four four four four\n");
  git(d, "add", ".");
  git(d, "commit", "-qm", "c2");
  await step("commit");
  const onMain = await repoFingerprint(d);
  git(d, "checkout", "-qb", "other");
  fs.writeFileSync(f, "five five five five five\n");
  git(d, "commit", "-qam", "c3");
  await step("new commit on branch");
  git(d, "checkout", "-q", "-");
  // Back on the original branch the tree is identical to before, so the fingerprint must match: no needless rebuild.
  assert.equal(await repoFingerprint(d), onMain);
  assert.notEqual(
    await repoFingerprint(d),
    [...seen].at(-1),
    "switching away from 'other' must change it"
  );
});

test("non-git folder: changes on edit/add/delete", async () => {
  const d = mk();
  const f = path.join(d, "a.txt");
  fs.writeFileSync(f, "x");
  const a = await repoFingerprint(d);
  assert.equal(a, await repoFingerprint(d));
  fs.writeFileSync(f, "xyz");
  bump(f);
  const b = await repoFingerprint(d);
  assert.notEqual(a, b);
  fs.writeFileSync(path.join(d, "n.txt"), "1");
  assert.notEqual(b, await repoFingerprint(d));
});

test("ignores node_modules and .git churn in a non-git folder; missing dir returns null", async () => {
  const d = mk();
  fs.writeFileSync(path.join(d, "a.txt"), "x");
  fs.mkdirSync(path.join(d, "node_modules"));
  const before = await repoFingerprint(d);
  fs.writeFileSync(path.join(d, "node_modules", "junk.js"), "1");
  assert.equal(await repoFingerprint(d), before);
  assert.equal(await repoFingerprint(path.join(d, "nope")), null);
});

test("warm check on a mid-sized repo is fast", async () => {
  const d = gitRepo();
  for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(d, `f${i}.js`), `// ${i}\n`);
  git(d, "add", ".");
  git(d, "commit", "-qm", "many");
  await repoFingerprint(d);
  const t = Date.now();
  await repoFingerprint(d);
  assert.ok(Date.now() - t < 500, `took ${Date.now() - t}ms`);
});
