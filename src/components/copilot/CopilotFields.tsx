import { useCallback, useEffect, useState } from "react";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import type { CopilotSettings } from "./copilotApi";
import { onHotkeyKeyDown } from "./copilotFormat";
import { createSettingsSync, type SettingsPatch } from "./copilotSettingsSync";

// Settings of the copilot, loaded from main and shared by every component on the page.
const sync = createSettingsSync(() => window.copilot);

export function useCopilotSettings() {
  const [settings, setSettings] = useState<CopilotSettings | null>(sync.get());
  useEffect(() => {
    const off = sync.subscribe(setSettings);
    void sync.load();
    return off;
  }, []);
  const update = useCallback((patch: SettingsPatch) => void sync.update(patch), []);
  return { settings, update };
}

// Click, press the keys; Backspace clears.
export function HotkeyField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-end gap-1">
      <Input
        readOnly
        value={value || "None"}
        aria-invalid={!!error}
        className="h-8 w-44 cursor-pointer text-center font-mono text-xs caret-transparent focus:ring-2"
        onKeyDown={(e) => onHotkeyKeyDown(e, onChange, setError)}
        onBlur={() => setError(null)}
      />
      {error && <span className="text-[11px] text-destructive">{error}</span>}
    </div>
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
