import { useCallback, useEffect, useRef, useState } from "react";
import {
  CloudUpload,
  FileAudio,
  FileText,
  Folder,
  FileSearch,
  Loader2,
  Plus,
  RotateCcw,
  Trash2,
  Video,
  X,
} from "../icons";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Toggle } from "../ui/toggle";
import { ConfirmDialog } from "../ui/dialog";
import { cn } from "../lib/utils";
import { BlurField, useCopilotSettings } from "./CopilotFields";
import { PaneHeader, Block } from "./CopilotPane";
import { WORKING } from "./copilotFormat";
import type { Project, ProjectFile, RuleKind } from "./copilotApi";

const RULE_LABELS: Record<RuleKind, string> = {
  title: "Title contains",
  domain: "Organizer domain",
  meet_url: "Meeting link",
};
const RULE_HINTS: Record<RuleKind, string> = {
  title: "Acme weekly",
  domain: "acme.com",
  meet_url: "meet.google.com/abc-defg-hij",
};

const sizeLabel = (b: number | null) =>
  b == null
    ? ""
    : b > 1048576
      ? `${(b / 1048576).toFixed(1)} MB`
      : `${Math.max(1, Math.round(b / 1024))} KB`;

const KIND_ICON: Record<string, typeof FileText> = {
  audio: FileAudio,
  video: Video,
  image: FileSearch,
};

function StatusChip({ f }: { f: ProjectFile }) {
  if (WORKING.has(f.status))
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
        <Loader2 size={11} className="animate-spin" />
        {f.stage ?? "Queued"}
      </span>
    );
  if (f.status === "error")
    return (
      <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] text-destructive">
        Failed
      </span>
    );
  return (
    <span className="rounded-full bg-success/10 px-2 py-0.5 text-[11px] text-success">Ready</span>
  );
}

// One file and how far the copilot got with it.
function FileRow({ f, run }: { f: ProjectFile; run: (p: Promise<unknown>) => void }) {
  const api = window.copilot!.projects;
  const Icon = KIND_ICON[f.kind ?? ""] ?? FileText;
  const detail =
    f.status === "error" ? f.error : f.status === "ready" ? f.summary : (f.note ?? null);
  return (
    <div className="group flex items-start gap-3 px-3 py-2.5">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-foreground/5 text-foreground/60 dark:bg-white/5">
        <Icon size={14} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-xs font-medium text-foreground" title={f.path}>
            {f.name}
          </span>
          <StatusChip f={f} />
        </div>
        <p
          className={cn(
            "mt-0.5 line-clamp-2 text-[11.5px] leading-relaxed",
            f.status === "error" ? "text-destructive/90" : "text-muted-foreground"
          )}
          title={detail ?? undefined}
        >
          {[sizeLabel(f.bytes), f.status === "ready" && `${f.chunks} passages`, detail]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {f.note && f.status === "ready" && (
          <p className="mt-0.5 text-[11px] text-warning">{f.note}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
        {(f.status === "error" || f.status === "ready") && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="Read again"
            onClick={() => run(api.reindex(f.id))}
          >
            <RotateCcw size={13} />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title="Remove file"
          onClick={() => run(api.removeFile(f.id))}
        >
          <X size={14} />
        </Button>
      </div>
    </div>
  );
}

function Files({ p, run }: { p: Project; run: (x: Promise<unknown>) => void }) {
  const api = window.copilot!.projects;
  const { settings, update } = useCopilotSettings();
  const [over, setOver] = useState(false);
  const ready = p.files.filter((f) => f.status === "ready").length;
  const failed = p.files.filter((f) => f.status === "error").length;
  return (
    <Block
      title="Files"
      description={
        p.files.length
          ? `${ready} of ${p.files.length} ready${failed ? ` · ${failed} failed` : ""}. Searched when a moment in the meeting needs them.`
          : "Proposals, price lists, specs, decks, recordings. Read once in the background, then searched live."
      }
    >
      {settings && !settings.ragEnabled && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-foreground/85">
          File search in meetings is off.
          <Button size="sm" variant="outline" onClick={() => update({ ragEnabled: true })}>
            Turn on
          </Button>
        </div>
      )}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (e.dataTransfer.files.length && api.addDropped)
            run(api.addDropped(p.id, Array.from(e.dataTransfer.files)));
        }}
        className={cn(
          "overflow-hidden rounded-lg border transition-colors",
          over
            ? "border-primary/60 bg-primary/5"
            : "border-border/70 bg-card/50 dark:border-border-subtle dark:bg-surface-2/50"
        )}
      >
        {p.files.length > 0 && (
          <div className="divide-y divide-border/60 dark:divide-border-subtle/50">
            {p.files.map((f) => (
              <FileRow key={f.id} f={f} run={run} />
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() => run(api.addFiles(p.id))}
          className={cn(
            "flex w-full items-center justify-center gap-2 px-3 text-xs text-muted-foreground transition-colors hover:bg-foreground/3 hover:text-foreground dark:hover:bg-white/3",
            p.files.length
              ? "border-t border-border/60 py-2.5 dark:border-border-subtle/50"
              : "py-8"
          )}
        >
          <CloudUpload size={p.files.length ? 14 : 18} />
          {over ? "Drop to add" : "Drop files here or browse"}
          {!p.files.length && (
            <span className="text-muted-foreground/60">
              · PDF, Office, text, images, audio, video
            </span>
          )}
        </button>
      </div>
    </Block>
  );
}

function Rules({ p, run }: { p: Project; run: (x: Promise<unknown>) => void }) {
  const api = window.copilot!.projects;
  const [kind, setKind] = useState<RuleKind>("title");
  const [pattern, setPattern] = useState("");
  const add = () => {
    if (!pattern.trim()) return;
    run(api.addRule(p.id, kind, pattern.trim()));
    setPattern("");
  };
  return (
    <Block
      title="Auto-pick for meetings"
      description="When a calendar meeting matches one of these, this project is used. Picking a project in the live window can also remember its meeting."
    >
      {p.rules.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {p.rules.map((r) => (
            <span
              key={r.id}
              className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-card/60 py-0.5 ps-2.5 pe-1 text-[11.5px] dark:border-white/10"
            >
              <span className="text-muted-foreground">{RULE_LABELS[r.kind]}</span>
              <span className="font-medium text-foreground">{r.pattern}</span>
              <button
                type="button"
                title="Remove rule"
                onClick={() => run(api.removeRule(r.id))}
                className="rounded-full p-0.5 text-muted-foreground hover:bg-foreground/8 hover:text-foreground"
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as RuleKind)}
          className="h-8 rounded-md border border-border/70 bg-input px-2 text-xs text-foreground dark:border-white/10"
        >
          {Object.entries(RULE_LABELS).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        <Input
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder={`e.g. ${RULE_HINTS[kind]}`}
          className="h-8 flex-1"
        />
        <Button variant="outline" size="sm" disabled={!pattern.trim()} onClick={add}>
          Add
        </Button>
      </div>
    </Block>
  );
}

function ProjectDetail({ p, reload }: { p: Project; reload: () => void }) {
  const api = window.copilot!.projects;
  const run = (f: Promise<unknown>) => void f.then(reload);
  const [confirm, setConfirm] = useState(false);
  const [name, setName] = useState(p.name);
  const [seen, setSeen] = useState(p.name);
  if (p.name !== seen) {
    setSeen(p.name);
    setName(p.name);
  }
  return (
    <div className="space-y-6">
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Delete "${p.name}"?`}
        description="Its files, context and rules are removed from the copilot. Your files on disk are not touched."
        confirmText="Delete"
        variant="destructive"
        onConfirm={() => run(api.remove(p.id))}
      />
      <div className="flex items-center gap-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== p.name && run(api.rename(p.id, name.trim()))}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          className="min-w-0 flex-1 rounded-md bg-transparent px-1 py-0.5 text-base text-foreground outline-none hover:bg-foreground/4 focus:bg-foreground/4 dark:hover:bg-white/4"
        />
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Use in meetings
          <Toggle checked={p.active} onChange={(on) => run(api.setActive(p.id, on))} />
        </label>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-destructive"
          title="Delete project"
          onClick={() => setConfirm(true)}
        >
          <Trash2 size={14} />
        </Button>
      </div>

      <Files p={p} run={run} />

      <Block
        title="Context"
        description="Always given to the copilot in this project's meetings, on top of the global instructions."
      >
        <BlurField
          label="Briefing"
          rows={5}
          value={p.plan}
          placeholder="Goals for these calls, prices and limits, who is who on their side…"
          onSave={(plan) => run(api.update(p.id, { plan }))}
        />
        <BlurField
          label="How to talk"
          rows={3}
          value={p.instructions}
          placeholder="e.g. Keep it short. Never promise dates. Push the annual plan."
          onSave={(instructions) => run(api.update(p.id, { instructions }))}
        />
      </Block>

      <Rules p={p} run={run} />
    </div>
  );
}

export default function CopilotProjects({
  list,
  reload,
  selected,
  onSelect,
}: {
  list: Project[];
  reload: () => void;
  selected: number | null;
  onSelect: (id: number | null) => void;
}) {
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const p = list.find((x) => x.id === selected) ?? list[0] ?? null;

  const create = useCallback(async () => {
    if (!name.trim()) return;
    const id = await window.copilot!.projects.create(name.trim());
    setName("");
    setAdding(false);
    reload();
    onSelect(id);
  }, [name, reload, onSelect]);
  useEffect(() => {
    if (adding) input.current?.focus();
  }, [adding]);

  const newInput = (
    <div className="flex gap-2">
      <Input
        ref={input}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void create();
          if (e.key === "Escape") setAdding(false);
        }}
        placeholder="Project name, e.g. Acme deal"
        className="h-8"
      />
      <Button size="sm" disabled={!name.trim()} onClick={() => void create()}>
        Create
      </Button>
    </div>
  );

  if (!list.length)
    return (
      <div className="space-y-4">
        <PaneHeader
          title="Projects"
          description="A project holds what the copilot should know for one client or kind of call: files, a briefing, and when to use it."
        />
        <div className="flex flex-col items-center rounded-2xl border border-dashed border-border/80 px-6 py-12 text-center dark:border-white/10">
          <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-foreground/5 dark:bg-white/5">
            <Folder size={20} className="text-foreground/60" />
          </div>
          <p className="text-sm text-foreground">No projects yet</p>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            Without one, the copilot still helps with the conversation, just without your material.
          </p>
          <div className="mt-5 w-full max-w-sm">{newInput}</div>
        </div>
      </div>
    );

  return (
    <div className="space-y-4">
      <PaneHeader
        title="Projects"
        description="Files, briefing and calendar rules for each client or kind of call."
        actions={
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus size={14} className="me-1" /> New project
          </Button>
        }
      />
      {adding && newInput}
      <div className="flex flex-wrap gap-1.5">
        {list.map((x) => {
          const working = x.files.some((f) => WORKING.has(f.status));
          const on = x.id === p?.id;
          return (
            <button
              key={x.id}
              type="button"
              onClick={() => onSelect(x.id)}
              className={cn(
                "inline-flex h-8 items-center gap-2 rounded-full border px-3 text-xs transition-colors",
                on
                  ? "border-primary/40 bg-primary/8 text-foreground dark:bg-primary/10"
                  : "border-border/70 text-foreground/80 hover:bg-foreground/4 dark:border-white/10 dark:hover:bg-white/4"
              )}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  x.active ? "bg-success" : "bg-muted-foreground/40"
                )}
                title={x.active ? "Used in meetings" : "Off"}
              />
              {x.name}
              {working ? (
                <Loader2 size={11} className="animate-spin text-primary" />
              ) : (
                <span className="tabular-nums text-muted-foreground">{x.files.length}</span>
              )}
            </button>
          );
        })}
      </div>
      {p && (
        <div className="border-t border-border/60 pt-5 dark:border-white/8">
          <ProjectDetail key={p.id} p={p} reload={reload} />
        </div>
      )}
    </div>
  );
}
