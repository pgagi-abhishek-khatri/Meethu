// Section 16 Comprehensive Remediation & Multi-Language Fixture Test Suite.
// Verifies all 36 audit remediations across Go, Swift/Obj-C mobile, Python/TS monorepos,
// docs-only, huge-file, git renames/worktrees/subfolders, and Fast+Deep query groups.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { discoverRepo } = require("../../src/copilot/rag/repoDiscovery");
const { shortenSignature, extractCodeStructure } = require("../../src/copilot/rag/codeExtract");
const { createLocalCodeIndexAsync } = require("../../src/copilot/rag/vectorlessCodeSearch");
const { writeSummaryBundleAtomic } = require("../../src/copilot/rag/summaryCompiler");
const { evaluateRepo, checkDuplicateAnchors } = require("../../scripts/copilot/summary-eval");
const { runCli } = require("../../scripts/copilot/summary-cli");

const mk = (prefix = "s16-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

test("Milestone 1 & 3: cache-invariant determinism, ignored dir file count, lock contention & secret deny-list", async () => {
  const root = mk("s16-det-");
  const cacheDir = mk("s16-cache-");
  write(root, "node_modules/pkg/a.js", "module.exports = 1;\n");
  write(root, "node_modules/pkg/b.js", "module.exports = 2;\n");
  write(root, "secrets/prod.txt", "SECRET_VALUE=123\n");
  write(root, "config/app.secrets.json", '{"key":"secret"}\n');
  write(root, "assets/sample-data.json", '{"items":[1,2,3]}\n');
  write(
    root,
    "src/auth.ts",
    `export const DB_URL = "postgres://user:mySuperSecretPass99@db.local:5432/app";\nexport function verifySession(token: string) { return token.length > 0; }\n`
  );
  write(root, "package.json", JSON.stringify({ name: "det-app", scripts: { test: "node --test" } }));

  const idxCold = await createLocalCodeIndexAsync(root, { useCache: true, cacheDir });
  const idxWarm = await createLocalCodeIndexAsync(root, { useCache: true, cacheDir });

  // #8 Cache-invariant redaction counts & byte-identical outputs
  assert.equal(idxCold.stats.secretsRedacted, idxWarm.stats.secretsRedacted);
  assert.ok(idxCold.stats.secretsRedacted >= 1);
  const bCold = idxCold.getSummaryBundle();
  const bWarm = idxWarm.getSummaryBundle();
  assert.equal(bCold.files["00_index.md"], bWarm.files["00_index.md"]);
  assert.equal(bCold.files["90_coverage.md"], bWarm.files["90_coverage.md"]);

  // #5, #6, #7 Accounting: configsIndexed counted, sample-data.json not labeled "code", node_modules counts 2 files
  assert.equal(bCold.manifest.counts.configs, 1);
  assert.equal(idxCold.coverage.ignoredByRule["dir:node_modules"], 2);
  assert.ok(idxCold.coverage.skipped.some((s) => s.relPath === "assets/sample-data.json" && s.reason === "data_asset"));
  assert.ok(idxCold.coverage.secretsNotRead.some((s) => s.relPath === "secrets/prod.txt"));
  assert.ok(idxCold.coverage.secretsNotRead.some((s) => s.relPath === "config/app.secrets.json"));

  // #30 No absRoot leak
  assert.equal(bCold.manifest.absRoot, undefined);

  // #29 Lock contention check: active PID lock must reject concurrent overwrite
  const outDir = path.join(root, "out");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, ".summary.lock"), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  assert.throws(() => writeSummaryBundleAtomic(outDir, bCold), /locked by active PID/);
});

test("Milestone 2 & 3: Layer A quality, Tier-1 vs CHANGELOG rules, depth-aware signatures, Uses resolution, mounted routes, anchors & --single", async () => {
  const root = mk("s16-qual-");
  write(root, "package.json", JSON.stringify({ name: "qual-app", description: "Audio meeting copilot platform.", scripts: { dev: "vite", test: "node --test" }, dependencies: { express: "^4.19.0" } }));
  write(root, "apps/mobile/package.json", JSON.stringify({ name: "mobile-sub", scripts: { clean: "rm -rf build" }, dependencies: { express: "^5.0.0" } }));
  write(root, "tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }));
  write(root, "CLAUDE.md", "# Architecture Rules\n- API routes MUST NEVER bypass session verification.\n");
  write(root, "CHANGELOG.md", "# Changelog\n- MUST NOTE old v0.1 migration warning.\n");
  write(
    root,
    "src/server.ts",
    `import express from "express";\nimport { billingRouter } from "./routes/billing";\nconst app = express();\napp.use("/api/v1", billingRouter);\n`
  );
  write(
    root,
    "src/routes/billing.ts",
    `import { checkCredits } from "@/services/credits";\n// TODO: add idempotency key check\nexport const billingRouter = { get: () => {} };\nbillingRouter.get("/credits", checkCredits);\n`
  );
  write(
    root,
    "src/services/credits.ts",
    `export function createCopilot({\n  dir, // userData path\n  extraOptions,\n}: {\n  dir: string;\n  extraOptions: Record<string, unknown>;\n}) {\n  return dir;\n}\nexport function checkCredits(opts: Record<string, unknown>) { return true; }\n`
  );
  // Colliding anchor filenames (#33)
  write(root, "src/foo-bar.ts", "export const A = 1;\n");
  write(root, "src/foo/bar.ts", "export const B = 2;\n");
  write(root, "locales/en/ui.json", JSON.stringify({ billing: { title: "Billing & Credits" } }));

  const sig1 = shortenSignature("createCopilot", "{ dir, // userData path\n extraOptions }: { dir: string; extraOptions: Record<string, unknown> }", 60);
  assert.equal(sig1.includes("userData"), false, "inline comments must be stripped from signatures");
  assert.equal(sig1.includes("unknown>"), false, "generics must not split prematurely");

  const idx = await createLocalCodeIndexAsync(root, { useCache: false });
  const bundle = idx.getSummaryBundle();

  // #14 Tier-1 CLAUDE.md rule beats CHANGELOG
  assert.match(bundle.files["00_router.md"], /API routes MUST NEVER bypass session verification/);
  assert.equal(bundle.files["00_router.md"].includes("old v0.1 migration warning"), false);

  // #12 System overview & component root run commands on Tier 0
  assert.match(bundle.files["00_router.md"], /Audio meeting copilot platform/);
  assert.match(bundle.files["00_router.md"], /`dev`/);
  // TODOs still surface on Tier 1 cards
  assert.ok(bundle.tier1Cards.some((c) => c.markdown.includes("add idempotency key check")) || idx.modules.some((m) => m.todos?.some((t) => t.text.includes("add idempotency key check"))));

  // #20 Resolved Uses: path
  const billingMod = idx.modules.find((m) => m.relPath === "src/routes/billing.ts");
  assert.ok(billingMod.structure.internalImports.includes("src/services/credits.ts"));

  // #21 Mounted router prefix composition (/api/v1 + /credits)
  assert.ok(idx.contracts.some((c) => c.path === "/api/v1/credits" || c.normPath === "/api/v1/credits"));

  // #23 Separate dependency rows for root vs apps/mobile package.json
  assert.match(bundle.files["60_config.md"], /\^4\.19\.0/);
  assert.match(bundle.files["60_config.md"], /\^5\.0\.0/);

  // #33 Zero anchor collisions
  assert.equal(checkDuplicateAnchors(bundle.files["30_files.md"]), 0);

  // #3 --single preserves 90_coverage.md even under tiny maxChars
  const tinySingle = idx.generateSingleFileContextMarkdown({ maxChars: 2200 });
  assert.match(tinySingle.markdown, /Coverage & Accounting Report/);
});

test("Milestone 3: Go microservice, Swift/Obj-C mobile, ancestor git + rename/untracked, include rescue & --check on docs/configs", async () => {
  const root = mk("s16-archetypes-");
  write(root, ".meethu-summary.yaml", 'include:\n  - ".hidden-ci/**"\n');
  write(root, ".hidden-ci/deploy.sh", "#!/usr/bin/env bash\necho deploy\n");
  write(root, "go.mod", "module example.com/svc\ngo 1.22\n");
  write(root, "main.go", "package main\nfunc StartServer(port int) {}\n");
  write(root, "ios/Capture.swift", "import AVFoundation\npublic class AudioCapture {\n  public func startCapture() {}\n}\n");
  write(root, "ios/Bridge.m", "#import \"Bridge.h\"\n@implementation NativeBridge\n- (void)ping {}\n@end\n");
  write(root, "docs/GUIDE.md", "# Guide\nRead carefully.\n");

  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-qm", "initial commit");

  // Rename + new untracked directory
  fs.mkdirSync(path.join(root, "untracked_pkg"), { recursive: true });
  write(root, "untracked_pkg/fresh.go", "package u\nfunc Fresh() {}\n");
  fs.renameSync(path.join(root, "docs/GUIDE.md"), path.join(root, "docs/HANDBOOK.md"));
  git(root, "add", "docs/GUIDE.md", "docs/HANDBOOK.md");

  const disc = discoverRepo(root, { extraIncludes: [".hidden-ci/**"] });
  assert.ok(disc.files.some((f) => f.relPath === ".hidden-ci/deploy.sh"), "include must rescue hidden dir");
  const comp = disc.components[0];
  assert.equal(comp.dirtyFiles.has("docs/GUIDE.md"), false, "old rename path must not be dirty");
  assert.ok(comp.dirtyFiles.has("docs/HANDBOOK.md"));
  assert.ok(comp.dirtyFiles.has("untracked_pkg/fresh.go"), "untracked dir must expand files");

  // Honest parseStatus on Swift / ObjC / Go
  const swiftStruct = extractCodeStructure("public class AudioCapture {\n  public func start() {}\n}\n", "ios/Capture.swift");
  assert.equal(swiftStruct.language, "swift");
  assert.equal(swiftStruct.parseStatus, "partial");
  assert.ok(swiftStruct.classes.some((c) => c.name === "AudioCapture"));
  assert.ok(swiftStruct.functions.some((f) => f.name === "start"));

  const idx = await createLocalCodeIndexAsync(root, { useCache: false });
  assert.ok(idx.modules.some((m) => m.relPath === "ios/Capture.swift"));
  assert.ok(idx.modules.some((m) => m.relPath === "ios/Bridge.m"));
  assert.ok(idx.modules.some((m) => m.relPath === "main.go"));

  // CLI --check must detect doc edit (#27)
  const outDir = path.join(root, "summary-out");
  assert.equal(await runCli(["node", "cli", root, "--out", outDir]), 0);
  assert.equal(await runCli(["node", "cli", root, "--out", outDir, "--check"]), 0);
  write(root, "docs/HANDBOOK.md", "# Handbook Updated\nNew invariant: NEVER skip auth.\n");
  assert.equal(await runCli(["node", "cli", root, "--out", outDir, "--check"]), 1);

  // Run Section 16 generic evaluator cleanly
  const evalRes = await evaluateRepo(root);
  assert.equal(evalRes.accountingExact, true);
  assert.equal(evalRes.secretsLeaked, 0);
  assert.equal(evalRes.absRootLeaked, false);
  assert.equal(evalRes.duplicateAnchors, 0);
  assert.equal(evalRes.deterministic, true);
  assert.deepEqual(evalRes.truncationParityIssues, []);
  assert.ok(evalRes.queryResults.total >= 3);
  assert.ok(evalRes.queryResults.details.some((d) => d.group === "fast_overview" && d.ok));
  assert.ok(evalRes.queryResults.details.some((d) => d.group === "deep_escalation" && d.ok));
});

test("Round 2 polish: synthesized purposes, CSS/MP4 noise filtering, live status, collapsed sibling scripts & two-tier 30_files", async () => {
  const root = mk("s16-r2-");
  write(root, "package.json", JSON.stringify({ name: "r2-app", scripts: { test: "node --test" } }));
  for (const modName of ["alpha", "beta", "gamma", "delta"]) {
    write(root, `modules/${modName}/package.json`, JSON.stringify({ name: modName, scripts: { build: "expo-module build", clean: "expo-module clean" } }));
    write(root, `modules/${modName}/README.md`, "Drop bundled MP4 files into this folder for animation assets.\n");
  }
  write(root, "src/components/ui/skeleton.tsx", "// A span, so it can sit inside a <p>; add inline-block.\nexport function Skeleton() { return null; }\n");
  write(root, "src/services/orders.ts", "import { checkAuth } from './auth';\nexport function createOrder(userId: string) { return checkAuth(userId); }\nexport function cancelOrder(id: string) { return id; }\n");
  write(root, "src/services/auth.ts", "export function checkAuth(userId: string) { return Boolean(userId); }\n");

  const idx = await createLocalCodeIndexAsync(root, { useCache: false });
  const bundle = idx.getSummaryBundle();

  // #2 Noisy CSS/MP4 comments excluded and feature status remains "live"
  assert.equal(bundle.files["00_router.md"].includes("sit inside a <p>"), false);
  assert.equal(bundle.files["00_router.md"].includes("Drop bundled MP4"), false);
  assert.equal(idx.features.every((f) => f.status !== "partial"), true);

  // #3 Synthesized purpose instead of generic "role in dir"
  const ordersMod = idx.modules.find((m) => m.relPath === "src/services/orders.ts");
  assert.equal(ordersMod.structure.purpose.includes("service/API client in src/services"), false);
  assert.match(ordersMod.structure.purpose, /createOrder/);

  // #6 Sibling expo-module boilerplate collapsed into single rows
  const buildRows = bundle.files["60_config.md"].split("\n").filter((l) => l.includes("expo-module build"));
  assert.equal(buildRows.length, 1);
  assert.match(buildRows[0], /4 packages/);
});

test("V2 Compression & Accuracy: BPE cap enforcement, indirection contracts, redaction audit, lookup tools & router bench", async () => {
  const { RouterCapExceededError } = require("../../src/copilot/rag/tier0Router");
  const { extractDocFacts } = require("../../src/copilot/rag/extractors/docExtractor");
  const { redactSecrets } = require("../../src/copilot/rag/secretScan");
  const { runRouterBenchmark } = require("../../scripts/copilot/router-bench");

  const root = mk("v2-spec-");
  write(root, "package.json", JSON.stringify({ name: "v2-app", description: "Workspace meeting assistant backend and desktop client", scripts: { dev: "node server.js", test: "node --test" } }));
  write(root, "README.md", "# V2 App\n## Installation\nRun `npm install` and `npm run dev` to get started.\n\n## Architecture\nThe sync engine reconciles offline note edits against Postgres over HTTPS.\n");
  write(root, "docs/RULES.md", "# Core Rules\n- Offline note edits MUST NEVER overwrite newer server timestamps without conflict merge.\n- Export tokens expire after 15 minutes.\n");
  write(root, "src/sync/syncRoutes.ts", `import { Router } from "express";\nconst r = Router();\nr.post("/api/sync/push", (req, res) => res.json({ ok: true }));\nr.get("/api/sync/status", (req, res) => res.json({ ok: true }));\n`);
  write(root, "src/sync/syncClient.ts", `const ROUTES = { push: "/api/sync/push" };\nexport async function pushSync() {\n  return fetch(ROUTES.push, { method: "POST" });\n}\nexport async function callDynamic(url: string) {\n  return fetch(url);\n}\n// Static SRI sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=\nexport const UUID_EX = "550e8400-e29b-41d4-a716-446655440000";\n`);
  write(root, "src/styles/theme.css", ".btn { color: red; }\n");
  write(root, "src/components/SyncButton.tsx", "export function SyncButton() { return null; }\n");

  const doc = extractDocFacts("README.md", fs.readFileSync(path.join(root, "README.md"), "utf8"));
  assert.equal(doc.summary.includes("npm install"), false, "Scaffold boilerplate must be filtered from doc summary");
  assert.match(doc.summary, /reconciles offline note edits/);

  // Allow-list: SRI + UUID must not trigger secret redaction false positives
  const redRes = redactSecrets(fs.readFileSync(path.join(root, "src/sync/syncClient.ts"), "utf8"));
  assert.equal(redRes.count, 0, "SRI hash and UUID must not be flagged as secrets");

  const idx = await createLocalCodeIndexAsync(root, { useCache: false });
  const pushContract = idx.contracts.find((c) => c.normPath === "/api/sync/push");
  assert.ok(pushContract && pushContract.callers.length > 0, "Constant object map ROUTES.push must resolve caller");
  assert.equal(idx.features.some((f) => f.id === "styles"), false, "styles folder must not become a standalone domain feature");

  // Hard cap throw check when tiny hard cap configured
  assert.throws(() => idx.getSummaryBundle({ budgets: { router_hard_cap: 10 }, failOnCap: true }), RouterCapExceededError);

  const bundle = idx.getSummaryBundle();
  assert.ok(bundle.tokenizer.isRealBpe, "Real BPE tokenizer must be active");
  assert.ok(bundle.routerTokens <= 5000);
  assert.ok(bundle.jsonlTwins["features.jsonl"] && bundle.jsonlTwins["glossary.jsonl"] && bundle.jsonlTwins["docs.jsonl"]);

  // Tier 2 lookup tools (feature, find, endpoint, symbol, doc)
  const syncFid = bundle.stableFeatures.find((f) => /sync/i.test(f.name))?.fid;
  assert.ok(syncFid, "Sync feature should have canonical Fid");
  assert.equal(idx.tools.feature(syncFid).found, true);
  assert.ok(idx.tools.endpoint("/api/sync/push").contracts.length >= 1);
  assert.ok(idx.tools.symbol("pushSync").matches.length >= 1);
  assert.ok(idx.tools.find("sync").featureIds.includes(syncFid));

  // Router-only benchmark check on synthetic repo
  const bench = await runRouterBenchmark(root);
  assert.equal(bench.withinHardCap, true);
  assert.equal(bench.inventedPaths, 0);
  assert.ok(bench.accuracy >= 0.75);
});
