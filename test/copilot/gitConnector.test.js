// test/copilot/gitConnector.test.js
// Test suite for Offline-Only Local Git Workspace Adapter & Smart Diff Filter.
// Zero GitHub API calls, zero network dependencies.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const gitLocalAdapter = require("../../src/helpers/connectors/gitLocalAdapter");

describe("Local Git Adapter & Smart Diff Filter (Offline, Vectorless)", () => {
  describe("Local Git Workspace Adapter", () => {
    test("detects active workspace branch accurately", () => {
      const branch = gitLocalAdapter.getCurrentBranch();
      assert(branch, "Should return an active branch name");
      assert.strictEqual(typeof branch, "string");
      assert(branch.length > 0);
    });

    test("lists local branches with commit metadata", () => {
      const branches = gitLocalAdapter.listLocalBranches();
      assert(Array.isArray(branches), "Branches should be an array");
      assert(branches.length > 0, "Should have at least 1 branch");
      const current = branches.find((b) => b.isCurrent);
      assert(current, "Should have marked the active branch");
    });

    test("fetches git commit log and searches commits lexically without vectors", () => {
      const commits = gitLocalAdapter.getGitLog({ count: 5 });
      assert(Array.isArray(commits), "Commits should be an array");
      assert(commits.length > 0, "Should have recent commits");
      assert(commits[0].sha, "Commit should have a short SHA");

      const firstWord = commits[0].message.split(/\s+/).find((w) => w.length > 3) || "okf";
      const hits = gitLocalAdapter.searchCommits(firstWord, { count: 10 });
      assert(Array.isArray(hits), "searchCommits should return array");
    });
  });

  describe("Smart Diff Filter (Noise Reduction)", () => {
    const rawMockDiff = `
diff --git a/package-lock.json b/package-lock.json
index 123..456 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,5 +1,5 @@
-"version": "1.0.0"
+"version": "1.0.1"
diff --git a/src/app.js b/src/app.js
index abc..def 100644
--- a/src/app.js
+++ b/src/app.js
@@ -10,3 +10,4 @@
 function start() {
+  console.log("ready");
 }
diff --git a/assets/logo.png b/assets/logo.png
Binary files a/assets/logo.png and b/assets/logo.png differ
`;

    test("drops lockfiles and binary files from diff payload", () => {
      const filtered = gitLocalAdapter.filterDiff(rawMockDiff);
      assert(!filtered.diff.includes("package-lock.json"), "Must filter package-lock.json");
      assert(!filtered.diff.includes("assets/logo.png"), "Must filter binary png files");
      assert(filtered.diff.includes("src/app.js"), "Must keep source code changes");
      assert.strictEqual(filtered.stats.droppedFiles.length, 2);
      assert.strictEqual(filtered.stats.keptFiles, 1);
    });
  });
});
