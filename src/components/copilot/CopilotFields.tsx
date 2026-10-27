import { useCallback, useEffect, useState } from "react";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import type { CopilotSettings } from "./copilotApi";

type Patch = Partial<CopilotSettings> & { apiKey?: string };

// Settings of the copilot, loaded from main; updates apply optimistically.
export function useCopilotSettings() {
  const [settings, setSettings] = useState<CopilotSettings | null>(null);
  useEffect(() => {
    void window.copilot?.getSettings().then(setSettings);
  }, []);
  const update = useCallback((patch: Patch) => {
    const { apiKey: _key, ...rest } = patch;
    setSettings((s) => (s ? { ...s, ...rest } : s));
    void window.copilot?.updateSettings(patch).then(setSettings);
  }, []);
  return { settings, update };
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
