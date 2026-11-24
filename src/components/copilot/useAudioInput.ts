import { useCallback, useEffect, useRef, useState } from "react";

export interface UseAudioInputOptions {
  onTranscript: (text: string, isFinal?: boolean) => void;
  onError?: (error: string) => void;
}

export interface UseAudioInputReturn {
  isRecording: boolean;
  isSupported: boolean;
  durationSeconds: number;
  error: string | null;
  start: () => void;
  stop: () => void;
  cancel: () => void;
  toggle: () => void;
}

// Global speech recognition constructor interface
type SpeechRecognitionConstructor = new () => any;

function getSpeechRecognition(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export function useAudioInput({ onTranscript, onError }: UseAudioInputOptions): UseAudioInputReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const isSupported = typeof window !== "undefined" && getSpeechRecognition() !== null;
  const recognitionRef = useRef<any>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const restartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldRecordRef = useRef(false);
  const cancelledRef = useRef(false);
  const finalTranscriptRef = useRef("");
  const currentInterimRef = useRef("");

  const clearTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const clearRestartTimeout = () => {
    if (restartTimeoutRef.current) {
      clearTimeout(restartTimeoutRef.current);
      restartTimeoutRef.current = null;
    }
  };

  const stop = useCallback(() => {
    shouldRecordRef.current = false;
    cancelledRef.current = false;
    clearRestartTimeout();
    clearTimer();
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // Ignored if already stopped
      }
    }
    setIsRecording(false);
  }, []);

  const cancel = useCallback(() => {
    shouldRecordRef.current = false;
    cancelledRef.current = true;
    clearRestartTimeout();
    clearTimer();
    finalTranscriptRef.current = "";
    currentInterimRef.current = "";
    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch {
        // Ignored if already aborted
      }
    }
    setIsRecording(false);
    setDurationSeconds(0);
  }, []);

  const startSession = useCallback(() => {
    if (!shouldRecordRef.current || cancelledRef.current) return;
    const SpeechRec = getSpeechRecognition();

    if (!SpeechRec) {
      const msg = "Speech recognition is not supported in this environment.";
      setError(msg);
      onError?.(msg);
      shouldRecordRef.current = false;
      setIsRecording(false);
      clearTimer();
      return;
    }

    try {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.onstart = null;
          recognitionRef.current.onresult = null;
          recognitionRef.current.onerror = null;
          recognitionRef.current.onend = null;
          recognitionRef.current.abort();
        } catch {
          // Cleanup old instance
        }
      }

      const recognition = new SpeechRec();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = typeof navigator !== "undefined" ? (navigator.language || "en-US") : "en-US";

      recognition.onstart = () => {
        // Recognition session is active
      };

      recognition.onresult = (event: any) => {
        if (cancelledRef.current || !shouldRecordRef.current) return;
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
          finalTranscriptRef.current = (
            finalTranscriptRef.current + " " + sessionFinal
          ).trim();
          currentInterimRef.current = "";
        } else {
          currentInterimRef.current = sessionInterim;
        }

        const combined = (
          finalTranscriptRef.current + " " + currentInterimRef.current
        ).trim();
        if (combined) {
          onTranscript(combined, Boolean(sessionFinal));
        }
      };

      recognition.onerror = (event: any) => {
        if (cancelledRef.current || !shouldRecordRef.current) return;
        const err = event.error;
        // "no-speech" occurs during normal pauses in conversation.
        // "aborted" occurs on session resets. Neither should terminate recording.
        if (err === "no-speech" || err === "aborted") {
          return;
        }

        let msg = "Microphone error: " + (err || "unknown");
        if (err === "not-allowed") {
          msg = "Microphone access was denied. Please check permissions.";
          shouldRecordRef.current = false;
          setIsRecording(false);
          clearTimer();
        } else if (err === "network") {
          msg = "Speech recognition network error.";
        }
        setError(msg);
        onError?.(msg);
      };

      recognition.onend = () => {
        // Chromium ends recognition on silence/turn boundaries.
        // If the user is still recording, automatically restart so input doesn't stop after 1 second.
        if (shouldRecordRef.current && !cancelledRef.current) {
          clearRestartTimeout();
          restartTimeoutRef.current = setTimeout(() => {
            if (shouldRecordRef.current && !cancelledRef.current) {
              startSession();
            }
          }, 50);
        } else {
          clearTimer();
          setIsRecording(false);
        }
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch (e: any) {
      if (shouldRecordRef.current && !cancelledRef.current) {
        clearRestartTimeout();
        restartTimeoutRef.current = setTimeout(() => {
          if (shouldRecordRef.current && !cancelledRef.current) {
            try {
              startSession();
            } catch (err: any) {
              const msg = "Could not start audio input: " + (err?.message || String(err));
              setError(msg);
              onError?.(msg);
              shouldRecordRef.current = false;
              setIsRecording(false);
              clearTimer();
            }
          }
        }, 150);
      } else {
        const msg = "Could not start audio input: " + (e?.message || String(e));
        setError(msg);
        onError?.(msg);
        shouldRecordRef.current = false;
        setIsRecording(false);
        clearTimer();
      }
    }
  }, [onError, onTranscript]);

  const start = useCallback(() => {
    setError(null);
    cancelledRef.current = false;
    shouldRecordRef.current = true;
    finalTranscriptRef.current = "";
    currentInterimRef.current = "";
    setIsRecording(true);
    setDurationSeconds(0);
    clearTimer();
    clearRestartTimeout();
    timerRef.current = setInterval(() => {
      setDurationSeconds((d) => d + 1);
    }, 1000);
    startSession();
  }, [startSession]);

  const toggle = useCallback(() => {
    if (isRecording) {
      stop();
    } else {
      start();
    }
  }, [isRecording, start, stop]);

  useEffect(() => {
    return () => {
      clearTimer();
      clearRestartTimeout();
      shouldRecordRef.current = false;
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {
          // Cleanup on unmount
        }
      }
    };
  }, []);

  return {
    isRecording,
    isSupported,
    durationSeconds,
    error,
    start,
    stop,
    cancel,
    toggle,
  };
}
