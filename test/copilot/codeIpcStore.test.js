// test/copilot/codeIpcStore.test.js
// Tests SQLite codeRepos persistence and engine vectorless routing flag.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { createOkfRouter } = require("../../src/copilot/core/okf/router");
const { createEngine } = require("../../src/copilot/main/engine");

describe("Frontend IPC & Store Code Integration", () => {
  test("OKF router classifies code queries as local_vectorless for engine.js", () => {
    const okfRouter = createOkfRouter();
    const res = okfRouter.classifyQuery({
      query: "analyze app/services/credit_service.py",
      spec: { project: true, localCodeMode: true },
    });
    assert.strictEqual(res.route, "local_vectorless");
  });

  test("store.js declares copilot_code_repos table and methods cleanly", () => {
    const fs = require("fs");
    const storeSrc = fs.readFileSync(path.resolve(__dirname, "../../src/copilot/main/store.js"), "utf8");
    assert(storeSrc.includes("copilot_code_repos"), "store.js must define copilot_code_repos table");
    assert(storeSrc.includes("codeRepos:"), "store.js must expose codeRepos CRUD");
  });

  test("service.js and preload bridges expose all code intelligence IPC channels", () => {
    const fs = require("fs");
    const serviceSrc = fs.readFileSync(path.resolve(__dirname, "../../src/copilot/main/service.js"), "utf8");
    const rootPreload = fs.readFileSync(path.resolve(__dirname, "../../preload.js"), "utf8");
    const copilotPreload = fs.readFileSync(path.resolve(__dirname, "../../src/copilot/main/preload.js"), "utf8");

    const channels = [
      "code-repos-list",
      "code-repo-pick",
      "code-repo-refresh",
      "code-repo-remove",
      "code-analyze",
      "code-branches",
      "code-diff",
      "code-modules",
      "code-context",
      "code-context-download",
    ];
    for (const ch of channels) {
      assert(serviceSrc.includes(`"${ch}"`), `service.js must handle ${ch}`);
      assert(rootPreload.includes(`"${ch}"`), `preload.js must bridge ${ch}`);
      assert(copilotPreload.includes(`"${ch}"`), `copilot/main/preload.js must bridge ${ch}`);
    }
  });

  test("engine.js injects connected localCode repository context into Meeting AI ask()", async () => {
    let userPrompt = "";
    const engine = createEngine({
      getSettings: () => ({ enabled: true, apiKey: "test-key" }),
      panel: { send: () => {} },
      client: {
        systemOne: async () => ({ answers: { action: { choice: "wait" } }, ms: 1 }),
      },
      mainModel: async ({ messages }) => {
        userPrompt = messages?.[1]?.content || "";
        return {
          text: JSON.stringify({
            title: "CreditService Analysis",
            body: "Checked credit_service.py.",
            confidence: "high",
            sources: [],
          }),
          tokens: 10,
          cost: 0,
        };
      },
      localCode: {
        hasRepos: () => true,
        catalog: () => "- Local Repo: doula.ai-backend (branch: main)",
        search: (q) => ({
          passages: `# Module: credit_service.py\nQuery: ${q}\nDailyCreditLimitExceededError enforced`,
          files: ["app/services/credit_service.py"],
        }),
      },
    });

    engine.begin();
    await engine.ask({ text: "how does credit_service.py enforce daily allowance?" });
    await new Promise((r) => setTimeout(r, 60));

    assert(userPrompt.includes("doula.ai-backend"), "Meeting AI prompt must include connected local repo catalog");
    assert(userPrompt.includes("DailyCreditLimitExceededError"), "Meeting AI prompt must receive vectorless localCode passages");
  });
});
