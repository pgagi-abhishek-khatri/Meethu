import { useEffect, useState } from "react";
import { FolderOpen, Plus, Trash2, X } from "../icons";
import type { Project, CopilotSettings } from "./copilotApi";
import { RecentsList } from "./PastMeetings";

interface Props {
  summary: string;
  settings: CopilotSettings | null;
  onSettings: (patch: Partial<CopilotSettings>) => void;
  phase: string; // refreshes the past meetings when a meeting ends
  onPickPast: (id: string) => void;
}

export function SummaryBlock({ summary }: { summary: string }) {
  return (
    <section>
      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        Meeting summary
      </h3>
      {summary ? (
        <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-slate-300">{summary}</p>
      ) : (
        <p className="text-[13px] text-slate-500">
          It appears a few minutes into the meeting and keeps updating.
        </p>
      )}
    </section>
  );
}

export default function ContextView({ summary, settings, onSettings, phase, onPickPast }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState("");
  const [plan, setPlan] = useState(settings?.plan ?? "");
  useEffect(() => setPlan(settings?.plan ?? ""), [settings?.plan]);

  const refresh = () => window.copilot?.projects.list().then(setProjects);
  useEffect(() => void refresh(), []);
  const act = async (fn: () => Promise<unknown> | undefined) => {
    await fn();
    await refresh();
  };

  return (
    <div className="flex-1 space-y-5 overflow-y-auto p-3 text-[13px]">
      <section>
        <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Notes for this meeting
        </h3>
        <textarea
          value={plan}
          rows={4}
          placeholder="Agenda, to-dos, goals. The copilot reads this, and reminds you of it when the meeting starts."
          onChange={(e) => setPlan(e.target.value)}
          onBlur={() => plan !== settings?.plan && onSettings({ plan })}
          className="w-full resize-y rounded-lg border border-white/10 bg-white/[0.04] p-2 text-slate-200 outline-none placeholder:text-slate-500 focus:border-emerald-400/50"
        />
      </section>

      <section>
        <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Projects for this meeting
        </h3>
        <p className="mb-2 text-[11px] text-slate-500">
          Ticked projects give the copilot their files as background. Text, Markdown and CSV files
          are read now; PDF and Word search comes later.
        </p>
        <ul className="space-y-1.5">
          {projects.map((p) => (
            <li key={p.id} className="rounded-xl border border-white/10 bg-white/[0.04] p-2">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={p.active}
                  onChange={(e) =>
                    void act(() => window.copilot?.projects.setActive(p.id, e.target.checked))
                  }
                  className="accent-emerald-400"
                />
                <span className="flex-1 font-medium text-slate-100">{p.name}</span>
                <button
                  type="button"
                  title="Add files"
                  onClick={() => void act(() => window.copilot?.projects.addFiles(p.id))}
                  className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-slate-100"
                >
                  <FolderOpen size={14} />
                </button>
                <button
                  type="button"
                  title="Delete project"
                  onClick={() => void act(() => window.copilot?.projects.remove(p.id))}
                  className="rounded p-1 text-slate-500 hover:bg-white/10 hover:text-rose-300"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              {p.files.length > 0 && (
                <ul className="mt-1 space-y-0.5 ps-6 text-[12px] text-slate-400">
                  {p.files.map((f) => (
                    <li key={f.id} className="flex items-center gap-1" title={f.path}>
                      <span className="flex-1 truncate">– {f.name}</span>
                      <button
                        type="button"
                        title="Remove file"
                        onClick={() => void act(() => window.copilot?.projects.removeFile(f.id))}
                        className="text-slate-600 hover:text-rose-300"
                      >
                        <X size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
        <form
          className="mt-2 flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            void act(() => window.copilot?.projects.create(name.trim()));
            setName("");
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New project"
            className="flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 text-slate-200 outline-none placeholder:text-slate-500 focus:border-emerald-400/50"
          />
          <button
            type="submit"
            title="Create project"
            className="rounded-lg bg-white/10 p-1.5 text-slate-200 hover:bg-white/20"
          >
            <Plus size={14} />
          </button>
        </form>
      </section>

      {summary && <SummaryBlock summary={summary} />}

      <section>
        <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Past meetings
        </h3>
        <RecentsList refreshKey={phase} onPick={onPickPast} />
      </section>
    </div>
  );
}
