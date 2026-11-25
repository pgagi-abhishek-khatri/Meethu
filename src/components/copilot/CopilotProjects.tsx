import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CloudUpload,
  Download,
  Eye,
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
import { WORKING, runThenReload } from "./copilotFormat";
import { useToast } from "../ui/useToast";
import type {
  FileReferenceTarget,
  Project,
  ProjectFile,
  ProjectFilePreview,
  RuleKind,
} from "./copilotApi";

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

function FilePreviewModal({
  preview,
  onClose,
  onDownload,
}: {
  preview: {
    fileId: number;
    data: ProjectFilePreview;
    page?: number | null;
    snippet?: string | null;
  } | null;
  onClose: () => void;
  onDownload: (fileId: number) => void;
}) {
  const highlightRef = useRef<HTMLSpanElement | null>(null);
  const objectUrl = useMemo(() => {
    const base64 = preview?.data.dataBase64;
    if (!base64) return null;
    const raw = atob(base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const blob = new Blob([bytes], { type: preview.data.mime || "application/octet-stream" });
    return URL.createObjectURL(blob);
  }, [preview]);

  useEffect(() => {
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [objectUrl]);

  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview, onClose]);

  useEffect(() => {
    if (preview?.data.kind === "text" && preview.snippet && highlightRef.current) {
      highlightRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [preview]);

  if (!preview) return null;
  const { fileId, data, page, snippet } = preview;
  const pdfUrl =
    objectUrl && data.kind === "pdf"
      ? `${objectUrl}${page != null && page > 0 ? `#page=${page}` : ""}`
      : objectUrl;

  const renderHighlightedText = (text: string) => {
    if (!snippet) return text || "Empty document.";
    const needle = snippet.trim().slice(0, 60);
    if (!needle) return text;
    const idx = text.toLowerCase().indexOf(needle.toLowerCase());
    if (idx === -1) return text;
    return (
      <>
        {text.slice(0, idx)}
        <span
          ref={highlightRef}
          className="rounded bg-amber-400/25 px-0.5 text-amber-100 ring-1 ring-amber-400/40"
        >
          {text.slice(idx, idx + needle.length)}
        </span>
        {text.slice(idx + needle.length)}
      </>
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs"
      onClick={onClose}
    >
      <div
        className="flex h-[90vh] w-[92vw] max-w-6xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl dark:border-white/15 dark:bg-[#141720]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-2.5 dark:border-white/10">
          <div className="flex min-w-0 items-center gap-2">
            <FileText size={15} className="shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-medium text-foreground">{data.name}</span>
            {page != null && page > 0 && (
              <span className="shrink-0 rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-medium text-sky-300">
                Page {page}
              </span>
            )}
            {data.truncated && (
              <span className="shrink-0 rounded-full bg-warning/15 px-2 py-0.5 text-[10px] text-warning">
                Preview truncated
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 px-2.5 text-xs"
              onClick={() => onDownload(fileId)}
            >
              <Download size={13} />
              Download
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              title="Close preview"
              onClick={onClose}
            >
              <X size={14} />
            </Button>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-auto p-4">
          {data.kind === "text" && (
            <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground/90">
              {renderHighlightedText(data.text || "Empty document.")}
            </pre>
          )}
          {data.kind === "image" && objectUrl && (
            <div className="flex flex-1 items-center justify-center">
              <img
                src={objectUrl}
                alt={data.name || "Preview"}
                className="max-h-full rounded-lg object-contain"
              />
            </div>
          )}
          {data.kind === "pdf" && pdfUrl && (
            <iframe
              src={pdfUrl}
              title={data.name || "PDF Preview"}
              className="min-h-[75vh] w-full flex-1 rounded-lg border border-border/50 bg-white"
            />
          )}
          {data.kind === "audio" && objectUrl && (
            <div className="flex flex-1 items-center justify-center py-10">
              <audio controls src={objectUrl} className="w-full max-w-md" />
            </div>
          )}
          {data.kind === "video" && objectUrl && (
            <div className="flex flex-1 items-center justify-center">
              <video controls src={objectUrl} className="max-h-full w-full rounded-lg" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// One file and how far the copilot got with it.
function FileRow({
  f,
  run,
  onPreview,
  onDownload,
  previewLoading,
  downloadLoading,
}: {
  f: ProjectFile;
  run: (p: Promise<unknown>) => void;
  onPreview: (fileId: number) => void;
  onDownload: (fileId: number) => void;
  previewLoading: boolean;
  downloadLoading: boolean;
}) {
  const api = window.copilot!.projects;
  const Icon = KIND_ICON[f.kind ?? ""] ?? FileText;
  const [expanded, setExpanded] = useState(false);
  const detail =
    f.status === "error" ? f.error : f.status === "ready" ? f.summary : (f.note ?? null);
  const meta = [sizeLabel(f.bytes), f.status === "ready" && `${f.chunks} passages`]
    .filter(Boolean)
    .join(" · ");
  const hasLongDetail = Boolean(detail && (detail.length > 150 || detail.includes("\n")));
  const collapsedDetail = useMemo(() => {
    if (!detail || !hasLongDetail) return detail;
    const flat = detail.replace(/\s+/g, " ").trim();
    if (flat.length <= 150) return flat;
    const cut = flat.slice(0, 150);
    const lastSpace = cut.lastIndexOf(" ");
    return (lastSpace > 100 ? cut.slice(0, lastSpace) : cut).trimEnd();
  }, [detail, hasLongDetail]);

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
        {meta && <p className="mt-0.5 text-[11px] text-muted-foreground/80">{meta}</p>}
        {detail && (
          <p
            className={cn(
              "mt-0.5 text-[11.5px] leading-relaxed",
              f.status === "error" ? "text-destructive/90" : "text-muted-foreground"
            )}
          >
            {expanded || !hasLongDetail ? detail : `${collapsedDetail}…`}
            {hasLongDetail && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="ms-1.5 inline font-medium text-primary hover:underline"
              >
                {expanded ? "less" : "more"}
              </button>
            )}
          </p>
        )}
        {f.note && f.status === "ready" && (
          <p className="mt-0.5 text-[11px] text-warning">{f.note}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-70 transition-opacity group-hover:opacity-100">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title="Preview file"
          disabled={previewLoading}
          onClick={() => onPreview(f.id)}
        >
          {previewLoading ? <Loader2 size={13} className="animate-spin" /> : <Eye size={13} />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title="Download file"
          disabled={downloadLoading}
          onClick={() => onDownload(f.id)}
        >
          {downloadLoading ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Download size={13} />
          )}
        </Button>
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

function Files({
  p,
  run,
  pendingRef,
  onClearPendingRef,
}: {
  p: Project;
  run: (x: Promise<unknown>) => void;
  pendingRef?: FileReferenceTarget | null;
  onClearPendingRef?: () => void;
}) {
  const api = window.copilot!.projects;
  const { settings, update } = useCopilotSettings();
  const { toast } = useToast();
  const [over, setOver] = useState(false);
  const [preview, setPreview] = useState<{
    fileId: number;
    data: ProjectFilePreview;
    page?: number | null;
    snippet?: string | null;
  } | null>(null);
  const [loadingPreviewId, setLoadingPreviewId] = useState<number | null>(null);
  const [loadingDownloadId, setLoadingDownloadId] = useState<number | null>(null);
  const ready = p.files.filter((f) => f.status === "ready").length;
  const failed = p.files.filter((f) => f.status === "error").length;

  const handlePreview = useCallback(
    async (fileId: number, target?: { page?: number | null; snippet?: string | null }) => {
      if (!api.previewFile) return;
      setLoadingPreviewId(fileId);
      try {
        const res = await api.previewFile(fileId);
        if (!res.ok) {
          toast({
            title: "Preview unavailable",
            description: res.error || "Could not preview this file.",
            variant: "destructive",
          });
        } else {
          setPreview({
            fileId,
            data: res,
            page: target?.page ?? null,
            snippet: target?.snippet ?? null,
          });
        }
      } catch (error) {
        toast({
          title: "Preview failed",
          description: error instanceof Error ? error.message : String(error),
          variant: "destructive",
        });
      } finally {
        setLoadingPreviewId(null);
      }
    },
    [api, toast]
  );

  useEffect(() => {
    if (!pendingRef) return;
    const targetFile =
      (pendingRef.fileId != null ? p.files.find((f) => f.id === pendingRef.fileId) : undefined) ||
      p.files.find((f) => f.name === pendingRef.name);
    if (!targetFile) return;
    onClearPendingRef?.();
    void handlePreview(targetFile.id, {
      page: pendingRef.page ?? null,
      snippet: pendingRef.snippet ?? null,
    });
  }, [pendingRef, p.files, onClearPendingRef, handlePreview]);

  const handleDownload = async (fileId: number) => {
    if (!api.downloadFile) return;
    setLoadingDownloadId(fileId);
    try {
      const res = await api.downloadFile(fileId);
      if (!res.ok && !res.canceled) {
        toast({
          title: "Download failed",
          description: res.error || "Could not save this file.",
          variant: "destructive",
        });
      } else if (res.ok) {
        toast({
          title: "File saved",
          description: res.path ? `Saved to ${res.path}` : "Download complete.",
        });
      }
    } catch (error) {
      toast({
        title: "Download failed",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    } finally {
      setLoadingDownloadId(null);
    }
  };

  return (
    <Block
      title="Files"
      description={
        p.files.length
          ? `${ready} of ${p.files.length} ready${failed ? ` · ${failed} failed` : ""}. Searched when a moment in the meeting needs them.`
          : "Proposals, price lists, specs, decks, recordings. Read once in the background, then searched live."
      }
    >
      <FilePreviewModal
        preview={preview}
        onClose={() => setPreview(null)}
        onDownload={(fileId) => void handleDownload(fileId)}
      />
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
              <FileRow
                key={f.id}
                f={f}
                run={run}
                onPreview={(id) => void handlePreview(id)}
                onDownload={(id) => void handleDownload(id)}
                previewLoading={loadingPreviewId === f.id}
                downloadLoading={loadingDownloadId === f.id}
              />
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
          className="h-8 rounded-md border border-border/70 bg-input px-2 text-xs text-foreground [color-scheme:light] dark:border-white/10 dark:bg-[#1a1d26] dark:text-slate-200 dark:[color-scheme:dark]"
        >
          {Object.entries(RULE_LABELS).map(([k, l]) => (
            <option
              key={k}
              value={k}
              className="bg-background text-foreground dark:bg-[#1a1d26] dark:text-slate-200"
            >
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

function ProjectDetail({
  p,
  reload,
  pendingRef,
  onClearPendingRef,
}: {
  p: Project;
  reload: () => void;
  pendingRef?: FileReferenceTarget | null;
  onClearPendingRef?: () => void;
}) {
  const api = window.copilot!.projects;
  const { toast } = useToast();
  const run = (f: Promise<unknown>) =>
    void runThenReload(f, reload, (error) =>
      toast({
        title: "That did not work",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      })
    );
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

      <Files p={p} run={run} pendingRef={pendingRef} onClearPendingRef={onClearPendingRef} />

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
  pendingRef,
  onClearPendingRef,
}: {
  list: Project[];
  reload: () => void;
  selected: number | null;
  onSelect: (id: number | null) => void;
  pendingRef?: FileReferenceTarget | null;
  onClearPendingRef?: () => void;
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
          <ProjectDetail
            key={p.id}
            p={p}
            reload={reload}
            pendingRef={pendingRef}
            onClearPendingRef={onClearPendingRef}
          />
        </div>
      )}
    </div>
  );
}
