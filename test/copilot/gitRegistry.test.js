// test/copilot/gitRegistry.test.js
// Automated test suite for Offline Local GitRegistry & OKF Lookup Integration.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { GitRegistry, getGitRegistry } = require("../../src/copilot/core/okf/gitRegistry");
const { createAuthoritativeLookupService } = require("../../src/copilot/core/okf/lookup");

describe("OKF Local Git Registry Integration (Vectorless)", () => {
  describe("In-Memory Local Git Registry Operations", () => {
    test("syncs with local git and resolves active branch deterministically (< 2ms)", () => {
      const reg = new GitRegistry();
      const t0 = Date.now();
      const res = reg.lookup("current branch");
      const elapsed = Date.now() - t0;

      assert(res.matched, "Should match active branch");
      assert.strictEqual(res.type, "active_branch");
      assert(res.data.activeBranch, "Should have active branch string");
      assert.strictEqual(res.confidence, 1.0);
      assert(elapsed < 5, `Lookup elapsed ${elapsed}ms should be < 5ms`);
    });

    test("resolves local commit SHA deterministically", () => {
      const reg = new GitRegistry();
      const firstSha = [...reg.commits.keys()][0];
      assert(firstSha, "Should have at least one synced commit SHA");
      const res = reg.lookup(`commit:${firstSha}`);
      assert(res.matched, "Should resolve commit SHA");
      assert.strictEqual(res.type, "commit");
      assert.strictEqual(res.authority, 0.95);
    });
  });

  describe("Integration with Authoritative Lookup Service (ALS)", () => {
    test("AuthoritativeLookup routes local git branch queries to gitRegistry", () => {
      // Warm up in-memory gitRegistry cache before measuring deterministic lookup latency
      getGitRegistry();
      const als = createAuthoritativeLookupService({ manifest: { documents: [] } });
      const res = als.lookupCanonical({ type: "branch", value: "current branch" });

      assert(res.matched, "Should resolve active branch through ALS");
      assert.strictEqual(res.type, "git_entity");
      assert.strictEqual(res.provenance.source, "gitRegistry");
      assert(res.latency_ms < 10, `ALS local git lookup took ${res.latency_ms}ms (expected < 10ms)`);
    });
  });
});

const { test: refreshTest } = require("node:test");
refreshTest("getGitRegistry(refresh) sees a commit made after it was cached", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { execFileSync } = require("node:child_process");
  const { getGitRegistry } = require("../../src/copilot/core/okf/gitRegistry");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "reg-"));
  const g = (...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: d, stdio: "ignore" });
  g("init", "-q");
  fs.writeFileSync(path.join(d, "a"), "1");
  g("add", ".");
  g("commit", "-qm", "first");
  const has = (r) => [...r.commits.values()].some((c) => c.message === "second change");
  assert.equal(has(getGitRegistry(d)), false);
  fs.writeFileSync(path.join(d, "a"), "2");
  g("commit", "-qam", "second change");
  assert.equal(has(getGitRegistry(d)), false, "the cached registry is intentionally unchanged");
  assert.equal(has(getGitRegistry(d, { refresh: true })), true);
});

const { test: t6g } = require("node:test");
t6g("lookup: a commit is found by any 7-40 character prefix of its hash, and an unknown hash is not", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { execFileSync } = require("node:child_process");
  const { GitRegistry } = require("../../src/copilot/core/okf/gitRegistry");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "regsha-"));
  const g = (...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: d, encoding: "utf8" });
  g("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(d, "a"), "1");
  g("add", ".");
  g("commit", "-qm", "first change");
  const full = g("rev-parse", "HEAD").trim();
  const reg = new GitRegistry({ cwd: d });
  for (const len of [7, 8, 10, 12, 40]) {
    const res = reg.lookup(`look at commit ${full.slice(0, len)}`);
    assert.equal(res.matched, true, `prefix length ${len}`);
    assert.equal(res.data.fullSha, full);
  }
  assert.equal(reg.lookup("commit deadbeefdeadbeef").matched, false);
  assert.equal(reg.lookup("the number 1234567 appears").matched, false, "digits that are not a known commit");
});

t6g("lookup: natural ways of asking for the current branch are recognised", () => {
  const { GitRegistry } = require("../../src/copilot/core/okf/gitRegistry");
  const reg = new GitRegistry({ cwd: process.cwd() });
  for (const q of ["which branch are we on", "what branch is this", "what branch is checked out", "current branch", "active branch"]) {
    const res = reg.lookup(q);
    assert.equal(res.type, "active_branch", q);
  }
  assert.equal(reg.lookup("how do plants branch out").matched, false);
});
