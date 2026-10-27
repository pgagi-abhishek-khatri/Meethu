const test = require("node:test");
const assert = require("node:assert/strict");

const { transcribeAudio, formatTranscript } = require("../../src/helpers/sonioxTranscription");

const json = (body, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

test("formatTranscript groups runs by speaker only when asked and present", () => {
  const tokens = [
    { text: "Hi", speaker: "1" },
    { text: " there", speaker: "1" },
    { text: " Yes", speaker: "2" },
  ];
  assert.equal(formatTranscript(tokens, true), "Speaker 1: Hi there\nSpeaker 2: Yes");
  assert.equal(formatTranscript(tokens, false), "Hi there Yes");
  assert.equal(formatTranscript([{ text: " plain " }], true), "plain");
});

test("uploads, creates, polls, reads the transcript and deletes both", async () => {
  const calls = [];
  let polls = 0;
  const realFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    const path = url.replace("https://api.soniox.com/v1", "");
    calls.push(`${init.method || "GET"} ${path}`);
    assert.equal(init.headers.Authorization, "Bearer k");
    if (path === "/files" && init.method === "POST") return json({ id: "f1" });
    if (path === "/transcriptions" && init.method === "POST") {
      const body = JSON.parse(init.body);
      assert.equal(body.file_id, "f1");
      assert.equal(body.enable_speaker_diarization, true);
      assert.deepEqual(body.language_hints, ["hi"]);
      return json({ id: "t1" });
    }
    if (path === "/transcriptions/t1") {
      return json({ status: ++polls < 2 ? "processing" : "completed" });
    }
    if (path === "/transcriptions/t1/transcript")
      return json({ tokens: [{ text: "ok", speaker: "1" }] });
    return json({}, 204);
  };
  try {
    const result = await transcribeAudio({
      apiKey: "k",
      audioBuffer: Buffer.from("x"),
      fileName: "a.wav",
      language: "hi-IN",
      diarize: true,
    });
    assert.equal(result.text, "Speaker 1: ok");
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(calls.includes("DELETE /transcriptions/t1"));
    assert.ok(calls.includes("DELETE /files/f1"));
  } finally {
    global.fetch = realFetch;
  }
});

test("an error status surfaces its message; a missing key fails before any request", async () => {
  const realFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    if (url.endsWith("/files")) return json({ id: "f" });
    if (url.endsWith("/transcriptions") && init.method === "POST") return json({ id: "t" });
    if (init.method === "DELETE") return json({});
    return json({ status: "error", error_message: "bad audio" });
  };
  try {
    await assert.rejects(
      transcribeAudio({ apiKey: "k", audioBuffer: Buffer.from("x") }),
      /bad audio/
    );
    await assert.rejects(
      transcribeAudio({ apiKey: "", audioBuffer: Buffer.from("x") }),
      /No Soniox API key/
    );
  } finally {
    global.fetch = realFetch;
  }
});
