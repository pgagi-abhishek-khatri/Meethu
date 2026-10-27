const WebSocket = require("ws");
const debugLogger = require("./debugLogger");
const { SonioxSegmentBuilder } = require("./sonioxSegments");

const SONIOX_WS_URL = "wss://stt-rt.soniox.com/transcribe-websocket";
// Keys are per region. Only US has been tested.
const SONIOX_REGION_URLS = {
  us: SONIOX_WS_URL,
  eu: "wss://stt-rt.eu.soniox.com/transcribe-websocket",
  jp: "wss://stt-rt.jp.soniox.com/transcribe-websocket",
  in: "wss://stt-rt.in.soniox.com/transcribe-websocket",
};
// Soniox ends a stream at 300 minutes; ask the meeting code to renew just before.
const SESSION_RENEW_MS = 290 * 60 * 1000;
const MEETING_STREAM_LABELS = new Set(["mic", "system"]);
const SONIOX_MODEL = "stt-rt-v5";
const DEFAULT_SAMPLE_RATE = 16000;
const MIN_SAMPLE_RATE = 8000;
const MAX_SAMPLE_RATE = 48000;
const MAX_KEYTERMS = 100;
const CONNECT_TIMEOUT_MS = 10000;
const FINISH_TIMEOUT_MS = 5000;
const KEEPALIVE_INTERVAL_MS = 10000;
// An unused warm socket is closed after this long; the next dictation then
// connects cold. Each warmup call (launch, after every dictation) renews it.
const WARM_TTL_MS = 3 * 60 * 1000;
// Audio captured while a cold socket is still opening is held and flushed in
// order, so the first words are never lost. 10 s of 16 kHz s16le, the same
// span as the connect timeout.
const MAX_PENDING_BYTES = DEFAULT_SAMPLE_RATE * 2 * 10;
// Used when no language is pinned: Soniox otherwise detects any language and mislabels noise
// (Kazakh, Hindi fragments in English speech). User-selectable languages come later.
const DEFAULT_LANGUAGE_HINTS = ["en", "hi"];
const LANGUAGE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

// Soniox takes the API key in the first JSON message (not a header), so the
// main process owns the key and the renderer never sees it. Tokens stream back
// as {text, is_final}: final tokens are append-only, non-final ones are
// replaced wholesale by the next response.
//
// The config message pins language and context for the session, so warmup()
// opens a socket and sends it ahead of time (TCP + TLS + upgrade is the slow
// part, ~2 s on a poor link) and connect() adopts that socket with no wait when
// the session settings match. A session's socket is closed as soon as the
// dictation stops; only the idle warm socket outlives it, and only for WARM_TTL_MS.
class SonioxStreaming {
  // `url` and `warmTtlMs` exist for tests; nothing from the renderer reaches them.
  constructor({ url = null, warmTtlMs = WARM_TTL_MS, sessionRenewMs = SESSION_RENEW_MS } = {}) {
    this.urlOverride = url;
    this.warmTtlMs = warmTtlMs;
    this.sessionRenewMs = sessionRenewMs;
    this.ws = null;
    this.warm = null;
    this.isConnected = false;
    this.connecting = false;
    this.isDisconnecting = false;
    this.finalText = "";
    this.lastPartial = "";
    this.pendingAudio = [];
    this.pendingBytes = 0;
    this.finishResolve = null;
    this.onPartialTranscript = null;
    this.onFinalTranscript = null;
    this.onError = null;
    this.onSessionEnd = null;
    // Meeting contract (same members as deepgramStreaming.js). Meeting mode is
    // on when connect() gets a streamLabel; dictation never sets one.
    this.onConnectionLost = null;
    this.onSessionExpired = null;
    this.meeting = false;
    this.streamLabel = null;
    this.audioBytesSent = 0;
    this.sessionStartedAt = null;
    this.finalSegments = [];
    this.completedSpeakers = [];
    this.segmentBuilder = null;
    this.connectionLossNotified = false;
    this.meetingKeepAlive = null;
    this.sessionRenewTimer = null;
  }

  get completedSegments() {
    return this.finalSegments;
  }

  // Options arrive over IPC, so every field is validated rather than trusted.
  normalizeOptions(options) {
    const apiKey = typeof options?.apiKey === "string" ? options.apiKey.trim() : "";
    if (!apiKey) throw new Error("No Soniox API key configured. Add your key in Settings.");

    const sampleRate = Number.isInteger(options.sampleRate) ? options.sampleRate : null;
    const language =
      typeof options.language === "string" && LANGUAGE_PATTERN.test(options.language)
        ? options.language.split("-")[0].toLowerCase()
        : null;
    const keyterms = Array.isArray(options.keyterms)
      ? options.keyterms
          .filter((term) => typeof term === "string" && term.trim())
          .map((term) => term.trim())
          .slice(0, MAX_KEYTERMS)
      : [];

    const meeting = MEETING_STREAM_LABELS.has(options.streamLabel);
    const region = Object.hasOwn(SONIOX_REGION_URLS, options.region) ? options.region : "us";

    return {
      apiKey,
      meeting,
      streamLabel: meeting ? options.streamLabel : null,
      region,
      sampleRate:
        sampleRate >= MIN_SAMPLE_RATE && sampleRate <= MAX_SAMPLE_RATE
          ? sampleRate
          : DEFAULT_SAMPLE_RATE,
      language,
      keyterms,
    };
  }

  buildConfig({ apiKey, sampleRate, language, keyterms, meeting }) {
    const config = {
      api_key: apiKey,
      model: SONIOX_MODEL,
      audio_format: "pcm_s16le",
      sample_rate: sampleRate,
      num_channels: 1,
      enable_language_identification: true,
    };
    config.language_hints = language ? [language] : DEFAULT_LANGUAGE_HINTS;
    config.language_hints_strict = true;
    if (keyterms.length) config.context = { terms: keyterms };
    if (meeting) {
      config.enable_endpoint_detection = true;
      config.enable_speaker_diarization = true;
    }
    return config;
  }

  // Everything the config message fixes for a session; a warm socket is reusable
  // only for an identical signature.
  signature(options) {
    return JSON.stringify(this.buildConfig({ ...options, apiKey: "" }));
  }

  // Opens a socket and sends the config as soon as it is up. `opened` settles
  // once the config is sent. The listeners are permanent and dispatch to the
  // entry's hooks, so whoever currently owns the socket (warm pool or a
  // session) receives its events and nobody else can be affected by them.
  openSocket(options) {
    // IPv4 only: an unroutable IPv6 address otherwise stalls the connect into ETIMEDOUT.
    const ws = new WebSocket(this.urlOverride ?? SONIOX_REGION_URLS[options.region], {
      family: 4,
    });
    const entry = {
      ws,
      sig: this.signature(options),
      keepAlive: null,
      ttl: null,
      onMessage: null,
      onError: null,
      onClose: null,
    };
    entry.opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Soniox WebSocket connection timeout"));
        ws.terminate();
      }, CONNECT_TIMEOUT_MS);
      ws.on("open", () => {
        clearTimeout(timer);
        ws.send(JSON.stringify(this.buildConfig(options)));
        resolve();
      });
      ws.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
        entry.onError?.(error);
      });
      ws.on("close", (code, reason) => {
        clearTimeout(timer);
        reject(new Error(`Soniox connection closed before ready (${code})`));
        entry.onClose?.(code, reason);
      });
      ws.on("message", (data) => entry.onMessage?.(data));
    });
    entry.opened.catch(() => {}); // surfaced to whoever awaits it; never unhandled
    return entry;
  }

  async warmup(options = {}) {
    const normalized = this.normalizeOptions(options);
    // A meeting session starts at once and has no use for an idle warm socket.
    if (normalized.meeting || this.isConnected || this.connecting) return;

    const sig = this.signature(normalized);
    if (this.warm?.sig === sig && this.warm.ws.readyState <= WebSocket.OPEN) {
      this.armWarmExpiry(this.warm);
      return this.warm.opened;
    }
    this.dropWarm();

    const entry = this.openSocket(normalized);
    this.warm = entry;
    entry.onError = (error) => {
      debugLogger.debug("Soniox warm socket error", { error: error.message }, "streaming");
    };
    entry.onClose = () => {
      if (this.warm === entry) this.dropWarm();
    };

    try {
      await entry.opened;
    } catch (error) {
      if (this.warm === entry) this.dropWarm();
      throw error;
    }
    if (this.warm !== entry) return;

    // Soniox ends a stream that goes quiet without a keepalive.
    entry.keepAlive = setInterval(() => {
      if (entry.ws.readyState === WebSocket.OPEN) {
        entry.ws.send(JSON.stringify({ type: "keepalive" }));
      }
    }, KEEPALIVE_INTERVAL_MS);
    entry.keepAlive.unref();
    this.armWarmExpiry(entry);
    debugLogger.debug("Soniox connection warmed up", {}, "streaming");
  }

  armWarmExpiry(entry) {
    clearTimeout(entry.ttl);
    entry.ttl = setTimeout(() => {
      if (this.warm !== entry) return;
      debugLogger.debug("Soniox warm connection expired unused", {}, "streaming");
      this.dropWarm();
    }, this.warmTtlMs);
    entry.ttl.unref();
  }

  hasWarmConnection() {
    return Boolean(this.warm && this.warm.ws.readyState === WebSocket.OPEN);
  }

  dropWarm() {
    const entry = this.warm;
    if (!entry) return;
    this.warm = null;
    clearInterval(entry.keepAlive);
    clearTimeout(entry.ttl);
    entry.ws.terminate();
  }

  async connect(options = {}) {
    const normalized = this.normalizeOptions(options);
    if (this.isConnected || this.connecting) return;

    this.finalText = "";
    this.lastPartial = "";
    this.isDisconnecting = false;
    this.connecting = true;
    this.meeting = normalized.meeting;
    this.streamLabel = normalized.streamLabel;
    this.audioBytesSent = 0;
    this.finalSegments = [];
    this.completedSpeakers = [];
    this.segmentBuilder = normalized.meeting ? new SonioxSegmentBuilder() : null;
    this.connectionLossNotified = false;

    let entry;
    if (this.hasWarmConnection() && this.warm.sig === this.signature(normalized)) {
      entry = this.warm;
      this.warm = null;
      clearInterval(entry.keepAlive);
      clearTimeout(entry.ttl);
      debugLogger.debug("Soniox using warm connection - instant start", {}, "streaming");
    } else {
      this.dropWarm();
      entry = this.openSocket(normalized);
    }

    this.ws = entry.ws;
    entry.onMessage = (data) => {
      if (this.ws === entry.ws) this.handleMessage(data);
    };
    entry.onError = (error) => this.handleSocketError(entry, error);
    entry.onClose = (code, reason) => this.handleSocketClose(entry, code, reason);

    try {
      await entry.opened;
    } catch (error) {
      if (this.ws === entry.ws) this.cleanup();
      throw error;
    }
    // disconnect() ran while the socket was still opening.
    if (this.ws !== entry.ws) throw new Error("Soniox connection cancelled");

    this.isConnected = true;
    this.connecting = false;
    this.sessionStartedAt = Date.now();
    if (this.meeting) this.startMeetingTimers(entry.ws);
    const pending = this.pendingAudio;
    this.pendingAudio = [];
    this.pendingBytes = 0;
    for (const chunk of pending) entry.ws.send(chunk);
  }

  // A socket event only counts while its socket is still the session's: a late
  // event from a finished session must never tear down the next one.
  handleSocketError(entry, error) {
    if (this.ws !== entry.ws) return;
    debugLogger.error("Soniox WebSocket error", { error: error.message }, "streaming");
    const wasActive = this.isConnected;
    this.cleanup();
    if (wasActive && !this.isDisconnecting) this.notifyConnectionLost(error);
  }

  handleSocketClose(entry, code, reason) {
    if (this.ws !== entry.ws) return;
    debugLogger.debug("Soniox WebSocket closed", { code, reason: reason?.toString() }, "streaming");
    const wasActive = this.isConnected;
    this.finishResolve?.();
    this.cleanup();
    if (wasActive && !this.isDisconnecting) {
      this.notifyConnectionLost(new Error(`Connection lost (code: ${code})`));
    }
  }

  // Meeting mode hands a dropped connection to the meeting code's own
  // reconnect-and-replay; dictation keeps reporting it as an error.
  notifyConnectionLost(error) {
    if (this.connectionLossNotified) return;
    this.connectionLossNotified = true;
    if (this.meeting && this.onConnectionLost) this.onConnectionLost(error);
    else this.onError?.(error);
  }

  startMeetingTimers(ws) {
    // Audio can pause (muted mic, skipped silence); Soniox ends a quiet stream without this.
    this.meetingKeepAlive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "keepalive" }));
    }, KEEPALIVE_INTERVAL_MS);
    this.meetingKeepAlive.unref();
    this.sessionRenewTimer = setTimeout(
      () => this.onSessionExpired?.({ proactive: true }),
      this.sessionRenewMs
    );
    this.sessionRenewTimer.unref();
  }

  emitSegment({ text, startMs, speaker }) {
    this.finalSegments.push(text);
    this.completedSpeakers.push(speaker ? `${this.streamLabel}:${speaker}` : null);
    const startedAt =
      this.sessionStartedAt != null && typeof startMs === "number"
        ? this.sessionStartedAt + startMs
        : Date.now();
    this.onFinalTranscript?.(text, startedAt);
  }

  // Meeting mode: finals build segments; the partial is the open segment plus
  // the not-yet-final tokens, since a final only fires when a segment closes.
  handleMeetingTokens(tokens) {
    const builder = this.segmentBuilder;
    const finals = [];
    let tail = "";
    for (const token of tokens) {
      if (token.is_final) {
        finals.push(token);
        if (token.text !== "<end>" && token.text !== "<fin>") this.finalText += token.text;
      } else {
        tail += token.text;
      }
    }
    for (const segment of builder.push(finals)) this.emitSegment(segment);
    const partial = (builder.text + tail).trimStart();
    if (partial !== this.lastPartial) {
      this.lastPartial = partial;
      this.onPartialTranscript?.(partial);
    }
  }

  handleMessage(data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch (err) {
      debugLogger.error("Soniox message parse error", { error: err.message }, "streaming");
      return;
    }

    if (message.error_code) {
      debugLogger.error(
        "Soniox streaming error",
        { code: message.error_code, message: message.error_message },
        "streaming"
      );
      if (!this.isDisconnecting) {
        this.onError?.(new Error(`${message.error_code}: ${message.error_message}`));
      }
      return;
    }

    if (this.meeting) {
      this.handleMeetingTokens(message.tokens || []);
    }

    let partial = "";
    let gotFinal = false;
    for (const token of this.meeting ? [] : message.tokens || []) {
      // <end>/<fin> are endpoint and finalize markers, not speech.
      if (token.text === "<end>" || token.text === "<fin>") continue;
      if (token.is_final) {
        this.finalText += token.text;
        gotFinal = true;
      } else {
        partial += token.text;
      }
    }

    // trimStart keeps the accumulated text prefix-stable, which the renderer's
    // delta commit (text.slice(previousLength)) relies on.
    if (!this.meeting) {
      if (gotFinal) this.onFinalTranscript?.(this.finalText.trimStart());
      if (!this.finalText) partial = partial.trimStart();
      if (partial !== this.lastPartial) {
        this.lastPartial = partial;
        this.onPartialTranscript?.(partial);
      }
    }

    if (message.finished) {
      this.finishResolve?.();
      this.onSessionEnd?.({
        audioDuration: (message.total_audio_proc_ms ?? 0) / 1000,
        text: this.finalText.trimStart(),
      });
    }
  }

  sendAudio(pcmBuffer) {
    if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(pcmBuffer);
      this.audioBytesSent += pcmBuffer.length;
      return true;
    }
    if (this.connecting && this.pendingBytes + pcmBuffer.length <= MAX_PENDING_BYTES) {
      this.pendingAudio.push(pcmBuffer);
      this.pendingBytes += pcmBuffer.length;
      this.audioBytesSent += pcmBuffer.length;
      return true;
    }
    return false;
  }

  // Asks the server to finalize every pending token now instead of waiting for
  // its own confidence threshold.
  finalize() {
    if (!this.isConnected || this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ type: "finalize" }));
    return true;
  }

  // An empty text frame ends the stream; the server flushes the remaining
  // tokens and answers {finished: true} before closing. The session's socket is
  // closed here, as soon as the speech is in, before any post-processing.
  async disconnect(terminate = true) {
    if (!this.ws) return { text: this.finalText.trimStart() };
    this.isDisconnecting = true;

    if (terminate && this.isConnected && this.ws.readyState === WebSocket.OPEN) {
      let timeoutId;
      try {
        const finished = new Promise((resolve) => {
          this.finishResolve = resolve;
        });
        this.ws.send("");
        await Promise.race([
          finished,
          new Promise((resolve) => {
            timeoutId = setTimeout(resolve, FINISH_TIMEOUT_MS);
          }),
        ]);
      } catch (err) {
        debugLogger.debug("Soniox end-of-stream failed", { error: err.message }, "streaming");
      }
      clearTimeout(timeoutId);
    }

    // The server finalized everything before `finished`; close what is still open.
    const rest = this.segmentBuilder?.close();
    if (rest) this.emitSegment(rest);
    // The partial was the open segment (now emitted); any unfinalized tail is dropped.
    if (this.meeting) this.lastPartial = "";

    // lastPartial is empty after a clean finish; on timeout it keeps the unfinalized tail.
    const text = (this.finalText + this.lastPartial).trimStart();
    this.cleanup();
    this.isDisconnecting = false;
    return { text };
  }

  // Ends the current session's socket. The warm socket is left alone.
  cleanup() {
    const ws = this.ws;
    this.ws = null;
    clearInterval(this.meetingKeepAlive);
    clearTimeout(this.sessionRenewTimer);
    this.meetingKeepAlive = null;
    this.sessionRenewTimer = null;
    this.finishResolve = null;
    this.connecting = false;
    this.isConnected = false;
    this.pendingAudio = [];
    this.pendingBytes = 0;
    ws?.terminate();
  }

  cleanupAll() {
    this.cleanup();
    this.dropWarm();
    this.finalText = "";
    this.lastPartial = "";
  }

  getStatus() {
    return {
      isConnected: this.isConnected,
      sessionId: null,
      hasWarmConnection: this.hasWarmConnection(),
    };
  }
}

module.exports = SonioxStreaming;
