import { Toggle } from "../ui/toggle";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsGroup, SettingsRow, SettingsSection } from "../ui/SettingsSection";
import { useSettingsStore } from "../../stores/settingsStore";
import { BlurField, useCopilotSettings } from "./CopilotFields";

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

export default function CopilotSettingsTab() {
  const { settings: s, update } = useCopilotSettings();
  const denoise = useSettingsStore((st) => st.meetingDenoiseEnabled);
  const setDenoise = useSettingsStore((st) => st.setMeetingDenoiseEnabled);
  if (!s) return null;

  return (
    <div className="space-y-6">
      <SettingsSection
        title="OpenRouter"
        description={
          s.keyFromEnv
            ? "Using the key from the environment."
            : s.hasKey
              ? "A key is saved. Enter a new one to replace it."
              : "The copilot needs an OpenRouter API key."
        }
      >
        <BlurField
          type="password"
          value=""
          placeholder={s.hasKey ? "••••••••" : "sk-or-…"}
          onSave={(apiKey) => apiKey && update({ apiKey })}
        />
      </SettingsSection>

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
          <SettingsRow label="Hotkey" description={s.hotkeyError}>
            <div className="w-44">
              <BlurField value={s.hotkey} onSave={(hotkey) => update({ hotkey })} />
            </div>
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

      <SettingsSection title="Data and audio">
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
          <SettingsRow
            label="Reduce background noise on my mic during meetings"
            description="Ignored while echo cancellation is on."
          >
            <Toggle checked={denoise} onChange={setDenoise} />
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}
