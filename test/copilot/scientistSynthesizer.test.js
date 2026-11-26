// Phase 6.2: intent patterns and the synthesizer, against a real temporary git repository.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const patterns = require("../../src/copilot/core/trigger/intentPatterns");
const { ROUTES } = require("../../src/copilot/core/trigger/whenToCallRouter");
const {
  createScientistSynthesizer,
  createScientistSynthesizerAsync,
  parseBranchCompare,
} = require("../../src/copilot/core/answer/scientistSynthesizer");

const anyMatch = (list, text) => list.some((re) => re.test(text));

describe("intent patterns", () => {
  test("direct: greetings, thanks and textbook questions need no retrieval", () => {
    for (const q of ["hello there", "Thanks!", "what is a binary search", "calculate 12 * 7"])
      assert.ok(anyMatch(patterns.DIRECT_PATTERNS, q), q);
    for (const q of [
      "where is the retry logic in openrouter.js",
      "what did the client say about refunds",
    ])
      assert.equal(anyMatch(patterns.DIRECT_PATTERNS, q), false, q);
  });

  test("git canonical: branch, status, head commit, a sha, tags", () => {
    for (const q of [
      "which branch are we on",
      "what is the current branch",
      "show git status",
      "list local branches",
      "what is the latest commit hash",
      "look at commit 1a2b3c4d5e",
      "what is the latest tag",
    ])
      assert.ok(anyMatch(patterns.GIT_CANONICAL_PATTERNS, q), q);
    assert.equal(anyMatch(patterns.GIT_CANONICAL_PATTERNS, "how do plants branch out"), false);
  });

  test("local code: diffs, reasons for changes, symbol searches, file explanations, history", () => {
    for (const q of [
      "compare branch credit with main",
      "why did we change the retry policy",
      "find all places where redactSecrets is used",
      "analyze the code in this repo",
      "where is the definition of fenceRetrieved",
      "how does retrieve.js work",
      "show the git log",
    ])
      assert.ok(anyMatch(patterns.LOCAL_CODE_VECTORLESS_PATTERNS, q), q);
  });

  test("project documents: meeting notes and transcripts", () => {
    assert.ok(anyMatch(patterns.RAG_SEMANTIC_PATTERNS, "who said that in the transcript"));
    assert.equal(anyMatch(patterns.RAG_SEMANTIC_PATTERNS, "compare branch a with b"), false);
  });

  test("the patterns do not blow up on a pathological long input", () => {
    const long = "compare " + "a".repeat(50000);
    const t = Date.now();
    for (const list of Object.values(patterns)) anyMatch(list, long);
    assert.ok(Date.now() - t < 500, `took ${Date.now() - t}ms`);
  });
});

describe("parseBranchCompare", () => {
  test("extracts head and base", () => {
    assert.deepEqual(parseBranchCompare("compare branch credit with main"), {
      head: "credit",
      base: "main",
    });
    assert.deepEqual(parseBranchCompare("diff feature/x against develop"), {
      head: "feature/x",
      base: "develop",
    });
    assert.equal(parseBranchCompare("tell me about the weather"), null);
  });
});

const git = (cwd, ...a) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], {
    cwd,
    stdio: "ignore",
  });

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sci-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(
    path.join(root, "src/billing.js"),
    "export function chargeCustomer(id) { return id }\n"
  );
  git(root, "init", "-q", "-b", "main");
  git(root, "add", ".");
  git(root, "commit", "-qm", "add billing module");
  git(root, "checkout", "-qb", "feature");
  fs.writeFileSync(
    path.join(root, "src/billing.js"),
    "export function chargeCustomer(id) { return id }\nexport function refundCustomer(id) { return -id }\n"
  );
  git(root, "commit", "-qam", "add refund support");
  git(root, "checkout", "-q", "main");
  return root;
}

describe("createScientistSynthesizer", () => {
  test("a question about the current branch routes to git and the report states the branch", () => {
    const root = repo();
    const s = createScientistSynthesizer({ repoDir: root, useCache: false });
    const res = s.analyze("which branch are we on");
    assert.equal(res.route, ROUTES.OKF_CANONICAL);
    assert.match(res.markdown, /Active Branch\*\*: `main`/);
    assert.equal(res.evidence.gitFacts[0].type, "active_branch");
    assert.equal(res.evidence.codeHits.length, 0, "answered from the registry, no code search");
    assert.equal(res.telemetry.vectorCalls, 0);
    assert.equal(res.telemetry.githubApiCalls, 0);
  });

  test("naming a commit by its hash is answered from the registry without scanning code", () => {
    const root = repo();
    const sha = execFileSync("git", ["rev-parse", "--short=10", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const s = createScientistSynthesizer({ repoDir: root, useCache: false });
    const res = s.analyze(`look at commit ${sha}`);
    assert.equal(res.route, ROUTES.OKF_CANONICAL);
    assert.ok(res.evidence.gitFacts.length >= 1, "the commit was found");
    assert.equal(res.evidence.codeHits.length, 0, "and no code search ran");
    assert.match(res.markdown, /add billing module/);
  });

  test("a code question returns ranked hits with the file path and zero vector calls", () => {
    const root = repo();
    const s = createScientistSynthesizer({ repoDir: root, useCache: false });
    const res = s.analyze("where is the definition of chargeCustomer");
    assert.ok(res.evidence.codeHits.some((h) => h.relPath === "src/billing.js"));
    assert.match(res.markdown, /billing\.js/);
    assert.equal(res.telemetry.embeddingTokens, 0);
  });

  test("a branch comparison returns the diff between the branches", () => {
    const root = repo();
    const s = createScientistSynthesizer({ repoDir: root, useCache: false });
    const res = s.analyze("compare feature with main");
    assert.equal(res.evidence.branchComparison.head, "feature");
    assert.match(res.evidence.branchComparison.diff, /refundCustomer/);
  });

  test("a hostile ref in the question is refused, never run as a git option", () => {
    const root = repo();
    const s = createScientistSynthesizer({ repoDir: root, useCache: false });
    const marker = path.join(os.tmpdir(), `pwn-${Date.now()}`);
    let res;
    assert.doesNotThrow(() => (res = s.analyze(`compare --output=${marker} with main`)));
    assert.equal(fs.existsSync(marker), false);
    if (res.evidence.branchComparison)
      assert.ok(res.evidence.branchComparison.error || res.evidence.branchComparison.diff === "");
  });

  test("commit history questions find the commit by its message", () => {
    const root = repo();
    const s = createScientistSynthesizer({ repoDir: root, useCache: false });
    // commit search covers the checked-out branch (HEAD), so ask about a commit on main
    const res = s.analyze("why did we add the billing module");
    assert.ok(res.evidence.commitMatches.some((c) => /billing module/i.test(c.message)));
  });

  test("a folder that is not a git repository still answers code questions", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sci-nogit-"));
    fs.writeFileSync(path.join(root, "a.js"), "export function lonelyHelper() {}\n");
    const s = createScientistSynthesizer({ repoDir: root, useCache: false });
    let res;
    assert.doesNotThrow(() => (res = s.analyze("where is the definition of lonelyHelper")));
    assert.ok(res.evidence.codeHits.some((h) => h.relPath === "a.js"));
  });

  test("the async factory builds the same synthesizer, and a new one sees a new commit", async () => {
    const root = repo();
    const s1 = await createScientistSynthesizerAsync({ repoDir: root, useCache: false });
    assert.ok(s1.analyze("where is the definition of chargeCustomer").evidence.codeHits.length > 0);
    fs.writeFileSync(path.join(root, "notes.txt"), "x");
    git(root, "add", ".");
    git(root, "commit", "-qm", "brand new commit message");
    const s2 = await createScientistSynthesizerAsync({ repoDir: root, useCache: false });
    assert.ok(
      s2
        .analyze("why did we add brand new commit message")
        .evidence.commitMatches.some((c) => /brand new/.test(c.message))
    );
  });
});
