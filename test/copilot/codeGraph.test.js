// test/copilot/codeGraph.test.js
// Verifies Dependency Graph construction, Personalized PageRank, Directory Authority Tiers,
// and ranking superiority of architectural service modules over noisy migration files.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  directoryAuthority,
  extractImportTargets,
  buildCodeGraph,
} = require("../../src/copilot/rag/codeGraph");
const { createLocalCodeIndex } = require("../../src/copilot/rag/vectorlessCodeSearch");

describe("Code Graph & Personalized PageRank Engine (v3.0)", () => {
  test("directoryAuthority scores core service/api modules above migrations and tests", () => {
    const svc = directoryAuthority("app/services/credit_service.py", "compare credit branch");
    const api = directoryAuthority("app/api/v1/credits.py", "credit endpoints");
    const mig = directoryAuthority("alembic/versions/0042_add_credit.py", "compare credit branch");
    const tst = directoryAuthority("tests/test_credit_service.py", "compare credit branch");

    assert.strictEqual(svc, api, "services/ and api/ share Tier-1 core production authority");
    assert(svc > mig * 2.5, "core services must strongly outrank migration noise");
    assert(api > tst * 2, "core api routes must outrank test files for general queries");

    const migExplicit = directoryAuthority("alembic/versions/0042_add_credit.py", "show alembic migration script");
    assert(migExplicit >= 1.4, "migration tier restores when user explicitly asks about migrations");
  });

  test("extractImportTargets parses Python relative and JS/TS imports accurately", () => {
    const pyTargets = extractImportTargets([
      "from app.services.credit_service import CreditService",
      "import app.models.user",
    ]);
    assert(pyTargets.includes("app/services/credit_service"));
    assert(pyTargets.includes("app/models/user"));

    const jsTargets = extractImportTargets([
      'import { buildCodeGraph } from "./codeGraph";',
      'const adapter = require("../helpers/gitLocalAdapter");',
    ]);
    assert(jsTargets.includes("./codeGraph"));
    assert(jsTargets.includes("../helpers/gitLocalAdapter"));
  });

  test("Personalized PageRank + RRF ranks central service modules ahead of migration files", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meethu-graph-test-"));
    const write = (rel, body) => {
      const full = path.join(tmpDir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body, "utf8");
    };

    write(
      "app/services/credit_service.py",
      `"""Core Credit Allowance & Balance Ledger Service."""
class CreditService:
    def check_credit_allowance(self, user_id: str, amount: int) -> bool:
        return True
    def deduct_credit(self, user_id: str, amount: int) -> int:
        return 0`
    );
    write(
      "app/api/v1/credits.py",
      `from app.services.credit_service import CreditService
def get_credit_balance(user_id: str):
    return CreditService().check_credit_allowance(user_id, 1)`
    );
    write(
      "app/api/v1/billing.py",
      `from app.services.credit_service import CreditService
def charge_credit(user_id: str):
    return CreditService().deduct_credit(user_id, 5)`
    );
    write(
      "alembic/versions/999_credit_table.py",
      `"""credit credit credit migration upgrade downgrade"""
def upgrade():
    pass
def downgrade():
    pass`
    );

    const idx = createLocalCodeIndex(tmpDir, { useCache: false });
    assert(idx.graph.edgeCount >= 2, "Must link api modules -> app/services/credit_service.py");

    const res = idx.search("compare credit allowance and billing branch", { topK: 4 });
    assert.strictEqual(res.vectorCalls, 0);
    assert(res.hits.length >= 2);
    const rankedPaths = res.hits.map((h) => h.relPath);
    const serviceIdx = rankedPaths.indexOf("app/services/credit_service.py");
    const migIdx = rankedPaths.indexOf("alembic/versions/999_credit_table.py");
    assert(serviceIdx !== -1 && serviceIdx <= 1, `Expected credit_service.py in top 2, got ${rankedPaths.join(", ")}`);
    assert(migIdx === -1 || serviceIdx < migIdx, "credit_service.py must outrank alembic migration");

    const repoMap = idx.generateRepoMapMarkdown({ maxModules: 4 });
    assert(repoMap.includes("PageRank"), "RepoMap header must reflect PageRank ordering");
    const mapLines = repoMap.split("\n").filter((l) => l.startsWith("- **`"));
    assert(mapLines[0].includes("credit_service.py"), `Most depended-on hub should top RepoMap, got ${mapLines[0]}`);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// Phase 4.4: Python relative imports become dependency edges.
const { test: t44g } = require("node:test");
const assert44g = require("node:assert/strict");
const { buildCodeGraph: build44, extractImportTargets: targets44 } = require("../../src/copilot/rag/codeGraph");

t44g("relative python imports resolve to sibling and parent modules", () => {
  assert44g.deepEqual(targets44(["from .billing import charge"]), ["./billing"]);
  assert44g.deepEqual(targets44(["from ..core.config import load"]), ["../core/config"]);
  assert44g.deepEqual(targets44(["from . import util"]), ["./util"]);
  assert44g.deepEqual(targets44(["from app.services.x import y"]), ["app/services/x"]);
  const mod = (relPath, imports = []) => ({ relPath, structure: { classes: [], functions: [], imports } });
  const g = build44([
    mod("pkg/api.py", ["from .billing import charge", "from ..core.config import load"]),
    mod("pkg/billing.py"),
    mod("core/config.py"),
  ]);
  assert44g.ok(g.outEdges.get("pkg/api.py").has("pkg/billing.py"), "sibling edge");
  assert44g.ok(g.outEdges.get("pkg/api.py").has("core/config.py"), "parent edge");
});
