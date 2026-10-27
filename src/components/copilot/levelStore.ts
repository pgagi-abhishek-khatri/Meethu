import { useSyncExternalStore } from "react";

// Loudness of the meeting audio (0..1), pushed ~12x a second. Kept outside the reducer so the orb's bars
// move without re-rendering the whole copilot window.
let level = 0;
const listeners = new Set<() => void>();

export function setLevel(v: number) {
  level = v;
  listeners.forEach((l) => l());
}

export const useLevel = () =>
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => level
  );
