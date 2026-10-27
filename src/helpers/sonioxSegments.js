// Turns Soniox's token stream into the closed segments meeting transcription
// expects. Soniox has no "segment": we close one at an endpoint (<end>) or
// finalize (<fin>) marker, when the speaker changes, or when the open text gets
// too long (continuous speech may never produce an <end>).
const MAX_SEGMENT_MS = 15000;
const MAX_SEGMENT_CHARS = 300;
const CLOSE_MARKERS = new Set(["<end>", "<fin>"]);

class SonioxSegmentBuilder {
  constructor({ maxMs = MAX_SEGMENT_MS, maxChars = MAX_SEGMENT_CHARS } = {}) {
    this.maxMs = maxMs;
    this.maxChars = maxChars;
    this.reset();
  }

  reset() {
    this.text = "";
    this.startMs = null;
    this.endMs = null;
    this.speaker = null;
  }

  // Feed the final tokens of one message in order; returns the segments they closed.
  push(tokens) {
    const closed = [];
    const close = () => {
      const segment = this.close();
      if (segment) closed.push(segment);
    };
    for (const token of tokens) {
      if (CLOSE_MARKERS.has(token.text)) {
        close();
        continue;
      }
      const speaker = token.speaker == null ? null : String(token.speaker);
      if (this.text.trim() && speaker && this.speaker && speaker !== this.speaker) close();
      if (this.startMs == null && token.text.trim() && typeof token.start_ms === "number") {
        this.startMs = token.start_ms;
      }
      if (typeof token.end_ms === "number") this.endMs = token.end_ms;
      if (speaker && !this.speaker) this.speaker = speaker;
      this.text += token.text;
      const tooLong =
        this.text.length >= this.maxChars ||
        (this.startMs != null && this.endMs != null && this.endMs - this.startMs >= this.maxMs);
      if (tooLong) close();
    }
    return closed;
  }

  // Closes whatever is open (finalize, end of stream). Null when there is only whitespace.
  close() {
    const text = this.text.trim();
    const segment = text ? { text, startMs: this.startMs, speaker: this.speaker } : null;
    this.reset();
    return segment;
  }
}

module.exports = { SonioxSegmentBuilder, MAX_SEGMENT_MS, MAX_SEGMENT_CHARS };
