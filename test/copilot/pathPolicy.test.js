// Phase 3.1: path policy for renderer-supplied paths.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const policy = require("../../src/copilot/core/validation/pathPolicy");

describe("isSecretPath", () => {
  test("denies common secret files and dirs", () => {
    const denied = [
      "/home/u/.env",
      "/home/u/app/.env.production",
      "/home/u/.ssh/id_rsa",
      "/home/u/.ssh/config",
      "/home/u/id_ed25519",
      "/home/u/certs/server.pem",
      "/home/u/certs/server.key",
      "/home/u/.aws/credentials",
      "/home/u/app/credentials.json",
      "/home/u/app/secrets.yaml",
      "/home/u/.npmrc",
      "/home/u/.netrc",
      "/home/u/.gnupg/pubring.kbx",
      "C:\\Users\\u\\.ssh\\id_rsa",
    ];
    for (const p of denied) assert.equal(policy.isSecretPath(p), true, p);
  });

  test("allows normal project files", () => {
    for (const p of [
      "/home/u/app/src/index.js",
      "/home/u/docs/requirements.pdf",
      "/home/u/notes/environment.md",
      "/home/u/app/keyboard.ts",
    ]) {
      assert.equal(policy.isSecretPath(p), false, p);
    }
  });
});

describe("isWithinRegisteredRepo / resolveRegisteredRepo", () => {
  const repos = [{ path: "/work/alpha" }, { path: "/work/beta/" }];

  test("accepts a registered root and returns it resolved", () => {
    assert.equal(policy.resolveRegisteredRepo("/work/alpha", repos), path.resolve("/work/alpha"));
    assert.equal(policy.resolveRegisteredRepo("/work/beta", repos), path.resolve("/work/beta"));
  });

  test("rejects unregistered, parent, sibling and traversal paths", () => {
    for (const p of [
      "/work",
      "/work/gamma",
      "/work/alpha/../gamma",
      "/etc",
      "/work/alpha-evil",
      "",
      null,
      undefined,
      5,
    ]) {
      assert.equal(policy.resolveRegisteredRepo(p, repos), null, String(p));
    }
  });

  test("a subdirectory of a repo is not itself a registered repo root", () => {
    assert.equal(policy.resolveRegisteredRepo("/work/alpha/src", repos), null);
  });
});

describe("checkDroppedFile", () => {
  test("rejects secret names, directories, and missing files; accepts a regular file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-"));
    const good = path.join(dir, "spec.md");
    const env = path.join(dir, ".env");
    fs.writeFileSync(good, "hi");
    fs.writeFileSync(env, "SECRET=1");
    assert.deepEqual(policy.checkDroppedFile(good), { ok: true, path: good });
    assert.equal(policy.checkDroppedFile(env).ok, false);
    assert.equal(policy.checkDroppedFile(dir).ok, false);
    assert.equal(policy.checkDroppedFile(path.join(dir, "nope.txt")).ok, false);
    assert.equal(policy.checkDroppedFile("relative/path.txt").ok, false);
  });

  test("rejects a symlink pointing at a secret", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-"));
    const secret = path.join(dir, "id_rsa");
    const link = path.join(dir, "innocent.txt");
    fs.writeFileSync(secret, "KEY");
    fs.symlinkSync(secret, link);
    const res = policy.checkDroppedFile(link);
    assert.equal(res.ok, false);
    assert.match(res.reason, /secret|symlink/i);
  });
});

describe("system roots", () => {
  test("denies /etc and friends but not a user home path", () => {
    for (const p of ["/etc/shadow", "/etc/passwd", "/proc/self/environ", "/root/x.txt"]) {
      assert.equal(policy.isSecretPath(p), true, p);
    }
    assert.equal(policy.isSecretPath("/home/u/etc/readme.md"), false);
  });
});
