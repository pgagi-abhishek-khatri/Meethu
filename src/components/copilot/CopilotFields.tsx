import { useCallback, useEffect, useState } from "react";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import type { CopilotSettings } from "./copilotApi";
import { acceleratorFromEvent } from "./copilotFormat";

type Patch = Partial<CopilotSettings> & { apiKey?: string };

// Settings of the copilot, loaded from main and shared by every component on the page; updates
// apply optimistically.
let shared: CopilotSettings | null = null;
const listeners = new Set<(s: CopilotSettings | null) => void>();
const publish = (s: CopilotSettings | null) => {
  shared = s;
  listeners.forEach((l) => l(s));
};

export function useCopilotSettings() {
  const [settings, setSettings] = useState<CopilotSettings | null>(shared);
  useEffect(() => {
    listeners.add(setSettings);
    void window.copilot?.getSettings().then(publish);
    return () => void listeners.delete(setSettings);
  }, []);
  const update = useCallback((patch: Patch) => {
    const { apiKey: _key, ...rest } = patch;
    if (shared) publish({ ...shared, ...rest });
    void window.copilot?.updateSettings(patch).then(publish);
  }, []);
  return { settings, update };
}

// Click, press the keys; Backspace clears.
export function HotkeyField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Input
      readOnly
      value={value || "None"}
      className="h-8 w-44 cursor-pointer text-center font-mono text-xs caret-transparent focus:ring-2"
      onKeyDown={(e) => {
        e.preventDefault();
        if (e.key === "Backspace" || e.key === "Delete") return onChange("");
        const acc = acceleratorFromEvent(e);
        if (acc) onChange(acc);
      }}
    />
  );
}

// Text input or textarea that saves when focus leaves it.
export function BlurField({
  value,
  onSave,
  rows,
  type,
  placeholder,
  label,
}: {
  value: string;
  onSave: (v: string) => void;
  rows?: number;
  type?: string;
  placeholder?: string;
  label?: string;
}) {
  const [v, setV] = useState(value);
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setV(value);
  }
  const common = {
    value: v,
    placeholder,
    onBlur: () => v !== value && onSave(v),
  };
  return (
    <label className="block">
      {label && <span className="mb-1 block text-xs font-medium text-foreground">{label}</span>}
      {rows ? (
        <Textarea
          rows={rows}
          {...common}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setV(e.target.value)}
        />
      ) : (
        <Input type={type} {...common} onChange={(e) => setV(e.target.value)} />
      )}
    </label>
  );
}
