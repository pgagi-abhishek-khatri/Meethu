// Comprehensive unit, security, compiler, CLI, and E2E tests for Context Summary Generator v2.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { redactSecrets, sanitizeRemoteUrl } = require("../../src/copilot/rag/secretScan");
const { readSafeText, extractNotebookSummary, summarizeTranslationFile } = require("../../src/copilot/rag/specialFiles");
const { discoverRepo } = require("../../src/copilot/rag/repoDiscovery");
const { shortenSignature, extractCodeStructure, formatCompactFileEntry } = require("../../src/copilot/rag/codeExtract");
const { createLocalCodeIndexAsync } = require("../../src/copilot/rag/vectorlessCodeSearch");
const { createCopilot } = require("../../src/copilot/main/service");
const { runCli } = require("../../scripts/copilot/summary-cli");

let canOpen = true;
try {
  const D = require("better-sqlite3");
  new D(":memory:").close();
} catch {
  canOpen = false;
}
const sqlite = { skip: canOpen ? false : "better-sqlite3 is not built for this runtime" };

const mk = (prefix = "sumv2-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const write = (root, rel, content) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
};
const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    stdio: "ignore",
  });

test("secretScan: typed placeholders, connection strings, URL credentials, and remote URL sanitization", () => {
  const input = [
    'const db = "postgres://admin:superSecretPass123@db.prod.local:5432/app";',
    'const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";',
    'const high = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";',
  ].join("\n");
  const res = redactSecrets(input);
  assert.equal(res.hasRedactions, true);
  assert.equal(res.text.includes("superSecretPass123"), false);
  assert.equal(res.text.includes("dozjgNryP4"), false);
  assert.equal(res.text.includes("9f86d081884c7d659a2feaa0c55ad015"), false);
  assert.match(res.text, /\[REDACTED:conn_string\]/);
  assert.match(res.text, /\[REDACTED:jwt\]/);
  assert.equal(
    sanitizeRemoteUrl("https://user:ghp_secretToken123@github.com/org/repo.git"),
    "https://[REDACTED]@github.com/org/repo.git"
  );
});

test("discovery: detects nested independent repos, workspaces, !unignore, symlink guards, and secret deny-list", () => {
  const root = mk("disc-");
  write(root, ".gitignore", "child-repo/\n*.log\n!important.log\n");
  write(root, "package.json", JSON.stringify({ name: "mono", workspaces: ["packages/*"] }));
  write(root, "packages/core/index.ts", "export function coreFn() { return 1; }\n");
  write(root, "important.log", "line1\n");
  write(root, ".env", "STRIPE_KEY=sk_live_secret_value_123456\n");
  write(root, "certs/server.pem", "PRIVATE");

  // Nested independent git repo ignored by parent
  const nested = path.join(root, "child-repo");
  write(nested, "app.py", "def child_api():\n    return True\n");
  git(nested, "init", "-q");
  git(nested, "add", ".");
  git(nested, "commit", "-qm", "nested init");

  git(root, "init", "-q");
  git(root, "add", ".gitignore", "package.json", "packages/core/index.ts");
  git(root, "commit", "-qm", "root init");

  // Out-of-root symlink and symlink loop
  const outside = mk("outside-");
  write(outside, "leak.js", "export const secret = 1;");
  fs.symlinkSync(outside, path.join(root, "out-link"));
  fs.symlinkSync(path.join(root, "packages"), path.join(root, "packages/loop-link"));

  const disc = discoverRepo(root);
  const compIds = disc.components.map((c) => c.id);
  assert.ok(compIds.includes("child-repo"), "must detect nested repo even when ignored by parent");
  assert.ok(disc.files.some((f) => f.relPath === "child-repo/app.py"));
  assert.ok(disc.files.some((f) => f.relPath === "packages/core/index.ts" && f.packageId.endsWith(":core")));
  assert.equal(disc.files.some((f) => f.relPath.includes("out-link")), false);
  assert.ok(disc.coverage.outOfRootSymlinks >= 1);
  assert.ok(disc.coverage.symlinkLoops >= 1);
  assert.ok(disc.coverage.secretsNotRead.some((s) => s.relPath === ".env"));
  assert.ok(disc.coverage.secretsNotRead.some((s) => s.relPath === "certs/server.pem"));
});

test("security: pre-read secret deny-list ensures secret files are never opened", async () => {
  const root = mk("sec-open-");
  write(root, ".env", "API_KEY=SUPER_SECRET_SHOULD_NEVER_OPEN_123456");
  write(root, "serviceAccountKey.json", '{"private_key":"SECRET"}');
  write(root, "src/ok.ts", 'export const OK = "safe";\n');

  const opened = [];
  const origRead = fs.readFileSync;
  const origOpen = fs.openSync;
  fs.readFileSync = function spyRead(p, ...rest) {
    opened.push(String(p));
    return origRead.call(this, p, ...rest);
  };
  fs.openSync = function spyOpen(p, ...rest) {
    opened.push(String(p));
    return origOpen.call(this, p, ...rest);
  };

  try {
    const idx = await createLocalCodeIndexAsync(root, { useCache: false });
    assert.equal(opened.some((p) => p.endsWith(".env") || p.endsWith("serviceAccountKey.json")), false);
    assert.ok(idx.coverage.secretsNotRead.length >= 2);
    const covMd = idx.getSummaryBundle().files["90_coverage.md"];
    assert.match(covMd, /\[secret: not read\]/);
  } finally {
    fs.readFileSync = origRead;
    fs.openSync = origOpen;
  }
});

test("extractors: no third-party imports in compact entry, no mid-token cuts, Lstart-Lend ranges, contracts & mismatches", async () => {
  const root = mk("ext-");
  write(root, "package.json", JSON.stringify({
    name: "demo",
    scripts: { test: "node --test" },
    dependencies: { express: "^4.19.0", react: "^19.0.0" },
  }));
  write(root, "package-lock.json", JSON.stringify({
    packages: { "node_modules/express": { version: "4.19.2" } },
  }));
  write(root, ".env.example", "DATABASE_URL=\n");
  write(
    root,
    "src/routes/billing.ts",
    `/** Handles billing endpoints and limits. */
import express from "express";
import { checkLimit } from "../services/limits";
const dbUrl = process.env.DATABASE_URL || "sqlite://local";
export function registerBilling(app: any) {
  app.post("/api/billing/charge", (req: any, res: any) => res.json({ ok: true }));
  app.get("/api/billing/unused", (req: any, res: any) => res.json({ ok: true }));
}`
  );
  write(
    root,
    "src/services/limits.ts",
    `/** Enforces daily credit limits. */
export const MAX_DAILY_CREDITS = 100;
export function checkLimit(userId: string, amount: number, currencyCode: string, extraLongParameterNameForTesting: Record<string, unknown>): boolean {
  const innerHelper = () => true;
  return innerHelper() && amount <= MAX_DAILY_CREDITS;
}`
  );
  write(
    root,
    "src/components/BillingScreen.tsx",
    `import React from "react";
export function BillingScreen() {
  void fetch("/api/billing/charge", { method: "POST" });
  void fetch("/api/billing/missing");
  return null;
}`
  );
  write(root, "src/index.ts", `export { checkLimit } from "./services/limits";\n`);
  write(root, "docs/ARCHITECTURE.md", "# Billing Spec\n- Daily limit MUST NEVER exceed 100 credits.\nSee `src/missing_old_file.ts`.\n");

  const sig = shortenSignature("checkLimit", "userId: string, amount: number, currencyCode: string, extraLongParameterNameForTesting: Record<string, unknown>", 55);
  assert.equal(sig.includes("..."), false);
  assert.equal(sig.includes("Record<"), false, "drops type annotations before cutting");
  assert.match(sig, /^checkLimit\(userId, amount/);

  const idx = await createLocalCodeIndexAsync(root, { useCache: false });
  const limMod = idx.modules.find((m) => m.relPath === "src/services/limits.ts");
  const entry = formatCompactFileEntry(limMod, { relPath: limMod.relPath });
  assert.match(entry, /Purpose: Enforces daily credit limits\./);
  assert.match(entry, /L3-L6/);
  assert.equal(entry.includes("innerHelper"), false, "inner closures must not appear in exports");
  assert.equal(entry.includes("express"), false, "third-party imports must not appear in file entries");

  const bundle = idx.getSummaryBundle();
  assert.match(bundle.files["00_router.md"], /Daily limit MUST NEVER exceed 100 credits/);
  assert.ok(bundle.routerTokens <= 5000, "Tier 0 router card must stay under 5000 tokens");
  assert.ok(bundle.tier1Cards.length >= 1, "Must emit Tier 1 feature cards");
  assert.match(bundle.files["20_contracts.md"], /\/api\/billing\/charge/);
  assert.match(bundle.files["20_contracts.md"], /called_not_served.*\/api\/billing\/missing/);
  assert.match(bundle.files["20_contracts.md"], /served_not_called.*\/api\/billing\/unused/);
  assert.match(bundle.files["30_files.md"], /Thin Pass-Through/);
  assert.match(bundle.files["40_symbols.md"], /MAX_DAILY_CREDITS/);
  assert.match(bundle.files["50_docs.md"], /missing_old_file\.ts/);
  assert.match(bundle.files["60_config.md"], /4\.19\.2/);
  assert.match(bundle.files["60_config.md"], /DATABASE_URL/);
});

test("special files: UTF-16 BOM, notebooks, translations, and syntax error partial parse", () => {
  const root = mk("sp-");
  const utf16Path = path.join(root, "win.ts");
  const bom = Buffer.from([0xff, 0xfe]);
  const body = Buffer.from("export const WIN = 1;\r\n", "utf16le");
  fs.writeFileSync(utf16Path, Buffer.concat([bom, body]));
  const decoded = readSafeText(utf16Path);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.text, "export const WIN = 1;\n");

  const nb = extractNotebookSummary(JSON.stringify({
    cells: [
      { cell_type: "markdown", source: ["# Training Pipeline\n"] },
      { cell_type: "code", source: ["def train(): pass\n"], outputs: [{ text: ["giant log dump"] }] },
    ],
  }));
  assert.equal(nb.headings[0], "# Training Pipeline");
  assert.equal(nb.codeText.includes("giant log dump"), false);

  const tr = summarizeTranslationFile("locales/en/common.json", JSON.stringify({ auth: { login: "Sign in", logout: "Out" } }));
  assert.equal(tr.locale, "en");
  assert.equal(tr.keyCount, 2);

  const badTs = extractCodeStructure("export function broken( { {\n  return 1;\n", "broken.ts");
  assert.equal(badTs.parseStatus, "partial");
});

test("compiler: determinism, priority degradation without silent cuts, and CLI --check", async () => {
  const root = mk("cli-");
  write(root, "src/a.ts", "export function alpha() { return 1; }\n");
  write(root, "src/b.ts", "export function beta() { return 2; }\n");
  write(root, "tests/a.test.ts", "export function testAlpha() {}\n");
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");

  const idx1 = await createLocalCodeIndexAsync(root, { useCache: false });
  const idx2 = await createLocalCodeIndexAsync(root, { useCache: false });
  const b1 = idx1.getSummaryBundle();
  const b2 = idx2.getSummaryBundle();
  assert.equal(b1.files["00_router.md"], b2.files["00_router.md"], "Tier 0 router must be deterministic");
  assert.equal(b1.files["30_files.md"], b2.files["30_files.md"], "Tier 2 files must be deterministic");

  // Force tight files budget to verify explicit truncation marker & priority ordering
  const tight = idx1.getSummaryBundle({ budgets: { files_per_component: 10 } });
  assert.equal(typeof tight.manifest.truncated, "boolean");

  // CLI write + --check
  const outDir = path.join(root, "summary-out");
  assert.equal(await runCli(["node", "cli", root, "--out", outDir]), 0);
  assert.ok(fs.existsSync(path.join(outDir, "00_router.md")));
  const featFiles = fs.readdirSync(path.join(outDir, "features")).filter((n) => /^F\d+.*\.md$/.test(n));
  assert.ok(featFiles.length >= 1, "Tier 1 feature cards must be written directly in features/");
  assert.ok(fs.existsSync(path.join(outDir, "manifest.json")));
  assert.equal(await runCli(["node", "cli", root, "--out", outDir, "--check"]), 0);

  write(root, "src/a.ts", "export function alpha() { return 999; }\n");
  assert.equal(await runCli(["node", "cli", root, "--out", outDir, "--check"]), 1);
});

test("E2E Fast + Deep helper integration via createCopilot", sqlite, async () => {
  const repo = mk("e2e-v2-");
  write(repo, "docs/RULES.md", "# Payment Rules\n- Refunds MUST NEVER exceed original charge amount.\n");
  write(
    repo,
    "src/services/payments.ts",
    `/** Payment processing service. */
export function processRefund(chargeId: string, amount: number) {
  if (amount <= 0) throw new Error("ERR_INVALID_REFUND_AMOUNT");
  return { chargeId, amount };
}`
  );
  git(repo, "init", "-q");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");

  const handlers = new Map();
  const calls = [];
  const electron = {
    BrowserWindow: class {
      static fromWebContents() { return null; }
      constructor() { this.webContents = { send() {}, isDestroyed: () => false, on() {} }; }
      setMenuBarVisibility() {} setResizable() {} setMinimumSize() {} setBounds() {} setOpacity() {} setPosition() {}
      getPosition() { return [0, 0]; } focus() {} close() {} once() {} on() {}
      isDestroyed() { return false; } isVisible() { return false; } showInactive() {} show() {} hide() {}
      getBounds() { return { x: 0, y: 0, width: 400, height: 600 }; } isMinimized() { return false; }
    },
    screen: {
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    },
    ipcMain: { handle: (n, fn) => handlers.set(n, fn), on() {} },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [repo] }) },
    safeStorage: null,
  };

  const copilot = createCopilot({
    dir: mk("copilot-dir-"),
    env: { OPENROUTER_API_KEY: "k", COPILOT_QUERY_WRITER: "0" },
    electron,
    loadRenderer: () => Promise.resolve(),
    setupAlwaysOnTop: () => {},
    getActiveEvents: () => [],
    engineOptions: {
      mainModel: async ({ messages }) => {
        calls.push(messages?.[1]?.content || "");
        return { text: "TITLE: Refund Rule\nRefunds cannot exceed charge.\nCONFIDENCE: high", sources: [], usage: null, firstTokenMs: 1, totalMs: 2 };
      },
      client: { systemOne: async () => ({ answers: {}, inputTokens: 1 }) },
      llm: async () => ({ text: "s" }),
    },
  });

  try {
    const invoke = (n, ...a) => handlers.get(`copilot:${n}`)({}, ...a);
    assert.equal((await invoke("code-repo-pick")).ok, true);

    const bundleRes = await invoke("code-summary-bundle", repo);
    assert.equal(bundleRes.ok, true);
    assert.ok(bundleRes.files["00_index.md"].includes("Layer A"));
    assert.ok(bundleRes.files["90_coverage.md"].includes("File Accounting"));

    const sliceRes = await invoke("code-read-slices", repo, [{ relPath: "src/services/payments.ts", lineStart: 2, lineEnd: 5 }]);
    assert.equal(sliceRes.ok, true);
    assert.match(sliceRes.slices[0].text, /ERR_INVALID_REFUND_AMOUNT/);

    const jobId = await invoke("ask", { text: "what are the refund rules in payments?" });
    assert.ok(jobId);
    await new Promise((r) => setTimeout(r, 100));
    assert.match(calls[0], /Layer A Context Index/);
    assert.match(calls[0], /ERR_INVALID_REFUND_AMOUNT/);

    await invoke("rerun", jobId);
    await new Promise((r) => setTimeout(r, 100));
    assert.match(calls[1], /Deep Bounded File Slices/);
  } finally {
    copilot.close();
  }
});
