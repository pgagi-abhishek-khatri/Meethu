const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startMemProbe } = require("../../src/copilot/main/memProbe");

test("the memory log reads like a report and points at what grows", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-mem-"));
  let t = Date.parse("2026-10-14T10:00:00");
  let transcript = 10;
  const engine = {
    memory: () => ({
      transcript,
      cards: 2,
      jobs: 0,
      side: 0,
      queue: 0,
      specs: 2,
      asked: 5,
      skipped: 1,
      callMs: 3,
      jobThread: 0,
    }),
  };
  const probe = startMemProbe({
    dir,
    engine,
    now: () => t,
    intervalMs: 1e9,
    metrics: () => [
      { type: "Tab", workingSetMB: 180 },
      { type: "GPU", workingSetMB: 90 },
    ],
  });
  probe.sample();
  t += 600000;
  transcript = 80;
  const text = probe.sample();
  probe.stop();
  assert.match(text, /meeting running 10 min/);
  assert.match(text, /memory {3}app \d+ MB \([+-]\d+ MB since the start\)/);
  assert.match(text, /windows {2}window 180 MB · graphics 90 MB/);
  assert.match(text, /copilot {2}transcript lines 80 · recent cards 2/);
  assert.match(text, /growing {2}transcript lines 10 → 80/);
  assert.equal(
    fs.readFileSync(path.join(dir, "copilot-memory.log"), "utf8").split("\n\n").filter(Boolean)
      .length,
    2
  );
  engine.memory = () => null;
  assert.equal(probe.sample() ?? null, null);
});
