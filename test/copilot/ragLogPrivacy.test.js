// Phase 3.6: the retrieval log must not become a plain-text copy of what people said in meetings.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRagLog } = require("../../src/copilot/rag/ragLog");

const read = (dir) =>
  fs
    .readFileSync(path.join(dir, "copilot-rag.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

test("question text is replaced by a length and a short hash by default", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rl-"));
  const log = createRagLog({ dir });
  log({ event: "retrieve", question: "what did Priya say about the salary band", ms: 12 });
  const [rec] = read(dir);
  assert.equal(rec.question, undefined);
  assert.equal(rec.question_len, "what did Priya say about the salary band".length);
  assert.match(rec.question_hash, /^[0-9a-f]{12}$/);
  assert.equal(rec.ms, 12);
  assert.equal(JSON.stringify(rec).includes("Priya"), false);
});

test("the same question hashes the same, so repeats can still be traced", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rl-"));
  const log = createRagLog({ dir });
  log({ event: "retrieve", question: "same words" });
  log({ event: "retrieve", question: "same words" });
  const [a, b] = read(dir);
  assert.equal(a.question_hash, b.question_hash);
});

test("content logging is an explicit opt-in", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rl-"));
  createRagLog({ dir, logContent: true })({ event: "retrieve", question: "plain" });
  assert.equal(read(dir)[0].question, "plain");
});

test("the file is private to the user", { skip: process.platform === "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rl-"));
  createRagLog({ dir })({ event: "x" });
  assert.equal(fs.statSync(path.join(dir, "copilot-rag.jsonl")).mode & 0o077, 0);
});

test("a failing write is reported once, not swallowed and not repeated", () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rl-")), "file-not-dir");
  fs.writeFileSync(dir, "x"); // the log dir is a file, so every write fails
  const errors = [];
  const log = createRagLog({ dir, onError: (e) => errors.push(e) });
  log({ event: "a" });
  log({ event: "b" });
  assert.equal(errors.length, 1);
});
