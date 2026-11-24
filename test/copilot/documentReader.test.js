const test = require("node:test");
const assert = require("node:assert/strict");

// We can test formatFileSize and readAttachedFile directly
// Since documentReader is TS, let's verify both via transpiled import or direct logic test

test("formatFileSize formats bytes correctly", async () => {
  // Directly import or emulate documentReader logic
  const { formatFileSize } = await import("../../src/components/copilot/documentReader.ts");

  assert.equal(formatFileSize(500), "500 B");
  assert.equal(formatFileSize(1024), "1.0 KB");
  assert.equal(formatFileSize(2048), "2.0 KB");
  assert.equal(formatFileSize(1048576), "1.0 MB");
  assert.equal(formatFileSize(5242880), "5.0 MB");
});

test("readAttachedFile reads and bounds content", async () => {
  const { readAttachedFile } = await import("../../src/components/copilot/documentReader.ts");

  const fakeFile = new File(["Hello world content"], "test.txt", { type: "text/plain" });
  const doc = await readAttachedFile(fakeFile);

  assert.equal(doc.name, "test.txt");
  assert.equal(doc.content, "Hello world content");
  assert.equal(doc.type, "text/plain");
  assert.equal(doc.size, 19);
});

test("readAttachedFile truncates very long files", async () => {
  const { readAttachedFile } = await import("../../src/components/copilot/documentReader.ts");

  const longContent = "A".repeat(120000);
  const fakeFile = new File([longContent], "big.txt", { type: "text/plain" });
  const doc = await readAttachedFile(fakeFile);

  assert.equal(doc.name, "big.txt");
  assert.equal(doc.content.length, 100000);
});
