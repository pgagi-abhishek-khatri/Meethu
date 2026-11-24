const test = require("node:test");
const assert = require("node:assert/strict");
const { createEngine } = require("../../src/copilot/main/engine");

function fakeMain() {
  const calls = [];
  const fn = async (opts) => {
    calls.push(opts);
    return { text: "TITLE: T\n- point.", sources: [] };
  };
  fn.calls = calls;
  return fn;
}

test("engine.ask injects attached document into question context", () => {
  const main = fakeMain();
  const engine = createEngine({
    env: { OPENROUTER_API_KEY: "test-key" },
    mainModel: main,
    now: () => 1000,
  });

  const attachment = {
    name: "quarterly_results.md",
    content: "Q3 revenue reached $4.2M with 15% net profit margin.",
    size: 52,
    type: "text/markdown",
  };

  const id = engine.ask({
    text: "What was the revenue and margin?",
    attachment,
  });

  assert.ok(id);
  assert.equal(main.calls.length, 1);
  const userMessage = main.calls[0].messages.find((m) => m.role === "user");
  assert.ok(userMessage);
  assert.match(userMessage.content, /\[ATTACHED DOCUMENT: quarterly_results\.md\]/);
  assert.match(userMessage.content, /Q3 revenue reached \$4\.2M with 15% net profit margin\./);
  assert.match(userMessage.content, /What was the revenue and margin\?/);
});

test("engine.ask propagates attachmentName and files to emitted card events", async () => {
  const main = fakeMain();
  const events = [];
  const engine = createEngine({
    env: { OPENROUTER_API_KEY: "test-key" },
    mainModel: main,
    panel: { send: (e) => events.push(e) },
    now: () => 1000,
  });

  const attachment = {
    name: "financial_specs.pdf",
    content: "Specs details...",
    size: 100,
    type: "application/pdf",
  };

  engine.ask({
    text: "Can you analyze the specs document?",
    attachment,
  });

  const startEvent = events.find((e) => e.type === "card_start");
  assert.ok(startEvent);
  assert.equal(startEvent.attachmentName, "financial_specs.pdf");
  assert.deepEqual(startEvent.files, ["financial_specs.pdf"]);

  await new Promise((r) => setTimeout(r, 20));

  const doneEvent = events.find((e) => e.type === "card_done");
  assert.ok(doneEvent);
  assert.equal(doneEvent.attachmentName, "financial_specs.pdf");
  assert.ok(doneEvent.files.includes("financial_specs.pdf"));
});
