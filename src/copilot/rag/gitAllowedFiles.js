// In a git repo the files worth indexing are the tracked ones plus untracked ones that .gitignore does not exclude.
// Returns a Set of repo-relative paths, or null (not a repo / git unavailable) so the caller falls back to its own walk.
const { execFile } = require("child_process");

const TIMEOUT_MS = 10000;

function gitAllowedFiles(root) {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: root, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
      (err, stdout) => {
        if (err) return resolve(null);
        resolve(new Set(stdout.split("\0").filter(Boolean)));
      }
    );
  });
}

module.exports = { gitAllowedFiles };
