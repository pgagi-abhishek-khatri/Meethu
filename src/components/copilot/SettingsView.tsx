import { useState } from "react";
import type { CopilotSettings } from "./copilotApi";
import type { CopilotState } from "./copilotState";

interface Props {
  settings: CopilotSettings | null;
  state: CopilotState;
  onSettings: (patch: Partial<CopilotSettings> & { apiKey?: string }) => void;
}

const field =
  "w-full rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 text-slate-200 outline-none placeholder:text-slate-500 focus:border-emerald-400/50";

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      {hint && <p className="text-[11px] text-slate-500">{hint}</p>}
      {children}
    </section>
  );
}

function Text({
  label,
  value,
  placeholder,
  rows,
  onSave,
}: {
  label?: string;
  value: string;
  placeholder?: string;
  rows?: number;
  onSave: (v: string) => void;
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
    className: field,
    onChange: (e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) =>
      setV(e.target.value),
    onBlur: () => v !== value && onSave(v),
  };
  return (
    <label className="block">
      {label && <span className="mb-0.5 block text-[12px] text-slate-400">{label}</span>}
      {rows ? <textarea rows={rows} {...common} /> : <input {...common} />}
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-slate-300">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-emerald-400"
      />
      {label}
    </label>
  );
}

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

export default function SettingsView({ settings: s, state, onSettings }: Props) {
  const [key, setKey] = useState("");
  const [debug, setDebug] = useState(false);
  if (!s) return <div className="p-4 text-slate-500">Loading…</div>;

  return (
    <div className="flex-1 space-y-5 overflow-y-auto p-3 text-[13px]">
      <Section
        title="AI account"
        hint="One OpenRouter key runs the copilot. It is stored encrypted on this computer."
      >
        <div className="flex gap-1.5">
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={
              s.hasKey
                ? s.keyFromEnv
                  ? "Using the key from .env"
                  : "Key saved (type to replace)"
                : "sk-or-…"
            }
            className={field}
          />
          <button
            type="button"
            disabled={!key.trim()}
            onClick={() => {
              onSettings({ apiKey: key });
              setKey("");
            }}
            className="rounded-lg bg-emerald-500/25 px-3 text-emerald-100 hover:bg-emerald-500/40 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </Section>

      <Section title="Behaviour">
        <Toggle
          label="Copilot on"
          checked={s.enabled}
          onChange={(enabled) => onSettings({ enabled })}
        />
        <Toggle
          label="Open the window when a meeting starts"
          checked={s.autoOpen}
          onChange={(autoOpen) => onSettings({ autoOpen })}
        />
        <Toggle
          label="Search the web in quick answers (slower)"
          checked={s.web === true}
          onChange={(web) => onSettings({ web })}
        />
        <label className="block">
          <span className="mb-0.5 block text-[12px] text-slate-400">
            How busy the copilot is on its own
          </span>
          <select
            value={s.quiet}
            onChange={(e) => onSettings({ quiet: e.target.value as CopilotSettings["quiet"] })}
            className={field}
          >
            <option value="quiet">Calm: speaks up only for clear needs</option>
            <option value="normal">Balanced: a card when something is worth it</option>
            <option value="chatty">Lively: speaks up often</option>
          </select>
        </label>
      </Section>

      <Section title="Window">
        <label className="block">
          <span className="mb-0.5 block text-[12px] text-slate-400">
            Show / hide hotkey (click, press the keys; Backspace clears)
          </span>
          <input
            readOnly
            value={s.hotkey || "None"}
            className={field}
            onKeyDown={(e) => {
              e.preventDefault();
              if (e.key === "Backspace" || e.key === "Delete") return onSettings({ hotkey: "" });
              const acc = acceleratorFromEvent(e);
              if (acc) onSettings({ hotkey: acc });
            }}
          />
          {s.hotkeyError && <span className="text-[11px] text-rose-300">{s.hotkeyError}</span>}
        </label>
        <label className="block">
          <span className="mb-0.5 block text-[12px] text-slate-400">
            Opacity: {Math.round(s.opacity * 100)}%
          </span>
          <input
            type="range"
            min={30}
            max={100}
            value={Math.round(s.opacity * 100)}
            onChange={(e) => onSettings({ opacity: Number(e.target.value) / 100 })}
            className="w-full accent-emerald-400"
          />
        </label>
        <Toggle
          label="Solid only on hover or when a card arrives"
          checked={s.fadeWhenIdle}
          onChange={(fadeWhenIdle) => onSettings({ fadeWhenIdle })}
        />
      </Section>

      <Section
        title="Your instructions"
        hint="Steer the copilot in words. Leave empty for the built-in behaviour."
      >
        <Text
          rows={3}
          value={s.instructions}
          placeholder="e.g. I am a sales lead. Answer in short English. Point out risks in what the client says."
          onSave={(instructions) => onSettings({ instructions })}
        />
      </Section>

      <details>
        <summary className="cursor-pointer text-[12px] text-sky-300 hover:underline">
          More settings
        </summary>
        <div className="mt-4 space-y-5">
          <Section title="Start and end of a meeting">
            <Toggle
              label="Write a recap card when the meeting ends"
              checked={s.endRecap}
              onChange={(endRecap) => onSettings({ endRecap })}
            />
            <Text
              label="At the start (runs when you wrote notes for the meeting)"
              rows={2}
              value={s.startPrompt}
              placeholder="Remind me of the goals and the points to cover."
              onSave={(startPrompt) => onSettings({ startPrompt })}
            />
            <Text
              label="At the end"
              rows={2}
              value={s.endPrompt}
              placeholder="Wrap up: decisions, open questions and next steps."
              onSave={(endPrompt) => onSettings({ endPrompt })}
            />
          </Section>

          <Section
            title="Models"
            hint="OpenRouter model ids. Empty = built-in default. Changes apply from the next meeting."
          >
            <Text
              label="Answers"
              value={s.mainModel}
              placeholder="qwen/qwen3.8-27b-20260814:nitro"
              onSave={(mainModel) => onSettings({ mainModel })}
            />
            <Text
              label="Rerun with high effort"
              value={s.deepModel}
              placeholder="anthropic/claude-sonnet-5.5"
              onSave={(deepModel) => onSettings({ deepModel })}
            />
            <Text
              label="Summary"
              value={s.summaryModel}
              placeholder="built-in"
              onSave={(summaryModel) => onSettings({ summaryModel })}
            />
            <label className="block">
              <span className="mb-0.5 block text-[12px] text-slate-400">
                Questions answered at the same time: {s.maxParallel}
              </span>
              <input
                type="range"
                min={1}
                max={6}
                value={s.maxParallel}
                onChange={(e) => onSettings({ maxParallel: Number(e.target.value) })}
                className="w-full accent-emerald-400"
              />
            </label>
          </Section>

          <Section
            title="Privacy"
            hint="During a meeting, recent transcript text goes to OpenRouter to decide and to answer. Past meetings stay on this computer."
          >
            <label className="block">
              <span className="mb-0.5 block text-[12px] text-slate-400">
                Forget meetings after (days, 0 = never)
              </span>
              <input
                type="number"
                min={0}
                value={s.retentionDays}
                onChange={(e) => onSettings({ retentionDays: Number(e.target.value) })}
                className={field}
              />
            </label>
          </Section>

          <Section title="Debug">
            <button
              type="button"
              onClick={() => setDebug(!debug)}
              className="text-[12px] text-sky-300 hover:underline"
            >
              {debug ? "Hide" : "Show"} decisions of this meeting ({state.decisions.length})
            </button>
            {debug && (
              <div className="space-y-1">
                {[...state.decisions].reverse().map((d, i) => (
                  <div key={i} className="rounded bg-black/25 p-1.5 text-[11px] text-slate-400">
                    <span className={d.kind === "run" ? "text-emerald-300" : "text-slate-300"}>
                      {d.kind}
                    </span>
                    {d.deliverable && d.kind === "run" ? ` · ${d.deliverable}` : ""} ·{" "}
                    {d.callMs ?? "?"} ms · {d.reasons?.join(", ")}
                    <div className="truncate text-slate-500">{d.newText}</div>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>
      </details>
    </div>
  );
}
