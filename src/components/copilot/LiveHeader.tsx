import { useState } from "react";
import { ChevronDown, ChevronUp, Pause, Play, Plus, X } from "../icons";
import type { CopilotState, Skipped } from "./copilotState";

// The AI account refuses every call: say so plainly and point at the fix.
export function ProblemBanner({
  kind,
  onFix,
}: {
  kind: "key" | "credits" | "no_key" | null;
  onFix: () => void;
}) {
  if (!kind) return null;
  return (
    <button
      type="button"
      onClick={onFix}
      className="w-full bg-rose-500/15 px-3 py-2 text-start text-[12px] leading-snug text-rose-200 hover:bg-rose-500/25"
    >
      {kind === "credits"
        ? "The OpenRouter key in use has no credits, so nothing can run. Add credits, or paste a different key in Settings."
        : kind === "no_key"
          ? "No OpenRouter key is set, so the copilot can only show the transcript. Paste a key in Settings."
          : "OpenRouter refused the key, so nothing can run. Paste a working key in Settings."}
    </button>
  );
}

// The tail of what was just said, so long speech "rolls" instead of running off the edge.
const tail = (t: string, n = 90) => (t.length > n ? "…" + t.slice(-n) : t);

// Engine labels (USER, OTHER-2, NEARBY-1) in plain words.
export const speakerName = (label: string) => {
  if (label === "USER") return "You";
  const n = /-(\d+)$/.exec(label)?.[1];
  return n ? `Speaker ${n}` : "Speaker";
};

// Top strip: Listening / Thinking with the last words heard. Tap it to see the meeting memory.
export function LiveStrip({
  state,
  onTogglePause,
  onNewThread,
  onEnd,
}: {
  state: CopilotState;
  onTogglePause?: () => void;
  onNewThread?: () => void;
  onEnd?: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (state.phase !== "live") return null;
  const last = state.partial ?? state.segments.at(-1);
  const who = last?.text ? `${speakerName(last.label)}: ` : "";
  const isPaused = !!state.paused;
  return (
    <div className="border-b border-white/10">
      <div className="flex w-full items-center justify-between gap-2 px-3 py-2 text-[11.5px] text-slate-400">
        <button
          type="button"
          title={state.summary ? "Show what the copilot remembers" : undefined}
          onClick={() => state.summary && setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-2 text-start"
        >
          {isPaused ? (
            <Pause className="h-3 w-3 shrink-0 text-slate-400" />
          ) : (
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${
                state.busy ? "animate-pulse bg-primary" : "bg-emerald-400"
              }`}
            />
          )}
          <span
            className={`shrink-0 font-medium ${isPaused ? "text-slate-300" : "text-slate-200"}`}
          >
            {isPaused ? "Paused" : state.busy ? "Thinking" : "Listening"}
          </span>
          <span className="min-w-0 flex-1 truncate italic text-slate-500">
            {!isPaused && last?.text ? `${who}“${tail(last.text)}”` : ""}
          </span>
          {state.summary && (
            <span className="shrink-0 rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-slate-400">
              memory
            </span>
          )}
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          {onTogglePause && (
            <button
              type="button"
              onClick={onTogglePause}
              title={isPaused ? "Resume proactive listening" : "Pause proactive listening"}
              className={`flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-medium transition-colors ${
                isPaused
                  ? "border-primary/40 bg-primary/15 text-blue-200 hover:bg-primary/25"
                  : "border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/[0.08] hover:text-slate-100"
              }`}
            >
              {isPaused ? (
                <>
                  <Play className="h-2.5 w-2.5" fill="currentColor" />
                  <span>Resume</span>
                </>
              ) : (
                <>
                  <Pause className="h-2.5 w-2.5" fill="currentColor" />
                  <span>Pause</span>
                </>
              )}
            </button>
          )}
          {onEnd && (
            <button
              type="button"
              onClick={onEnd}
              title="End the meeting note"
              className="flex h-7 shrink-0 items-center rounded-md border border-white/10 bg-white/[0.04] px-2.5 text-[11px] font-medium text-slate-300 transition-colors hover:border-destructive/40 hover:bg-destructive/15 hover:text-rose-200"
            >
              End meeting
            </button>
          )}
          {onNewThread && (
            <button
              type="button"
              onClick={onNewThread}
              title="New thread"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/[0.04] text-slate-300 transition-colors hover:bg-white/[0.08] hover:text-slate-100"
            >
              <Plus size={13} />
            </button>
          )}
        </div>
      </div>
      {open && state.summary && (
        <p className="max-h-40 overflow-y-auto whitespace-pre-wrap px-3 pb-2 text-[12px] leading-snug text-slate-400">
          {state.summary}
        </p>
      )}
    </div>
  );
}

// Moments the copilot passed on (not important enough to interrupt, or the model found nothing to add). They stay
// here, newest first, so one tap sends one to the model after all.
export function SkippedBox({
  items,
  onAsk,
  onDismiss,
  onDismissAll,
}: {
  items: Skipped[];
  onAsk: (item: Skipped) => void;
  onDismiss: (item: Skipped) => void;
  onDismissAll?: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  const shown = open ? items : items.slice(0, 1);
  return (
    <div className="mx-3 mb-2 rounded-lg border border-dashed border-emerald-400/40 bg-emerald-400/[0.06]">
      <div className="flex items-center px-2.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-emerald-300/80">
        <span className="flex-1">Skipped for now: tap to ask</span>
        <div className="flex items-center gap-2">
          {onDismissAll && items.length > 0 && (
            <button
              type="button"
              onClick={onDismissAll}
              className="normal-case tracking-normal text-emerald-300/70 hover:text-emerald-200"
            >
              Skip all
            </button>
          )}
          {items.length > 1 && (
            <button
              type="button"
              onClick={() => setOpen(!open)}
              className="flex items-center gap-0.5 normal-case tracking-normal text-emerald-300/70 hover:text-emerald-200"
            >
              <span>{open ? "show less" : `${items.length - 1} more`}</span>
              {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            </button>
          )}
        </div>
      </div>
      <ul className="max-h-40 overflow-y-auto">
        {shown.map((i) => (
          <li key={i.id} className="flex items-center ps-2.5 pe-1 text-[12px] text-slate-300">
            <button
              type="button"
              onClick={() => onAsk(i)}
              title="Ask the copilot about this"
              className="min-w-0 flex-1 py-1.5 text-start leading-snug hover:text-white"
            >
              {i.line}
            </button>
            <button
              type="button"
              title="Dismiss"
              onClick={() => onDismiss(i)}
              className="rounded p-1 text-slate-600 hover:text-slate-200"
            >
              <X size={11} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
