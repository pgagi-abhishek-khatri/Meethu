// "Has this repo changed since we indexed it?" in a few ms, without reading file contents and without blocking the
// main process (async git, bounded walk). Compared as an opaque string; null means the folder is unreadable.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const GIT_TIMEOUT_MS = 5000;
const WALK_CAP = 20000;
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  "target",
  "__pycache__",
  ".venv",
]);

const git = (cwd, args) =>
  new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
      (err, stdout) => resolve(err ? null : stdout)
    );
  });

const sha = (s) => crypto.createHash("sha1").update(s).digest("hex");

async function statSig(root, rel) {
  try {
    const st = await fs.promises.stat(path.join(root, rel));
    return `${rel}:${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch {
    return `${rel}:gone`; // a deleted file is part of the state
  }
}

async function gitFingerprint(root) {
  const head = await git(root, ["rev-parse", "HEAD"]);
  if (head === null) return null;
  // Status alone is identical when an already-modified file is edited again, so the changed files' size and mtime join it.
  const status =
    (await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])) ?? "";
  const rels = status
    .split("\0")
    .filter(Boolean)
    .map((e) => e.slice(3));
  const sigs = [];
  for (const rel of rels.slice(0, 5000)) sigs.push(await statSig(root, rel));
  return sha(`git\n${head.trim()}\n${status}\n${sigs.join("\n")}`);
}

async function walkFingerprint(root) {
  const sigs = [];
  const queue = [""];
  while (queue.length && sigs.length < WALK_CAP) {
    const rel = queue.shift();
    let entries;
    try {
      entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue; // an unreadable subfolder is simply not part of the signature
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.isDirectory()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) queue.push(r);
      } else if (e.isFile()) {
        sigs.push(await statSig(root, r));
      }
    }
  }
  sigs.sort();
  return sha(`walk\n${sigs.join("\n")}`);
}

async function repoFingerprint(repoDir) {
  const root = path.resolve(String(repoDir || ""));
  try {
    if (!(await fs.promises.stat(root)).isDirectory()) return null;
  } catch {
    return null;
  }
  return (await gitFingerprint(root)) ?? (await walkFingerprint(root));
}

module.exports = { repoFingerprint };
