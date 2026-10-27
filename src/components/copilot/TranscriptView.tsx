import { useEffect, useRef, useState } from "react";
import { ArrowRight, X } from "../icons";
import type { Segment } from "./copilotState";

const colorOf = (label: string) =>
  label === "USER"
    ? "text-emerald-300"
    : label.startsWith("NEARBY")
      ? "text-amber-300"
      : "text-sky-300";

interface Props {
  segments: Segment[];
  partial: { label: string; text: string } | null;
  onAsk: (quote: string) => void; // the picked lines go to the composer as a quote
}

export default function TranscriptView({ segments, partial, onAsk }: Props) {
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [stuck, setStuck] = useState(true); // follow the live end unless the user scrolled up
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (stuck && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [segments.length, partial?.text, stuck]);

  const toggle = (id: number) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const quote = segments
    .filter((s) => picked.has(s.id))
    .map((s) => `${s.label}: ${s.text}`)
    .join(" ");

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          setStuck(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
        }}
        className="flex-1 space-y-1 overflow-y-auto p-3 text-[13px]"
      >
        {!segments.length && (
          <p className="pt-10 text-center text-slate-500">The live transcript appears here.</p>
        )}
        {segments.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => toggle(s.id)}
            className={`block w-full rounded-md px-2 py-1 text-start leading-snug hover:bg-white/[0.06] ${picked.has(s.id) ? "bg-emerald-500/15 ring-1 ring-emerald-400/40" : ""}`}
          >
            <span className={`me-1.5 text-[11px] font-semibold ${colorOf(s.label)}`}>
              {s.label}
            </span>
            <span className="break-words text-slate-200">{s.text}</span>
          </button>
        ))}
        {partial && (
          <p className="px-2 py-1 text-slate-500">
            <span className="me-1.5 text-[11px] font-semibold">{partial.label}</span>
            {partial.text}
          </p>
        )}
      </div>
      {!stuck && (
        <button
          type="button"
          onClick={() => setStuck(true)}
          className="absolute bottom-3 end-3 rounded-full bg-slate-700/90 px-3 py-1 text-[11px] text-slate-100 shadow"
        >
          Jump to latest
        </button>
      )}
      {picked.size > 0 && (
        <div className="flex items-center gap-2 border-t border-white/10 bg-emerald-500/10 px-3 py-1.5 text-[12px] text-emerald-100">
          <span className="flex-1">
            {picked.size} line{picked.size > 1 ? "s" : ""} selected
          </span>
          <button
            type="button"
            onClick={() => {
              onAsk(quote);
              setPicked(new Set());
            }}
            className="flex items-center gap-1 rounded-md bg-emerald-500/25 px-2 py-0.5 hover:bg-emerald-500/40"
          >
            Ask about this <ArrowRight size={12} />
          </button>
          <button type="button" title="Clear" onClick={() => setPicked(new Set())}>
            <X size={13} />
          </button>
        </div>
      )}
    </div>
  );
}
