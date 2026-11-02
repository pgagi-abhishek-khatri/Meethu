// Small helpers shared by the Copilot page and the live window.

export const WORKING = new Set(["queued", "reading", "analysing", "embedding"]);

export const when = (t: number) =>
  new Date(t).toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

export const duration = (from: number, to: number | null) => {
  if (!to) return "";
  const m = Math.max(1, Math.round((to - from) / 60000));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};

// Electron accelerator from a key press: needs a modifier and a real key.
export function acceleratorFromEvent(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): string | null {
  if (["Control", "Shift", "Alt", "Meta", "AltGraph"].includes(e.key)) return null;
  const named: Record<string, string> = {
    " ": "Space",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Escape: "Esc",
  };
  const key = named[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  const mods = [
    e.ctrlKey && "CommandOrControl",
    e.metaKey && "Super",
    e.altKey && "Alt",
    e.shiftKey && "Shift",
  ].filter(Boolean) as string[];
  return mods.length ? [...mods, key].join("+") : null;
}
