const test = require("node:test");
const assert = require("node:assert/strict");

// Mock SpeechRecognition environment
class MockSpeechRecognition {
  constructor() {
    this.continuous = false;
    this.interimResults = false;
    this.lang = "";
    this.onstart = null;
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
    this.started = false;
    this.stopped = false;
    this.aborted = false;
  }

  start() {
    this.started = true;
    if (this.onstart) this.onstart();
  }

  stop() {
    this.stopped = true;
    if (this.onend) this.onend();
  }

  abort() {
    this.aborted = true;
    if (this.onend) this.onend();
  }

  simulateResult(results, resultIndex = 0) {
    if (this.onresult) {
      this.onresult({
        resultIndex,
        results,
      });
    }
  }

  simulateError(error) {
    if (this.onerror) {
      this.onerror({ error });
    }
  }
}

test("audioInput mock recognition lifecycle and events", () => {
  const recognition = new MockSpeechRecognition();
  assert.equal(recognition.started, false);

  recognition.start();
  assert.equal(recognition.started, true);

  // Simulate speech transcript result
  let receivedTranscript = "";
  let receivedFinal = false;

  const onResultHandler = (event) => {
    let finalChunk = "";
    let interimChunk = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      if (res.isFinal) {
        finalChunk += res[0].transcript;
      } else {
        interimChunk += res[0].transcript;
      }
    }
    const transcript = (finalChunk || interimChunk).trim();
    if (transcript) {
      receivedTranscript = transcript;
      receivedFinal = Boolean(finalChunk);
    }
  };

  recognition.onresult = onResultHandler;

  // 1. Interim result
  recognition.simulateResult([
    { 0: { transcript: "what are our" }, isFinal: false }
  ]);
  assert.equal(receivedTranscript, "what are our");
  assert.equal(receivedFinal, false);

  // 2. Final result
  recognition.simulateResult([
    { 0: { transcript: "what are our quarterly metrics?" }, isFinal: true }
  ]);
  assert.equal(receivedTranscript, "what are our quarterly metrics?");
  assert.equal(receivedFinal, true);

  recognition.stop();
  assert.equal(recognition.stopped, true);
});

test("audioInput error handling maps permission and network errors", () => {
  const recognition = new MockSpeechRecognition();

  let lastError = null;
  const errorHandler = (event) => {
    if (event.error === "no-speech" || event.error === "aborted") return;
    let msg = "Microphone error: " + (event.error || "unknown");
    if (event.error === "not-allowed") {
      msg = "Microphone access was denied. Please check permissions.";
    } else if (event.error === "network") {
      msg = "Speech recognition network error.";
    }
    lastError = msg;
  };

  recognition.onerror = errorHandler;

  recognition.simulateError("no-speech");
  assert.equal(lastError, null); // ignored

  recognition.simulateError("aborted");
  assert.equal(lastError, null); // ignored

  recognition.simulateError("not-allowed");
  assert.equal(lastError, "Microphone access was denied. Please check permissions.");

  recognition.simulateError("network");
  assert.equal(lastError, "Speech recognition network error.");
});

test("audioInput accumulates transcript without word duplication across utterances", () => {
  let finalTranscript = "";
  let currentInterim = "";
  let lastDispatched = "";

  const handleResult = (event) => {
    let sessionFinal = "";
    let sessionInterim = "";

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      if (res.isFinal) {
        sessionFinal += res[0].transcript;
      } else {
        sessionInterim += res[0].transcript;
      }
    }

    if (sessionFinal) {
      finalTranscript = (finalTranscript + " " + sessionFinal).trim();
      currentInterim = "";
    } else {
      currentInterim = sessionInterim;
    }

    const combined = (finalTranscript + " " + currentInterim).trim();
    if (combined) {
      lastDispatched = combined;
    }
  };

  const recognition = new MockSpeechRecognition();
  recognition.onresult = handleResult;
  recognition.start();

  // Utterance 1 interim 1
  recognition.simulateResult([{ 0: { transcript: "can you" }, isFinal: false }]);
  assert.equal(lastDispatched, "can you");

  // Utterance 1 interim 2 (streaming update, should replace previous interim, not concatenate)
  recognition.simulateResult([{ 0: { transcript: "can you summarize" }, isFinal: false }]);
  assert.equal(lastDispatched, "can you summarize");

  // Utterance 1 final chunk
  recognition.simulateResult([{ 0: { transcript: "can you summarize" }, isFinal: true }]);
  assert.equal(finalTranscript, "can you summarize");
  assert.equal(lastDispatched, "can you summarize");

  // Utterance 2 interim (after natural pause / restart)
  recognition.simulateResult([{ 0: { transcript: "the key points" }, isFinal: false }]);
  assert.equal(lastDispatched, "can you summarize the key points");

  // Utterance 2 final
  recognition.simulateResult([{ 0: { transcript: "the key points?" }, isFinal: true }]);
  assert.equal(finalTranscript, "can you summarize the key points?");
  assert.equal(lastDispatched, "can you summarize the key points?");
});
