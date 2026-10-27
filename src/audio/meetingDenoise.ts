// Cleans the meeting microphone before it is sent to the transcriber: a speech-enhancement network (GTCRN)
// removes keyboards, fans, traffic and other voices far from the mic, then a noise gate cuts what is left
// between words, so the transcriber is not fed room sound it would turn into words.
// Both run in AudioWorklets at 48 kHz (what the models need); the PCM worklet in meetingRecordingStore
// brings the result back down to the 24 kHz the transcribers take.
// Loaded on demand. The worklet sources are fetched and handed to the context as Blob URLs, because a packaged
// build loads the renderer from file:// where a module worklet cannot be added by URL.
export const DENOISE_SAMPLE_RATE = 48000;

export interface MicDenoiser {
  input: AudioNode;
  output: AudioNode;
  destroy: () => void;
}

const blobUrl = (code: string) =>
  URL.createObjectURL(new Blob([code], { type: "application/javascript" }));

// Gate: open above -50 dB, close below -55 dB after 350 ms; a denoised room is far under both.
const GATE = { openThreshold: -50, closeThreshold: -55, holdMs: 350, maxChannels: 1 };

// Resolves null when anything fails (no AudioWorklet, wasm refused): the caller then uses the raw mic.
export async function createMicDenoiser(context: AudioContext): Promise<MicDenoiser | null> {
  if (context.sampleRate !== DENOISE_SAMPLE_RATE) return null;
  try {
    const [lib, gtcrnPath, gatePath, wasmPath] = await Promise.all([
      import("@sapphi-red/web-noise-suppressor"),
      import("@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?url").then((m) => m.default),
      import("@sapphi-red/web-noise-suppressor/noiseGateWorklet.js?url").then((m) => m.default),
      import("@sapphi-red/web-noise-suppressor/gtcrn.wasm?url").then((m) => m.default),
    ]);
    const [gtcrnCode, gateCode, wasmBinary] = await Promise.all([
      fetch(gtcrnPath).then((r) => r.text()),
      fetch(gatePath).then((r) => r.text()),
      lib.loadGtcrn({ url: wasmPath }),
    ]);
    const urls = [blobUrl(gtcrnCode), blobUrl(gateCode)];
    try {
      await context.audioWorklet.addModule(urls[0]);
      await context.audioWorklet.addModule(urls[1]);
    } finally {
      urls.forEach((u) => URL.revokeObjectURL(u));
    }
    const enhance = new lib.GtcrnWorkletNode(context, {
      maxChannels: 1,
      wasmBinary,
    });
    const gate = new lib.NoiseGateWorkletNode(context, GATE);
    // The network takes speech down by about 12 dB (measured on a real recording); give it back.
    const makeup = context.createGain();
    makeup.gain.value = 3.5;
    enhance.connect(gate);
    gate.connect(makeup);
    return {
      input: enhance,
      output: makeup,
      destroy: () => {
        try {
          enhance.destroy();
        } catch {}
        enhance.disconnect();
        gate.disconnect();
        makeup.disconnect();
      },
    };
  } catch {
    return null;
  }
}
