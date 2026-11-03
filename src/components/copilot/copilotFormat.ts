// Small helpers shared by the Copilot page and the live window.
import type { KeyboardEvent } from "react";
import { getCachedPlatform } from "../../utils/platform";
import { validateHotkey } from "../../utils/hotkeyValidator";
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

type KeyPress = Parameters<typeof acceleratorFromEvent>[0];
export type HotkeyKeyAction =
  | { kind: "pass" } // let the browser have it (Tab moves focus)
  | { kind: "ignore" } // a modifier on its own, or a key with no modifier: keep waiting
  | { kind: "clear" }
  | { kind: "set"; hotkey: string }
  | { kind: "reject"; error: string };

// What a key press in the hotkey field does. A global shortcut takes the keys from every other app, so the
// system's own (copy, paste, select all, Alt+F4, …) are refused, and Tab still moves focus.
export function hotkeyKeyAction(
  e: KeyPress,
  validate: (hotkey: string) => { valid: boolean; error?: string }
): HotkeyKeyAction {
  const mods = e.ctrlKey || e.metaKey || e.altKey;
  if (e.key === "Tab" && !mods) return { kind: "pass" };
  if ((e.key === "Backspace" || e.key === "Delete") && !mods && !e.shiftKey)
    return { kind: "clear" };
  const hotkey = acceleratorFromEvent(e);
  if (!hotkey) return { kind: "ignore" };
  const v = validate(hotkey);
  return v.valid
    ? { kind: "set", hotkey }
    : { kind: "reject", error: v.error || "That shortcut can't be used." };
}

// A project change, then a fresh list either way: a failure is reported (never an unhandled rejection), and the
// list is read again so the page shows what main really holds.
export function runThenReload(
  task: Promise<unknown>,
  reload: () => void,
  onError: (error: unknown) => void
): Promise<void> {
  return Promise.resolve(task).then(
    () => reload(),
    (error) => {
      onError(error);
      reload();
    }
  );
}

// The key handler both hotkey inputs share: Tab moves on, the system's own shortcuts are refused.
export function onHotkeyKeyDown(
  e: KeyboardEvent,
  onChange: (v: string) => void,
  onReject: (error: string | null) => void
) {
  const a = hotkeyKeyAction(e, (h) => validateHotkey(h, getCachedPlatform()));
  if (a.kind === "pass") return;
  e.preventDefault();
  if (a.kind === "clear") onChange("");
  else if (a.kind === "set") onChange(a.hotkey);
  if (a.kind === "reject") onReject(a.error);
  else if (a.kind !== "ignore") onReject(null);
}
