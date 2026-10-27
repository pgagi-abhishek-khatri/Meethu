const test = require("node:test");
const assert = require("node:assert/strict");

const { SonioxSegmentBuilder } = require("../../src/helpers/sonioxSegments");

const tok = (text, start_ms, end_ms, speaker) => ({
  text,
  start_ms,
  end_ms,
  speaker,
  is_final: true,
});

test("an <end> marker closes the segment with its first token's start", () => {
  const b = new SonioxSegmentBuilder();
  const closed = b.push([
    tok("Hello", 100, 400),
    tok(" world", 400, 800),
    { text: "<end>", is_final: true },
  ]);
  assert.deepEqual(closed, [{ text: "Hello world", startMs: 100, speaker: null }]);
  assert.equal(b.text, "");
});

test("<end> in the middle of a message splits it; the remainder stays open", () => {
  const b = new SonioxSegmentBuilder();
  const closed = b.push([tok("One.", 0, 300), { text: "<end>" }, tok(" Two", 900, 1200)]);
  assert.deepEqual(
    closed.map((s) => s.text),
    ["One."]
  );
  assert.equal(b.text, " Two");
  assert.equal(b.close().startMs, 900);
});

test("continuous speech with no <end> closes by length and by time", () => {
  const long = new SonioxSegmentBuilder({ maxChars: 10 });
  const byChars = long.push([tok("aaaa", 0, 100), tok("bbbb", 100, 200), tok("cccc", 200, 300)]);
  assert.deepEqual(
    byChars.map((s) => s.text),
    ["aaaabbbbcccc"]
  );

  const slow = new SonioxSegmentBuilder({ maxMs: 1000 });
  const byTime = slow.push([tok("a ", 0, 500), tok("b ", 500, 1000), tok("c", 1000, 1200)]);
  assert.deepEqual(
    byTime.map((s) => s.text),
    ["a b"]
  );
  assert.equal(slow.close().text, "c");
});

test("empty and whitespace-only segments are dropped", () => {
  const b = new SonioxSegmentBuilder();
  assert.deepEqual(b.push([{ text: "<end>" }, tok(" ", 0, 10), { text: "<fin>" }]), []);
  assert.equal(b.close(), null);
});

test("a speaker change closes the segment; missing speakers never split", () => {
  const b = new SonioxSegmentBuilder();
  const closed = b.push([
    tok("Hi", 0, 100, "1"),
    tok(" there", 100, 200, "1"),
    tok(" Yes", 300, 400, "2"),
    tok(" ok", 400, 500),
  ]);
  assert.deepEqual(closed, [{ text: "Hi there", startMs: 0, speaker: "1" }]);
  assert.deepEqual(b.close(), { text: "Yes ok", startMs: 300, speaker: "2" });

  assert.equal(new SonioxSegmentBuilder().push([tok("a", 0, 1), tok("b", 1, 2)]).length, 0);
});
