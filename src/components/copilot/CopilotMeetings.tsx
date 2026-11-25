import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Copy, MessageSquareText, Search, Trash2 } from "../icons";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ConfirmDialog } from "../ui/dialog";
import { useToast } from "../ui/useToast";
import MarkdownRenderer from "../ui/MarkdownRenderer";
import { cn } from "../lib/utils";
import { PaneHeader } from "./CopilotPane";
import { duration, when } from "./copilotFormat";
import type { PastSession, PastSessionDetail, Project } from "./copilotApi";

type Segment = PastSessionDetail["segments"][number];
const who = (s: Segment) => (s.source === "mic" ? "You" : s.speaker || "Them");
const clock = (at: number | null, start: number) => {
  if (at == null) return "";
  const sec = Math.max(0, Math.round((at - start) / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
};
const transcriptText = (d: PastSessionDetail) =>
  d.segments.map((s) => `${who(s)}: ${s.text}`).join("\n");

function MeetingDetail({
  id,
  projects,
  onBack,
  onDeleted,
}: {
  id: string;
  projects: Project[];
  onBack: () => void;
  onDeleted: () => void;
}) {
  const { toast } = useToast();
  // undefined while loading; null when the meeting is gone (deleted, or pruned by the retention setting)
  const [d, setD] = useState<PastSessionDetail | null | undefined>(undefined);
  const [tab, setTab] = useState<"cards" | "transcript">("cards");
  const [find, setFind] = useState("");
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    let current = true; // the answer for a meeting opened earlier must not replace this one
    setD(undefined);
    const get = window.copilot?.sessions.get(id);
    if (!get) setD(null);
    else
      void get.then(
        (r) => current && setD(r ?? null),
        () => current && setD(null)
      );
    return () => {
      current = false;
    };
  }, [id]);
  if (d === undefined) return <p className="text-xs text-muted-foreground">Loading…</p>;
  if (d === null)
    return (
      <div className="space-y-2">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={13} /> All meetings
        </button>
        <p className="text-sm text-muted-foreground">
          This meeting is no longer saved. It was deleted, or removed by the keep-meetings setting.
        </p>
      </div>
    );

  const s = d.session;
  const cards = d.cards.filter((c) => c.status === "done");
  const project = projects.find((p) => p.id === s.project_id)?.name;
  const q = find.trim().toLowerCase();
  const lines = q ? d.segments.filter((g) => g.text.toLowerCase().includes(q)) : d.segments;
  const copy = async () => {
    await navigator.clipboard.writeText(transcriptText(d));
    toast({ title: "Transcript copied" });
  };

  return (
    <div className="space-y-4">
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Delete this meeting?"
        description="Its transcript and cards are removed from the copilot."
        confirmText="Delete"
        variant="destructive"
        onConfirm={async () => {
          try {
            await window.copilot?.sessions.remove(id);
            onDeleted();
          } catch (error) {
            toast({
              title: "The meeting could not be deleted",
              description: error instanceof Error ? error.message : String(error),
              variant: "destructive",
            });
          }
        }}
      />
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft size={13} /> All meetings
      </button>
      <PaneHeader
        title={s.title || "Meeting"}
        description={[when(s.started_at), duration(s.started_at, s.ended_at), project]
          .filter(Boolean)
          .join(" · ")}
        actions={
          <>
            <Button size="sm" variant="outline" disabled={!d.segments.length} onClick={copy}>
              <Copy size={13} className="me-1" /> Copy transcript
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              title="Delete meeting"
              onClick={() => setConfirm(true)}
            >
              <Trash2 size={14} />
            </Button>
          </>
        }
      />
      {s.summary && (
        <div className="rounded-lg border border-border/70 bg-card/50 px-4 py-3 text-xs leading-relaxed text-foreground/85 dark:border-border-subtle dark:bg-surface-2/50">
          <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
            Summary
          </p>
          <p className="whitespace-pre-wrap">{s.summary}</p>
        </div>
      )}

      <div className="flex items-center gap-1 border-b border-border/60 dark:border-white/8">
        {(
          [
            ["cards", `Cards · ${cards.length}`],
            ["transcript", `Transcript · ${d.segments.length}`],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-xs transition-colors",
              tab === k
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "cards" &&
        (cards.length ? (
          <div className="space-y-2.5">
            {cards.map((c) => (
              <article
                key={c.id}
                className="rounded-lg border border-border/70 bg-card/50 px-4 py-3 dark:border-border-subtle dark:bg-surface-2/50"
              >
                <div className="flex items-center gap-2">
                  <h4 className="text-xs font-semibold text-foreground">{c.title || c.label}</h4>
                  {c.feedback === "down" && (
                    <span className="text-[10px] text-muted-foreground">· marked not helpful</span>
                  )}
                </div>
                {c.body && (
                  <div className="mt-1 text-xs text-foreground/85">
                    <MarkdownRenderer content={c.body} />
                  </div>
                )}
              </article>
            ))}
          </div>
        ) : (
          <p className="py-6 text-center text-xs text-muted-foreground">
            No cards were made in this meeting.
          </p>
        ))}

      {tab === "transcript" && (
        <div className="space-y-3">
          <div className="relative">
            <Search
              size={13}
              className="absolute start-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={find}
              onChange={(e) => setFind(e.target.value)}
              placeholder="Find in transcript"
              className="h-8 ps-8"
            />
          </div>
          {lines.length ? (
            <div className="space-y-2">
              {lines.map((g) => (
                <div key={g.seq} className="flex gap-3 text-xs leading-relaxed">
                  <span className="w-10 shrink-0 pt-px text-end font-mono text-[10.5px] text-muted-foreground/60">
                    {clock(g.at, s.started_at)}
                  </span>
                  <div className="min-w-0">
                    <span
                      className={cn(
                        "me-1.5 font-medium",
                        g.source === "mic" ? "text-primary" : "text-foreground"
                      )}
                    >
                      {who(g)}
                    </span>
                    <span className="text-foreground/80">{g.text}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="py-6 text-center text-xs text-muted-foreground">
              {q ? "Nothing matches." : "No transcript was saved."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function CopilotMeetings({
  list,
  total = list.length,
  projects,
  reload,
  open,
  onOpen,
}: {
  list: PastSession[];
  total?: number; // saved in all; the list holds the newest only
  projects: Project[];
  reload: () => void;
  open: string | null;
  onOpen: (id: string | null) => void;
}) {
  const [q, setQ] = useState("");
  const [projectFilter, setProjectFilter] = useState<number | "all">("all");
  const nameOf = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);
  const shown = list.filter((s) => {
    if (projectFilter !== "all" && s.project_id !== projectFilter) return false;
    const text = `${s.title ?? ""} ${s.summary ?? ""}`.toLowerCase();
    return !q.trim() || text.includes(q.trim().toLowerCase());
  });

  if (open)
    return (
      <MeetingDetail
        id={open}
        projects={projects}
        onBack={() => onOpen(null)}
        onDeleted={() => {
          onOpen(null);
          reload();
        }}
      />
    );

  return (
    <div className="space-y-4">
      <PaneHeader
        title="Meetings"
        description="Every meeting the copilot listened to, with its summary, cards and full transcript. Kept on this computer."
      />
      {list.length > 0 && (
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search
              size={13}
              className="absolute start-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search titles and summaries"
              className="h-8 ps-8"
            />
          </div>
          {projects.length > 0 && (
            <select
              value={String(projectFilter)}
              onChange={(e) =>
                setProjectFilter(e.target.value === "all" ? "all" : Number(e.target.value))
              }
              className="h-8 rounded-md border border-border/70 bg-input px-2 text-xs text-foreground [color-scheme:light] dark:border-white/10 dark:bg-[#1a1d26] dark:text-slate-200 dark:[color-scheme:dark]"
            >
              <option
                value="all"
                className="bg-background text-foreground dark:bg-[#1a1d26] dark:text-slate-200"
              >
                All projects
              </option>
              {projects.map((p) => (
                <option
                  key={p.id}
                  value={p.id}
                  className="bg-background text-foreground dark:bg-[#1a1d26] dark:text-slate-200"
                >
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      {total > list.length && (
        <p className="text-[11px] text-muted-foreground">
          Showing the newest {list.length} of {total} meetings.
        </p>
      )}
      {shown.length ? (
        <div className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70 bg-card/50 dark:divide-border-subtle/50 dark:border-border-subtle dark:bg-surface-2/50">
          {shown.map((s) => (
            <MeetingRow key={s.id} s={s} project={nameOf.get(s.project_id ?? -1)} onOpen={onOpen} />
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center rounded-2xl border border-dashed border-border/80 px-6 py-12 text-center dark:border-white/10">
          <MessageSquareText size={20} className="mb-2 text-foreground/50" />
          <p className="text-sm text-foreground">
            {list.length ? "No matches" : "No meetings yet"}
          </p>
          {!list.length && (
            <p className="mt-1 max-w-sm text-xs text-muted-foreground">
              Start a note recording during a call. The copilot listens and keeps everything here.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function MeetingRow({
  s,
  project,
  onOpen,
}: {
  s: PastSession;
  project?: string;
  onOpen: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(s.id)}
      className="flex w-full items-start gap-3 px-4 py-3 text-start transition-colors hover:bg-foreground/3 dark:hover:bg-white/3"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-xs font-medium text-foreground">
            {s.title || "Meeting"}
          </span>
          {project && (
            <span className="shrink-0 rounded-full bg-primary/8 px-2 py-px text-[10.5px] text-primary dark:bg-primary/10">
              {project}
            </span>
          )}
        </div>
        {s.summary && (
          <p className="mt-0.5 line-clamp-1 text-[11.5px] text-muted-foreground">{s.summary}</p>
        )}
      </div>
      <div className="shrink-0 text-end text-[11px] tabular-nums text-muted-foreground">
        <div>{when(s.started_at)}</div>
        <div className="text-muted-foreground/70">
          {[duration(s.started_at, s.ended_at), `${s.cards} card${s.cards === 1 ? "" : "s"}`]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </div>
    </button>
  );
}
