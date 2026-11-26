// Electron-free policy for paths that arrive from the renderer. The renderer is the less-trusted side: a path it
// supplies may only reach the indexer (and from there external embedding/LLM APIs) if it is a registered repo or a
// regular, non-secret file.
const fs = require("fs");
const path = require("path");

const SECRET_DIRS = new Set([".ssh", ".aws", ".gnupg", ".kube", ".docker"]);
const SECRET_NAME = [
  /^\.env(\..+)?$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|ppk)$/i,
  /^credentials(\..+)?$/i,
  /^secrets?(\..+)?$/i,
  /^\.(npmrc|netrc|pypirc|git-credentials)$/i,
  /^kubeconfig$/i,
];

// Splits on both separators so a Windows path is judged the same on any host.
const parts = (p) =>
  String(p)
    .split(/[\\/]+/)
    .filter(Boolean);

// System locations hold credentials (/etc/shadow) or are not user documents at all.
const SYSTEM_ROOTS = new Set(["etc", "proc", "sys", "dev", "root", "boot"]);

function isSecretPath(p) {
  if (typeof p !== "string" || !p) return false;
  const segs = parts(p);
  if (/^[\\/]/.test(p) && segs.length && SYSTEM_ROOTS.has(segs[0].toLowerCase())) return true;
  if (segs.slice(0, -1).some((s) => SECRET_DIRS.has(s.toLowerCase()))) return true;
  const name = segs[segs.length - 1] || "";
  if (SECRET_DIRS.has(name.toLowerCase())) return true;
  return SECRET_NAME.some((re) => re.test(name));
}

// A code-* call may only name a repo the user added through the folder picker.
function resolveRegisteredRepo(repoDir, repos) {
  if (typeof repoDir !== "string" || !repoDir) return null;
  const abs = path.resolve(repoDir);
  for (const r of Array.isArray(repos) ? repos : []) {
    if (r && typeof r.path === "string" && path.resolve(r.path) === abs) return abs;
  }
  return null;
}

function checkDroppedFile(p) {
  if (typeof p !== "string" || !path.isAbsolute(p))
    return { ok: false, reason: "not an absolute path" };
  if (isSecretPath(p)) return { ok: false, reason: "looks like a secret or credential file" };
  let real;
  try {
    real = fs.realpathSync(p);
    if (!fs.statSync(real).isFile()) return { ok: false, reason: "not a regular file" };
  } catch {
    return { ok: false, reason: "file not found" };
  }
  // The visible name can be harmless while the link target is a key.
  if (real !== p && isSecretPath(real)) return { ok: false, reason: "symlink to a secret file" };
  return { ok: true, path: p };
}

module.exports = { isSecretPath, resolveRegisteredRepo, checkDroppedFile };
