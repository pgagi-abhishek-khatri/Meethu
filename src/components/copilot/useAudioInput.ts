import { useCallback, useEffect, useRef, useState } from "react";

export type AudioInputStatus = "idle" | "recording" | "transcribing";

export interface UseAudioInputOptions {
  onTranscript: (text: string, isFinal?: boolean) => void;
  onError?: (error: string) => void;
}

export interface UseAudioInputReturn {
  status: AudioInputStatus;
  isRecording: boolean;
  isTranscribing: boolean;
  isSupported: boolean;
  durationSeconds: number;
  error: string | null;
  start: () => void;
  stop: () => void;
  cancel: () => void;
  toggle: () => void;
}

const PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];

export function resolveAudioMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return undefined;
  }
  return PREFERRED_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

export function mapMediaErrorMessage(err: unknown): string {
  const name = (err as { name?: string })?.name || "";
  const message = err instanceof Error ? err.message : String(err || "");
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "Microphone access was denied. Please check permissions.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No microphone was found.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "Microphone is already in use by another application.";
  }
  return message ? `Could not start audio input: ${message}` : "Could not start audio input.";
}

export function useAudioInput({ onTranscript, onError }: UseAudioInputOptions): UseAudioInputReturn {
  const [status, setStatus] = useState<AudioInputStatus>("idle");
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const isSupported =
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof MediaRecorder !== "undefined";

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelledRef = useRef(false);
  const mimeTypeRef = useRef<string>("audio/webm");

  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const releaseStream = useCallback(() => {
    recorderRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // Ignore track stop errors during cleanup
        }
      });
      streamRef.current = null;
    }
  }, []);

  const reportError = useCallback((msg: string) => {
    setError(msg);
    onErrorRef.current?.(msg);
  }, []);

  const finishRecording = useCallback(async () => {
    clearTimer();
    const mimeType = mimeTypeRef.current || "audio/webm";
    const blob = new Blob(chunksRef.current, { type: mimeType });
    chunksRef.current = [];
    releaseStream();

    if (cancelledRef.current) {
      setStatus("idle");
      setDurationSeconds(0);
      return;
    }

    if (blob.size === 0) {
      setStatus("idle");
      reportError("No audio was recorded.");
      return;
    }

    const transcribe = window.copilot?.transcribeAudio;
    if (typeof transcribe !== "function") {
      setStatus("idle");
      reportError("Voice transcription is unavailable in this environment.");
      return;
    }

    setStatus("transcribing");
    try {
      const buffer = await blob.arrayBuffer();
      const res = await transcribe(buffer, mimeType);
      if (cancelledRef.current) {
        return;
      }
      const text = typeof res?.text === "string" ? res.text.trim() : "";
      if (!res?.ok || !text) {
        reportError(res?.error || "No speech was detected in the recording.");
      } else {
        setError(null);
        onTranscriptRef.current(text, true);
      }
    } catch (err) {
      if (!cancelledRef.current) {
        reportError(err instanceof Error ? err.message : "Voice transcription failed.");
      }
    } finally {
      setStatus("idle");
    }
  }, [clearTimer, releaseStream, reportError]);

  const stop = useCallback(() => {
    clearTimer();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        releaseStream();
        setStatus("idle");
      }
    } else if (status === "recording") {
      releaseStream();
      setStatus("idle");
    }
  }, [clearTimer, releaseStream, status]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    clearTimer();
    chunksRef.current = [];
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        releaseStream();
      }
    } else {
      releaseStream();
    }
    setStatus("idle");
    setDurationSeconds(0);
    setError(null);
  }, [clearTimer, releaseStream]);

  const start = useCallback(async () => {
    if (recorderRef.current || status !== "idle") return;
    setError(null);
    cancelledRef.current = false;

    if (!isSupported) {
      reportError("Audio recording is not supported in this environment.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (cancelledRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      const chosenMime = resolveAudioMimeType();
      const recorder = chosenMime
        ? new MediaRecorder(stream, { mimeType: chosenMime })
        : new MediaRecorder(stream);

      mimeTypeRef.current = recorder.mimeType || chosenMime || "audio/webm";
      chunksRef.current = [];

      recorder.ondataavailable = (e: BlobEvent) => {
        if (e.data && e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };
      recorder.onerror = () => {
        clearTimer();
        releaseStream();
        setStatus("idle");
        reportError("Microphone recording error occurred.");
      };
      recorder.onstop = () => {
        void finishRecording();
      };

      recorderRef.current = recorder;
      streamRef.current = stream;
      setDurationSeconds(0);
      setStatus("recording");
      clearTimer();
      timerRef.current = setInterval(() => {
        setDurationSeconds((d) => d + 1);
      }, 1000);
      recorder.start(250);
    } catch (err) {
      clearTimer();
      releaseStream();
      setStatus("idle");
      reportError(mapMediaErrorMessage(err));
    }
  }, [clearTimer, finishRecording, isSupported, releaseStream, reportError, status]);

  const toggle = useCallback(() => {
    if (status === "recording") {
      stop();
    } else if (status === "idle") {
      void start();
    }
  }, [start, status, stop]);

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      clearTimer();
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          // Ignore stop errors on unmount
        }
      }
      releaseStream();
    };
  }, [clearTimer, releaseStream]);

  return {
    status,
    isRecording: status === "recording",
    isTranscribing: status === "transcribing",
    isSupported,
    durationSeconds,
    error,
    start,
    stop,
    cancel,
    toggle,
  };
}
