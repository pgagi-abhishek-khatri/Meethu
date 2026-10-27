const test = require("node:test");
const assert = require("node:assert/strict");
const { WebSocketServer } = require("ws");

const SonioxStreaming = require("../../src/helpers/sonioxStreaming");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const OPTIONS = { apiKey: "test-key", language: "en", sampleRate: 16000 };

// A Soniox stand-in. Each connection records what it received in order; the
// first text frame is the config. An empty text frame ends the stream: the
// server answers `finished` and closes, like the real one. `onConfig` lets a
// test script the tokens a session returns.
async function withSonioxServer(run, { onConfig } = {}) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const connections = [];
  server.on("connection", (socket) => {
    const conn = { received: [], closed: false, socket };
    connections.push(conn);
    socket.on("close", () => {
      conn.closed = true;
    });
    socket.on("message", (data, isBinary) => {
      const text = isBinary ? null : data.toString();
      if (text === "") {
        socket.send(JSON.stringify({ tokens: [], finished: true, total_audio_proc_ms: 1000 }));
        socket.close(1000);
        return;
      }
      conn.received.push(isBinary ? { audio: data.length } : JSON.parse(text));
      if (!isBinary && conn.received.length === 1) onConfig?.(socket, conn.received[0]);
    });
  });

  try {
    await run(`ws://127.0.0.1:${server.address().port}`, connections);
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
}

const client = (url, extra) => new SonioxStreaming({ url, ...extra });

test("normalizeOptions validates what arrives over IPC", () => {
  const s = new SonioxStreaming();
  assert.throws(() => s.normalizeOptions({}), /No Soniox API key/);
  assert.throws(() => s.normalizeOptions({ apiKey: "   " }), /No Soniox API key/);

  const n = s.normalizeOptions({
    apiKey: " k ",
    language: { toString: "x" },
    sampleRate: 99,
    keyterms: ["ok", "", 5, "  Soniox  "],
  });
  assert.equal(n.apiKey, "k");
  assert.equal(n.language, null);
  assert.equal(n.sampleRate, 16000);
  assert.deepEqual(n.keyterms, ["ok", "Soniox"]);

  assert.equal(s.normalizeOptions({ apiKey: "k", language: "HI-IN" }).language, "hi");
  assert.equal(s.normalizeOptions({ apiKey: "k", language: "../etc" }).language, null);
  assert.equal(s.normalizeOptions({ apiKey: "k", sampleRate: 24000 }).sampleRate, 24000);
});

test("buildConfig hints one language strictly, and English + Hindi when none is pinned", () => {
  const s = new SonioxStreaming();
  const hi = s.buildConfig(s.normalizeOptions({ ...OPTIONS, language: "hi", keyterms: ["Ow"] }));
  assert.deepEqual(hi.language_hints, ["hi"]);
  assert.equal(hi.language_hints_strict, true);
  assert.deepEqual(hi.context, { terms: ["Ow"] });
  assert.equal(hi.model, "stt-rt-v5");

  const auto = s.buildConfig(s.normalizeOptions({ apiKey: "k" }));
  assert.deepEqual(auto.language_hints, ["en", "hi"]);
  assert.equal(auto.language_hints_strict, true);
  assert.equal(auto.context, undefined);
});

test("finals accumulate prefix-stably, partials replace, markers are skipped", () => {
  const s = new SonioxStreaming();
  const finals = [];
  const partials = [];
  s.onFinalTranscript = (t) => finals.push(t);
  s.onPartialTranscript = (t) => partials.push(t);
  const msg = (tokens, extra) => Buffer.from(JSON.stringify({ tokens, ...extra }));

  s.handleMessage(
    msg([
      { text: " Hello", is_final: true },
      { text: " wor", is_final: false },
    ])
  );
  s.handleMessage(
    msg([
      { text: " world", is_final: true },
      { text: "<end>", is_final: true },
    ])
  );

  assert.deepEqual(finals, ["Hello", "Hello world"]);
  assert.deepEqual(partials, [" wor", ""]);
});

test("server error reaches onError", () => {
  const s = new SonioxStreaming();
  let err;
  s.onError = (e) => (err = e);
  s.handleMessage(Buffer.from(JSON.stringify({ error_code: 401, error_message: "bad key" })));
  assert.match(err.message, /401: bad key/);
});

test("a warm socket is adopted by a matching session: one connection, config sent once", async () => {
  await withSonioxServer(async (url, connections) => {
    const s = client(url);
    await s.warmup(OPTIONS);
    assert.equal(s.hasWarmConnection(), true);

    await s.connect(OPTIONS);
    assert.equal(connections.length, 1);
    assert.equal(s.hasWarmConnection(), false);
    assert.equal(s.isConnected, true);

    s.sendAudio(Buffer.alloc(640));
    await wait(50);
    assert.equal(connections[0].received.filter((m) => m.api_key).length, 1);
    assert.deepEqual(connections[0].received[1], { audio: 640 });
    s.cleanupAll();
  });
});

test("a session with different settings drops the warm socket and connects cold", async () => {
  await withSonioxServer(async (url, connections) => {
    const s = client(url);
    await s.warmup(OPTIONS);
    await s.connect({ ...OPTIONS, language: "hi" });
    await wait(50);

    assert.equal(connections.length, 2);
    assert.equal(connections[0].closed, true);
    assert.equal(connections[1].received[0].language_hints[0], "hi");
    s.cleanupAll();
  });
});

test("audio sent while a cold socket opens is flushed after the config, in order", async () => {
  await withSonioxServer(async (url, connections) => {
    const s = client(url);
    const connecting = s.connect(OPTIONS);
    assert.equal(s.sendAudio(Buffer.alloc(100)), true);
    assert.equal(s.sendAudio(Buffer.alloc(200)), true);
    await connecting;
    await wait(50);

    const [config, first, second] = connections[0].received;
    assert.equal(config.api_key, "test-key");
    assert.deepEqual([first, second], [{ audio: 100 }, { audio: 200 }]);
    s.cleanupAll();
  });
});

test("audio is refused, not queued forever, when nothing is connecting", () => {
  const s = new SonioxStreaming();
  assert.equal(s.sendAudio(Buffer.alloc(10)), false);
});

test("an unused warm socket closes after its TTL", async () => {
  await withSonioxServer(async (url, connections) => {
    const s = client(url, { warmTtlMs: 60 });
    await s.warmup(OPTIONS);
    assert.equal(s.hasWarmConnection(), true);

    await wait(200);
    assert.equal(s.hasWarmConnection(), false);
    assert.equal(connections[0].closed, true);
  });
});

test("warming again renews the TTL instead of opening a second socket", async () => {
  await withSonioxServer(async (url, connections) => {
    const s = client(url, { warmTtlMs: 150 });
    await s.warmup(OPTIONS);
    await wait(100);
    await s.warmup(OPTIONS);
    await wait(100);

    assert.equal(connections.length, 1);
    assert.equal(s.hasWarmConnection(), true);
    s.cleanupAll();
  });
});

test("a failed cold connect rejects at once rather than waiting for the timeout", async () => {
  const s = client("ws://127.0.0.1:1");
  const started = Date.now();
  await assert.rejects(() => s.connect(OPTIONS));
  assert.ok(Date.now() - started < 3000);
  assert.equal(s.isConnected, false);
  assert.equal(s.connecting, false);
  assert.equal(s.sendAudio(Buffer.alloc(10)), false);
});

test("a failed warmup leaves nothing behind", async () => {
  const s = client("ws://127.0.0.1:1");
  await assert.rejects(() => s.warmup(OPTIONS));
  assert.equal(s.warm, null);
});

test("stop flushes the tail, returns the full text and closes the session socket", async () => {
  await withSonioxServer(
    async (url, connections) => {
      const s = client(url);
      const finals = [];
      s.onFinalTranscript = (t) => finals.push(t);
      await s.connect(OPTIONS);
      await wait(50);

      const result = await s.disconnect(true);
      assert.equal(result.text, "Hello world");
      assert.equal(s.isConnected, false);
      assert.equal(s.ws, null);
      await wait(50);
      assert.equal(connections[0].closed, true);
      assert.deepEqual(finals, ["Hello", "Hello world"]);
    },
    {
      onConfig: (socket) => {
        socket.send(JSON.stringify({ tokens: [{ text: " Hello", is_final: true }] }));
        socket.send(JSON.stringify({ tokens: [{ text: " world", is_final: true }] }));
      },
    }
  );
});

test("a late close from a finished session cannot tear down the next one", async () => {
  await withSonioxServer(async (url) => {
    const s = client(url);
    const errors = [];
    s.onError = (e) => errors.push(e);

    await s.connect(OPTIONS);
    await s.disconnect(true);
    await s.connect(OPTIONS);
    await wait(150);

    assert.equal(s.isConnected, true);
    assert.deepEqual(errors, []);
    s.cleanupAll();
  });
});

test("a connection lost mid-session is reported once", async () => {
  await withSonioxServer(async (url, connections) => {
    const s = client(url);
    const errors = [];
    s.onError = (e) => errors.push(e);
    await s.connect(OPTIONS);
    await wait(50);

    connections[0].socket.terminate();
    await wait(100);

    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /Connection lost/);
    assert.equal(s.isConnected, false);
  });
});

test("disconnect while still connecting cancels the connect", async () => {
  await withSonioxServer(async (url) => {
    const s = client(url);
    const connecting = s.connect(OPTIONS);
    await s.disconnect(false);
    await assert.rejects(connecting);
    assert.equal(s.isConnected, false);
    assert.equal(s.connecting, false);
  });
});

// ---- meeting mode -------------------------------------------------------

const MEETING = { ...OPTIONS, sampleRate: 24000, mode: "byok", streamLabel: "system" };
const final = (text, start_ms, end_ms, speaker) => ({
  text,
  start_ms,
  end_ms,
  speaker,
  is_final: true,
});

test("meeting config enables endpoints and diarization; dictation config does not", () => {
  const s = new SonioxStreaming();
  const meeting = s.buildConfig(s.normalizeOptions(MEETING));
  assert.equal(meeting.enable_endpoint_detection, true);
  assert.equal(meeting.enable_speaker_diarization, true);
  assert.equal(meeting.sample_rate, 24000);
  const dictation = s.buildConfig(s.normalizeOptions({ ...OPTIONS, mode: "byok" }));
  assert.equal(dictation.enable_endpoint_detection, undefined);
  assert.equal(dictation.enable_speaker_diarization, undefined);
});

test("region picks the endpoint and unknown regions fall back to US", () => {
  const s = new SonioxStreaming();
  assert.equal(s.normalizeOptions({ ...OPTIONS, region: "eu" }).region, "eu");
  assert.equal(s.normalizeOptions({ ...OPTIONS, region: "mars" }).region, "us");
  assert.equal(s.normalizeOptions({ ...OPTIONS, region: "__proto__" }).region, "us");
});

test("meeting mode: segments close on <end>, carry timestamps and namespaced speakers", async () => {
  await withSonioxServer(async (url) => {
    const s = client(url);
    const finals = [];
    const partials = [];
    s.onFinalTranscript = (text, startedAt) =>
      finals.push({ text, startedAt, last: s.completedSegments.at(-1) });
    s.onPartialTranscript = (text) => partials.push(text);
    await s.connect(MEETING);
    assert.equal(s.isConnected, true);
    const base = s.sessionStartedAt;
    assert.ok(base > 0);

    s.sendAudio(Buffer.alloc(480));
    assert.equal(s.audioBytesSent, 480);

    s.handleMessage(
      JSON.stringify({
        tokens: [final("Hello", 1000, 1300, "1"), { text: " wor", is_final: false }],
      })
    );
    assert.equal(partials.at(-1), "Hello wor");
    assert.equal(finals.length, 0);

    s.handleMessage(JSON.stringify({ tokens: [final(" world", 1300, 1700, "1"), final("<end>")] }));
    s.handleMessage(JSON.stringify({ tokens: [final("Bye", 3000, 3200, "2")] }));

    assert.deepEqual(finals, [
      { text: "Hello world", startedAt: base + 1000, last: "Hello world" },
    ]);
    assert.equal(partials.at(-1), "Bye");
    assert.deepEqual(s.completedSpeakers, ["system:1"]);

    const result = await s.disconnect();
    assert.deepEqual(s.completedSegments, ["Hello world", "Bye"]);
    assert.deepEqual(s.completedSpeakers, ["system:1", "system:2"]);
    assert.equal(result.text, "Hello worldBye");
  }, {});
});

test("meeting mode: warmup is a no-op", async () => {
  await withSonioxServer(async (url, connections) => {
    await client(url).warmup(MEETING);
    await wait(50);
    assert.equal(connections.length, 0);
  });
});

test("meeting mode: a lost connection goes to onConnectionLost once, not onError", async () => {
  await withSonioxServer(async (url, connections) => {
    const s = client(url);
    const lost = [];
    const errors = [];
    s.onConnectionLost = (e) => lost.push(e);
    s.onError = (e) => errors.push(e);
    await s.connect(MEETING);
    connections[0].socket.terminate();
    await wait(100);
    assert.equal(lost.length, 1);
    assert.equal(errors.length, 0);
    assert.equal(s.isConnected, false);
  });
});

test("meeting mode: onSessionExpired fires proactively near the session limit", async () => {
  await withSonioxServer(async (url) => {
    const s = client(url, { sessionRenewMs: 30 });
    const expired = [];
    s.onSessionExpired = (e) => expired.push(e);
    await s.connect(MEETING);
    await wait(120);
    assert.deepEqual(expired, [{ proactive: true }]);
    await s.disconnect();
  });
});

test("meeting mode: two instances stay independent (mic and system)", async () => {
  await withSonioxServer(async (url) => {
    const mic = client(url);
    const system = client(url);
    await Promise.all([mic.connect({ ...MEETING, streamLabel: "mic" }), system.connect(MEETING)]);
    mic.handleMessage(JSON.stringify({ tokens: [final("me", 0, 100, "1"), final("<end>")] }));
    system.handleMessage(JSON.stringify({ tokens: [final("them", 0, 100, "1"), final("<end>")] }));
    assert.deepEqual(mic.completedSpeakers, ["mic:1"]);
    assert.deepEqual(system.completedSpeakers, ["system:1"]);
    await Promise.all([mic.disconnect(), system.disconnect()]);
  });
});
