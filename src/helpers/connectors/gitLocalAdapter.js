// src/helpers/connectors/gitLocalAdapter.js
// High-performance Offline-Only Local Git Workspace Adapter & Smart Diff Filter.
// Strictly local disk .git inspection: zero GitHub API calls, zero network, zero vector embeddings.
// Electron-free, zero-throw policy.

const { execFileSync } = require("child_process");

const IGNORED_DIFF_PATTERNS = [
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /flake\.lock$/,
  /\.min\.js$/,
  /\.min\.css$/,
  /\.(png|jpg|jpeg|gif|webp|ico|svg|pdf|zip|tar|gz|exe|dll|dylib|so|pyc)$/i,
];

const DEFAULT_GIT_TIMEOUT_MS = 10_000;
const SAFE_REF = /^[A-Za-z0-9_][A-Za-z0-9_./@^~{}-]*$/;
const MAX_REF_LENGTH = 200;

// A renderer-supplied ref must never be parsed by git as an option (e.g. --output=/path).
function isSafeRef(ref) {
  return (
    typeof ref === "string" &&
    ref.length > 0 &&
    ref.length <= MAX_REF_LENGTH &&
    SAFE_REF.test(ref) &&
    !ref.includes("..")
  );
}

/**
 * Safely runs a local git command using execFileSync (prevents shell injection). Never throws.
 * Bounded by a timeout; stderr is captured so callers can tell "not a repo" from "empty".
 */
function runGit(
  args,
  { cwd = process.cwd(), maxBuffer = 10 * 1024 * 1024, timeoutMs = DEFAULT_GIT_TIMEOUT_MS } = {}
) {
  try {
    const argList = Array.isArray(args) ? args : String(args).trim().split(/\s+/);
    const stdout = execFileSync("git", argList, {
      cwd,
      maxBuffer,
      timeout: timeoutMs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output: stdout.trim() };
  } catch (error) {
    const stderr = error && error.stderr ? String(error.stderr).trim() : "";
    const timedOut = error && (error.code === "ETIMEDOUT" || error.signal === "SIGTERM");
    return {
      ok: false,
      output: "",
      error: timedOut ? `git timed out after ${timeoutMs}ms` : stderr || error.message,
    };
  }
}

function isGitRepo(options = {}) {
  return runGit(["rev-parse", "--is-inside-work-tree"], options).output === "true";
}

/**
 * Gets the active checked out branch name.
 */
function getCurrentBranch(options = {}) {
  const res = runGit(["rev-parse", "--abbrev-ref", "HEAD"], options);
  return res.ok && res.output ? res.output : "HEAD";
}

/**
 * Lists local and remote tracking branches known to the local .git directory.
 */
function listLocalBranches(options = {}) {
  const res = runGit(
    ["branch", "-a", "--format=%(HEAD)|%(refname:short)|%(objectname:short)|%(upstream:short)|%(subject)"],
    options
  );
  if (!res.ok || !res.output) return [];

  const branches = [];
  for (const line of res.output.split("\n")) {
    const [headMarker, name, sha, upstream, ...subjectParts] = line.split("|");
    if (name && name.trim()) {
      const cleanName = name.trim();
      branches.push({
        name: cleanName,
        sha: sha ? sha.trim() : "",
        upstream: upstream ? upstream.trim() : null,
        lastCommitSubject: subjectParts.join("|").trim(),
        isCurrent: (headMarker || "").trim() === "*",
      });
    }
  }
  return branches;
}

/**
 * Gets recent local commit history with author, SHA, date, and message.
 */
function getGitLog({ count = 20, branch = "HEAD" } = {}, options = {}) {
  const n = String(Math.max(1, Math.min(Number(count) || 20, 200)));
  const res = runGit(
    ["log", "-n", n, "--format=%H|%h|%an|%ad|%s", "--date=short", isSafeRef(branch) ? branch : "HEAD", "--"],
    options
  );
  if (!res.ok || !res.output) return [];

  const commits = [];
  for (const line of res.output.split("\n")) {
    const [fullSha, sha, author, date, ...msgParts] = line.split("|");
    if (sha) {
      commits.push({
        sha: sha.trim(),
        fullSha: fullSha.trim(),
        author: author.trim(),
        date: date.trim(),
        message: msgParts.join("|").trim(),
      });
    }
  }
  return commits;
}

/**
 * Vectorless lexical & BM25-style commit search over local git history.
 * Searches commit messages + changed file paths with zero vector embeddings.
 */
function searchCommits(query, { cwd = process.cwd(), branch = "HEAD", count = 80 } = {}) {
  const tokens = String(query || "")
    .toLowerCase()
    .match(/[a-z0-9_.-]{2,}/g) || [];
  if (!tokens.length) return [];

  const res = runGit(
    [
      "log",
      "-n",
      String(count),
      "--name-only",
      "--format=@@COMMIT@@%H|%h|%an|%ad|%s",
      "--date=short",
      isSafeRef(branch) ? branch : "HEAD",
      "--",
    ],
    { cwd }
  );
  if (!res.ok || !res.output) return [];

  const blocks = res.output.split("@@COMMIT@@").filter(Boolean);
  const scored = [];

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    const header = lines[0] || "";
    const [fullSha, sha, author, date, ...msgParts] = header.split("|");
    const message = msgParts.join("|").trim();
    const files = lines.slice(1).map((f) => f.trim()).filter(Boolean);
    const haystack = `${sha} ${author} ${message} ${files.join(" ")}`.toLowerCase();

    let score = 0;
    const matchedTerms = [];
    for (const tok of new Set(tokens)) {
      if (haystack.includes(tok)) {
        // Weight exact message or file matches higher than generic overlaps
        const inMsg = message.toLowerCase().includes(tok);
        const inFile = files.some((f) => f.toLowerCase().includes(tok));
        score += (inMsg ? 2.5 : 0) + (inFile ? 2.0 : 0) + (!inMsg && !inFile ? 1.0 : 0);
        matchedTerms.push(tok);
      }
    }

    if (score > 0) {
      scored.push({
        sha: sha.trim(),
        fullSha: fullSha.trim(),
        author: author.trim(),
        date: date.trim(),
        message,
        files,
        score: Number(score.toFixed(2)),
        matchedTerms,
      });
    }
  }

  return scored.sort((a, b) => b.score - a.score);
}

/**
 * Filters raw git diff output to remove noisy lockfiles, binaries, and minified bundles.
 */
function filterDiff(rawDiff, { maxChars = 20000 } = {}) {
  if (!rawDiff) return { diff: "", truncated: false, stats: { filesChanged: 0, keptFiles: 0, droppedFiles: [] } };

  const fileChunks = rawDiff.split(/^diff --git /m);
  const keptChunks = [];
  const droppedFiles = [];
  let filesChanged = 0;

  for (const chunk of fileChunks) {
    if (!chunk.trim()) continue;
    filesChanged++;
    const firstLine = chunk.split("\n")[0] || "";
    const match = /a\/(.+?)\s+b\/(.+)/.exec(firstLine);
    const filename = match ? match[2] : "";

    const isIgnored = IGNORED_DIFF_PATTERNS.some((pattern) => pattern.test(filename));
    if (isIgnored) {
      droppedFiles.push(filename);
      continue;
    }
    keptChunks.push("diff --git " + chunk);
  }

  let finalDiff = keptChunks.join("");
  const truncated = finalDiff.length > maxChars;
  if (truncated) {
    finalDiff = finalDiff.slice(0, maxChars) + "\n\n... [Diff truncated to stay within token limits]";
  }

  return {
    diff: finalDiff.trim(),
    truncated,
    stats: {
      filesChanged,
      keptFiles: filesChanged - droppedFiles.length,
      droppedFiles,
    },
  };
}

/**
 * Computes a smart, token-efficient diff between two local git references.
 */
function getLocalDiff(base = "main", head = "HEAD", { maxChars = 20000, cwd = process.cwd() } = {}) {
  const empty = { filesChanged: 0, keptFiles: 0, droppedFiles: [] };
  if (!isSafeRef(base) || !isSafeRef(head)) {
    return { diff: "", error: "invalid git ref", stats: empty };
  }
  // --end-of-options keeps a ref from ever being read as a flag; "--" ends the revision list.
  let res = runGit(["diff", "--end-of-options", `${base}...${head}`, "--"], { cwd });
  if (!res.ok) {
    res = runGit(["diff", "--end-of-options", base, head, "--"], { cwd });
  }
  if (!res.ok) {
    return { diff: "", error: res.error, stats: empty };
  }
  const statRes = runGit(["diff", "--stat", "--end-of-options", `${base}...${head}`, "--"], { cwd });
  return {
    ...filterDiff(res.output, { maxChars }),
    diffStat: statRes.ok ? statRes.output : "",
  };
}

module.exports = {
  IGNORED_DIFF_PATTERNS,
  runGit,
  isGitRepo,
  isSafeRef,
  getCurrentBranch,
  listLocalBranches,
  getGitLog,
  searchCommits,
  filterDiff,
  getLocalDiff,
};
