// Soniox batch (async) transcription for uploaded files: upload -> create ->
// poll -> fetch transcript -> delete both. The realtime socket in
// sonioxStreaming.js cannot take a file. The key stays in main.
const API = "https://api.soniox.com/v1";
const ASYNC_MODEL = "stt-async-v5";
const POLL_INTERVAL_MS = 1500;
const MAX_WAIT_MS = 20 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(apiKey, path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, ...init.headers },
  });
  if (res.status === 401) throw new Error("Invalid API key. Check your key in Settings.");
  if (res.status === 429) throw new Error("Rate limit exceeded. Please try again later.");
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Soniox API error ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  return res;
}

// With speakers: one "Speaker N: text" line per run of the same speaker.
function formatTranscript(tokens, withSpeakers) {
  if (!withSpeakers || !tokens.some((t) => t.speaker != null)) {
    return tokens
      .map((t) => t.text)
      .join("")
      .trim();
  }
  const lines = [];
  let speaker = null;
  for (const token of tokens) {
    const next = token.speaker == null ? speaker : String(token.speaker);
    if (next !== speaker || lines.length === 0) {
      speaker = next;
      lines.push({ speaker, text: "" });
    }
    lines[lines.length - 1].text += token.text;
  }
  return lines
    .map((l) => (l.speaker ? `Speaker ${l.speaker}: ${l.text.trim()}` : l.text.trim()))
    .filter(Boolean)
    .join("\n");
}

async function transcribeAudio({ apiKey, audioBuffer, fileName, language, diarize, signal }) {
  if (!apiKey) throw new Error("No Soniox API key configured. Add your key in Settings.");

  const form = new FormData();
  form.append("file", new Blob([audioBuffer]), fileName || "audio");
  const { id: fileId } = await (
    await call(apiKey, "/files", { method: "POST", body: form, signal })
  ).json();

  let transcriptionId = null;
  try {
    const baseLanguage = typeof language === "string" ? language.split("-")[0].toLowerCase() : "";
    const body = {
      model: ASYNC_MODEL,
      file_id: fileId,
      enable_language_identification: true,
      ...(diarize ? { enable_speaker_diarization: true } : {}),
      ...(/^[a-z]{2,3}$/.test(baseLanguage) ? { language_hints: [baseLanguage] } : {}),
    };
    ({ id: transcriptionId } = await (
      await call(apiKey, "/transcriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      })
    ).json());

    const deadline = Date.now() + MAX_WAIT_MS;
    for (;;) {
      const state = await (
        await call(apiKey, `/transcriptions/${transcriptionId}`, { signal })
      ).json();
      if (state.status === "completed") break;
      if (state.status === "error") {
        throw new Error(state.error_message || "Soniox transcription failed");
      }
      if (Date.now() > deadline) throw new Error("Soniox transcription timed out");
      await sleep(POLL_INTERVAL_MS);
    }

    const { tokens = [] } = await (
      await call(apiKey, `/transcriptions/${transcriptionId}/transcript`, { signal })
    ).json();
    return { text: formatTranscript(tokens, diarize) };
  } finally {
    // Uploaded audio should not linger on Soniox's side; failures here are harmless.
    const cleanup = { method: "DELETE" };
    if (transcriptionId)
      call(apiKey, `/transcriptions/${transcriptionId}`, cleanup).catch(() => {});
    call(apiKey, `/files/${fileId}`, cleanup).catch(() => {});
  }
}

module.exports = { transcribeAudio, formatTranscript };
