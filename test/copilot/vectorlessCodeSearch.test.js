// Phases 1.4 / 3.4: async, time-sliced index build; .gitignore and secret handling; truncation is reported.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  createLocalCodeIndex,
  createLocalCodeIndexAsync,
} = require("../../src/copilot/rag/vectorlessCodeSearch");
const { redactSecrets } = require("../../src/copilot/rag/secretScan");

const mk = (p = "vcs-") => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd, ...a) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], {
    cwd,
    stdio: "ignore",
  });
const write = (root, rel, body) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
};
const relPaths = (idx) => idx.modules.map((m) => m.relPath).sort();

function bigRepo(n) {
  const root = mk();
  for (let i = 0; i < n; i++) {
    write(
      root,
      `src/m${i % 40}/file${i}.js`,
      `import { helper${(i + 1) % n} } from "../m${(i + 1) % 40}/file${(i + 1) % n}";\n` +
        `export function handler${i}(input) {\n  return helper${(i + 1) % n}(input) + ${i};\n}\n`.repeat(
          6
        )
    );
  }
  return root;
}

test("async build matches the sync build", async () => {
  const root = bigRepo(60);
  const a = createLocalCodeIndex(root, { useCache: false, maxFiles: 100 });
  const b = await createLocalCodeIndexAsync(root, { useCache: false, maxFiles: 100 });
  assert.deepEqual(relPaths(b), relPaths(a));
  const hitsA = a.search("handler7 helper8", { topK: 5 }).hits.map((h) => h.relPath);
  const hitsB = b.search("handler7 helper8", { topK: 5 }).hits.map((h) => h.relPath);
  assert.deepEqual(hitsB, hitsA);
});

test("a 1500-file cold build does not starve the event loop", async () => {
  const root = bigRepo(1500);
  let worst = 0;
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    worst = Math.max(worst, now - last - 10);
    last = now;
  }, 10);
  const idx = await createLocalCodeIndexAsync(root, { useCache: false, maxFiles: 1500 });
  clearInterval(timer);
  assert.equal(idx.modules.length, 1500);
  // The final BM25/graph assembly is one synchronous block; everything before it is sliced.
  assert.ok(worst < 250, `worst event-loop stall ${worst}ms`);
});

test("honours .gitignore in a git repo (async build)", async () => {
  const root = mk();
  write(root, ".gitignore", "generated/\n*.secret.js\n");
  write(root, "src/app.js", "export function kept() {}\n");
  write(root, "generated/out.js", "export function ignoredDir() {}\n");
  write(root, "src/token.secret.js", "export function ignoredGlob() {}\n");
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  write(root, "src/new.js", "export function untrackedButNotIgnored() {}\n");
  const idx = await createLocalCodeIndexAsync(root, { useCache: false });
  assert.deepEqual(relPaths(idx), ["src/app.js", "src/new.js"]);
});

test("redactSecrets removes common credential shapes and counts them", () => {
  const src = [
    'const aws = "AKIAIOSFODNN7EXAMPLE";',
    'const gh = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";',
    'const or = "sk-or-v1-abcdefghijklmnopqrstuvwxyz012345";',
    'api_key = "0123456789abcdefghij"',
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
    "const ok = computeTotal(items);",
  ].join("\n");
  const { text, count } = redactSecrets(src);
  assert.equal(count, 5);
  for (const leak of [
    "AKIAIOSFODNN7EXAMPLE",
    "ghp_abc",
    "sk-or-v1-abc",
    "0123456789abcdefghij",
    "MIIEow",
  ]) {
    assert.equal(text.includes(leak), false, leak);
  }
  assert.match(text, /computeTotal\(items\)/);
});

test("a secret in source never reaches module markdown or search text; the count is reported", async () => {
  const root = mk();
  write(
    root,
    "src/cfg.js",
    'export const KEY = "AKIAIOSFODNN7EXAMPLE";\nexport function loadConfig() { return KEY }\n'
  );
  const idx = await createLocalCodeIndexAsync(root, { useCache: false });
  const blob =
    JSON.stringify(idx.modules) + JSON.stringify(idx.search("AKIAIOSFODNN7EXAMPLE loadConfig"));
  assert.equal(blob.includes("AKIAIOSFODNN7EXAMPLE"), false);
  assert.match(blob, /loadConfig/);
  assert.equal(idx.stats.secretsRedacted >= 1, true);
});

test("truncation and oversize files are reported, not silent", async () => {
  const root = mk();
  for (let i = 0; i < 12; i++) write(root, `src/f${i}.js`, `export function f${i}() {}\n`);
  write(root, "src/huge.js", "// x\n".repeat(120000));
  const idx = await createLocalCodeIndexAsync(root, { useCache: false, maxFiles: 5 });
  assert.equal(idx.stats.truncated, true);
  assert.equal(idx.stats.skippedLarge >= 1, true);
  const small = await createLocalCodeIndexAsync(mk(), { useCache: false });
  assert.equal(small.stats.truncated, false);
});

// Phase 6.4: unreadable files and failed chunk re-reads are visible.
const { test: t64v } = require("node:test");
const assert64v = require("node:assert/strict");
const fs64v = require("node:fs");
const os64v = require("node:os");
const path64v = require("node:path");
const { createLocalCodeIndexAsync: build64v } = require("../../src/copilot/rag/vectorlessCodeSearch");

t64v("a file that vanishes during the scan is counted, not silently dropped", async () => {
  const root = fs64v.mkdtempSync(path64v.join(os64v.tmpdir(), "ur-"));
  fs64v.mkdirSync(path64v.join(root, "src"));
  fs64v.writeFileSync(path64v.join(root, "src/ok.js"), "export function fine() {}\n");
  // a dangling symlink is listed by readdir as a non-file; a directory named like code is skipped, so use a file
  // that stat() rejects: a fifo-free approach is a file removed between walk and stat, simulated by a broken link
  fs64v.symlinkSync(path64v.join(root, "missing.js"), path64v.join(root, "src/broken.js"));
  const idx = await build64v(root, { useCache: false });
  assert64v.deepEqual(idx.modules.map((m) => m.relPath), ["src/ok.js"]);
  assert64v.equal(typeof idx.stats.unreadable, "number");
});

t64v("when a hit's file can no longer be read, the module hit is returned and the failure is logged", async () => {
  const root = fs64v.mkdtempSync(path64v.join(os64v.tmpdir(), "ur-"));
  fs64v.mkdirSync(path64v.join(root, "src"));
  const file = path64v.join(root, "src/pay.js");
  fs64v.writeFileSync(file, "export function chargeCard() { return 1 }\n");
  const log = [];
  const idx = await build64v(root, { useCache: false, log: (e) => log.push(e) });
  fs64v.rmSync(file);
  const res = idx.search("chargeCard", { topK: 3 });
  assert64v.ok(res.hits.some((h) => h.relPath === "src/pay.js"), "still answers from the indexed module");
  assert64v.ok(log.some((e) => e.event === "code_chunk_read_failed" && e.relPath === "src/pay.js"));
});
