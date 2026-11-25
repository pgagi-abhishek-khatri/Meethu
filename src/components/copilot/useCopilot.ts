import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { initialState, reduce, type CopilotEvent } from "./copilotState";
import type { CopilotSettings } from "./copilotApi";
import { setLevel } from "./levelStore";

// The window's live state: the engine's events folded by `reduce`, plus the settings.
export function useCopilot() {
  const [state, dispatch] = useReducer(reduce, undefined, initialState);
  const [settings, setSettings] = useState<CopilotSettings | null>(null);
  const settingsRef = useRef<CopilotSettings | null>(null);

  useEffect(() => {
    const api = window.copilot;
    if (!api) return;
    void api.getSettings().then((s) => {
      settingsRef.current = s;
      setSettings(s);
    });
    return api.onEvent((e: CopilotEvent) => {
      if (e.type === "settings") {
        settingsRef.current = e.settings;
        setSettings(e.settings);
      } else if ((e as { type: string }).type === "level") {
        setLevel((e as unknown as { v: number }).v);
      } else if (e.type === "pause" && e.paused) {
        setLevel(0);
        dispatch(e);
      } else dispatch(e);
    });
  }, []);

  const updateSettings = useCallback(
    async (patch: Partial<CopilotSettings> & { apiKey?: string }) => {
      const next = await window.copilot?.updateSettings(patch);
      if (next) {
        settingsRef.current = next;
        setSettings(next);
      }
      return next;
    },
    []
  );

  // 👎 / undo on a card: remembered in the database and, for unasked cards, taught to the engine.
  const markFeedback = useCallback((id: string, value: "down" | null, sessionId: string | null) => {
    dispatch({ type: "feedback", id, value });
    void window.copilot?.feedback(sessionId, id, value);
  }, []);

  const dismissCard = useCallback((id: string) => {
    dispatch({ type: "card_dismiss", id });
  }, []);

  const skipFollowups = useCallback((id: string) => {
    dispatch({ type: "card_skip_followups", id });
  }, []);

  const skipGaps = useCallback((id: string) => {
    dispatch({ type: "card_skip_gaps", id });
  }, []);

  const skipAllMoments = useCallback(() => {
    dispatch({ type: "skip_all_moments" });
  }, []);

  const setPaused = useCallback((paused: boolean) => {
    dispatch({ type: "pause", paused });
    if (paused) setLevel(0);
    if (paused) void window.copilot?.pause?.();
    else void window.copilot?.resume?.();
  }, []);

  const togglePause = useCallback(() => {
    dispatch({ type: "toggle_pause" });
    setLevel(0);
    void window.copilot?.togglePause?.();
  }, []);

  return {
    state,
    settings,
    updateSettings,
    markFeedback,
    dismissCard,
    skipFollowups,
    skipGaps,
    skipAllMoments,
    setPaused,
    togglePause,
    dispatch,
  };
}
