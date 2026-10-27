import { useEffect, useState } from "react";
import { ArrowLeft, Trash2 } from "../icons";
import MarkdownRenderer from "../ui/MarkdownRenderer";
import type { PastSession, PastSessionDetail } from "./copilotApi";

const when = (t: number) =>
  new Date(t).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

// Earlier meetings, newest first.
export function RecentsList({
  refreshKey,
  onPick,
}: {
  refreshKey: unknown;
  onPick: (id: string) => void;
}) {
  const [list, setList] = useState<PastSession[]>([]);
  useEffect(() => {
    void window.copilot?.sessions.list().then(setList);
  }, [refreshKey]);
  if (!list.length) return <p className="text-[12px] text-slate-600">None yet.</p>;
  return (
    <ul className="space-y-1">
      {list.slice(0, 8).map((s) => (
        <li key={s.id}>
          <button
            type="button"
            onClick={() => onPick(s.id)}
            className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-start text-[12px] text-slate-300 hover:bg-white/[0.06]"
          >
            <span>{when(s.started_at)}</span>
            <span className="text-slate-500">
              {s.cards} card{s.cards === 1 ? "" : "s"}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// One earlier meeting: its summary and cards, read-only.
export function PastMeeting({
  id,
  onBack,
  onDeleted,
}: {
  id: string;
  onBack: () => void;
  onDeleted: () => void;
}) {
  const [d, setD] = useState<PastSessionDetail | null>(null);
  useEffect(() => {
    void window.copilot?.sessions.get(id).then(setD);
  }, [id]);
  if (!d) return <div className="p-4 text-slate-500">Loading…</div>;
  const cards = d.cards.filter((c) => c.status === "done");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2 text-[12px] text-slate-300">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 text-sky-300 hover:underline"
        >
          <ArrowLeft size={13} /> Live
        </button>
        <span className="flex-1 text-center">{when(d.session.started_at)}</span>
        <button
          type="button"
          title="Delete this meeting"
          onClick={async () => {
            await window.copilot?.sessions.remove(id);
            onDeleted();
          }}
          className="text-slate-500 hover:text-rose-300"
        >
          <Trash2 size={14} />
        </button>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-3 text-[13px]">
        {d.session.summary && (
          <p className="whitespace-pre-wrap text-slate-300">{d.session.summary}</p>
        )}
        {!cards.length && <p className="text-slate-500">No cards were made in this meeting.</p>}
        {cards.map((c) => (
          <article
            key={c.id}
            className="rounded-xl border border-white/10 bg-white/[0.04] p-3 text-slate-200"
          >
            <h3 className="font-semibold text-slate-50">{c.title || c.label}</h3>
            <div className="copilot-md mt-1">{c.body && <MarkdownRenderer content={c.body} />}</div>
          </article>
        ))}
      </div>
    </div>
  );
}
