import { useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Toggle } from "../ui/toggle";
import { cn } from "../lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsGroup, SettingsRow, SettingsSection } from "../ui/SettingsSection";
import { useSettingsStore } from "../../stores/settingsStore";
import { BlurField, HotkeyField, useCopilotSettings } from "./CopilotFields";

function Pick({
  value,
  options,
  onChange,
}: {
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(([v, label]) => (
          <SelectItem key={v} value={v}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const num = (v: string, min: number) => Math.max(min, Math.round(Number(v)) || min);

// `embedded`: shown inside the Copilot page, whose Audio & keys section has the key and the mic rows.
export default function CopilotSettingsTab({ embedded = false }: { embedded?: boolean }) {
  const { settings: s, update } = useCopilotSettings();
  if (!s) return null;

  return (
    <div className="space-y-6">
      {!embedded && <OpenRouterKeySection />}

      <SettingsSection title="Models">
        <SettingsGroup>
          <BlurField
            label="Main model"
            value={s.mainModel}
            placeholder="qwen/qwen3.8-27b-20260814:nitro"
            onSave={(mainModel) => update({ mainModel })}
          />
          <BlurField
            label="High-effort model"
            value={s.deepModel}
            placeholder="anthropic/claude-sonnet-5.5"
            onSave={(deepModel) => update({ deepModel })}
          />
          <BlurField
            label="Summary model"
            value={s.summaryModel}
            placeholder="deepseek/deepseek-v4.1-flash:nitro"
            onSave={(summaryModel) => update({ summaryModel })}
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Behavior">
        <SettingsGroup>
          <SettingsRow label="Enabled">
            <Toggle checked={s.enabled} onChange={(enabled) => update({ enabled })} />
          </SettingsRow>
          <SettingsRow label="Pace">
            <Pick
              value={s.quiet}
              options={[
                ["quiet", "Quiet"],
                ["normal", "Normal"],
                ["chatty", "Chatty"],
              ]}
              onChange={(quiet) => update({ quiet: quiet as typeof s.quiet })}
            />
          </SettingsRow>
          <SettingsRow label="Web search in quick answers">
            <Toggle checked={s.web} onChange={(web) => update({ web })} />
          </SettingsRow>
          <SettingsRow label="Parallel answers">
            <div className="w-20">
              <BlurField
                type="number"
                value={String(s.maxParallel)}
                onSave={(v) => update({ maxParallel: num(v, 1) })}
              />
            </div>
          </SettingsRow>
          <SettingsRow label="Pick the project from the calendar event">
            <Toggle checked={s.autoProject} onChange={(autoProject) => update({ autoProject })} />
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Window">
        <SettingsGroup>
          <SettingsRow label="Open automatically with a meeting">
            <Toggle checked={s.autoOpen} onChange={(autoOpen) => update({ autoOpen })} />
          </SettingsRow>
          <SettingsRow label="Open as">
            <Pick
              value={s.idleMode}
              options={[
                ["orb", "A small orb"],
                ["full", "Full panel"],
              ]}
              onChange={(idleMode) => update({ idleMode: idleMode as typeof s.idleMode })}
            />
          </SettingsRow>
          <SettingsRow label="Peek seconds" description="How long a new card stays beside the orb.">
            <div className="w-20">
              <BlurField
                type="number"
                value={String(s.peekSeconds)}
                onSave={(v) => update({ peekSeconds: num(v, 0) })}
              />
            </div>
          </SettingsRow>
          <SettingsRow label="When the meeting ends">
            <Pick
              value={s.onEnd}
              options={[
                ["close", "Close"],
                ["orb", "Shrink to orb"],
                ["keep", "Keep open"],
              ]}
              onChange={(onEnd) => update({ onEnd: onEnd as typeof s.onEnd })}
            />
          </SettingsRow>
          <SettingsRow
            label="Show / hide hotkey"
            description={s.hotkeyError || "Click, then press the keys. Backspace clears."}
          >
            <HotkeyField value={s.hotkey} onChange={(hotkey) => update({ hotkey })} />
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Project files"
        description="Files you add to a project are read once, in the background, and searched during meetings."
      >
        <SettingsGroup>
          <SettingsRow label="Search project files in meetings">
            <Toggle checked={s.ragEnabled} onChange={(ragEnabled) => update({ ragEnabled })} />
          </SettingsRow>
          <SettingsRow
            label="Audio and video: minutes embedded as sound or picture"
            description="Per file. After this, it is found by its transcript only (cheaper)."
          >
            <div className="w-20">
              <BlurField
                type="number"
                value={String(s.mediaEmbedMinutes)}
                onSave={(v) => update({ mediaEmbedMinutes: num(v, 0) })}
              />
            </div>
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title={embedded ? "Data" : "Data and audio"}>
        <SettingsGroup>
          <SettingsRow label="Keep past meetings for (days)">
            <div className="w-20">
              <BlurField
                type="number"
                value={String(s.retentionDays)}
                onSave={(v) => update({ retentionDays: num(v, 1) })}
              />
            </div>
          </SettingsRow>
          {!embedded && <DenoiseRow />}
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}

export function DenoiseRow() {
  const denoise = useSettingsStore((st) => st.meetingDenoiseEnabled);
  const setDenoise = useSettingsStore((st) => st.setMeetingDenoiseEnabled);
  return (
    <SettingsRow
      label="Reduce background noise on my mic during meetings"
      description="Ignored while echo cancellation is on."
    >
      <Toggle checked={denoise} onChange={setDenoise} />
    </SettingsRow>
  );
}

// The OpenRouter key that runs every copilot model call.
export function OpenRouterKeySection() {
  const { settings: s, update } = useCopilotSettings();
  const [key, setKey] = useState("");
  if (!s) return null;
  const save = () => {
    if (!key.trim()) return;
    update({ apiKey: key.trim() });
    setKey("");
  };
  return (
    <SettingsSection
      title="OpenRouter key"
      description="One key runs every copilot model: deciding, answering, summaries and reading project files. Stored encrypted on this computer."
    >
      <SettingsGroup>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
              s.hasKey ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"
            )}
          >
            <span
              className={cn("h-1.5 w-1.5 rounded-full", s.hasKey ? "bg-success" : "bg-destructive")}
            />
            {s.keyFromEnv ? "From .env" : s.hasKey ? "Saved" : "Missing"}
          </span>
          <Input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
            placeholder={s.hasKey ? "Paste a new key to replace it" : "sk-or-…"}
            className="h-8"
          />
          <Button size="sm" disabled={!key.trim()} onClick={save}>
            Save
          </Button>
        </div>
        <button
          type="button"
          onClick={() => window.electronAPI?.openExternal?.("https://openrouter.ai/keys")}
          className="text-xs text-primary/80 hover:text-primary"
        >
          Get a key at openrouter.ai
        </button>
      </SettingsGroup>
    </SettingsSection>
  );
}
