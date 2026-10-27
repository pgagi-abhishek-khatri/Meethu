import MarkdownRenderer from "../ui/MarkdownRenderer";
import type { Card } from "./copilotState";
import { useLevel } from "./levelStore";

// The small modes of the copilot window. The window is frameless and transparent: the ring drags it, the
// centre is the button (hover = peek at the newest card, click = open the panel).
const NO_DRAG = { WebkitAppRegion: "no-drag" } as const;
const DRAG = { WebkitAppRegion: "drag" } as const;

// Equalizer bars that follow the meeting audio: each bar scales the loudness by its own factor, so they
// move out of step like a music player. Quiet = they rest low; no audio = just the "C".
const BARS = [0.55, 0.9, 1, 0.75, 0.5];

function Listening({ live }: { live: boolean }) {
  const level = useLevel();
  if (!live) return <span className="text-[13px] font-semibold">C</span>;
  return (
    <span className="flex h-5 items-center gap-[2px]">
      {BARS.map((k, i) => (
        <span
          key={i}
          className="w-[3px] rounded-full bg-current"
          style={{
            height: `${3 + Math.round(level * k * 15 * (i % 2 ? 1 : 0.85))}px`,
            transition: "height 90ms ease-out",
          }}
        />
      ))}
    </span>
  );
}

export function Orb({
  busy,
  unseen,
  skipped,
  live,
  onHover,
  onOpen,
}: {
  busy: boolean;
  unseen: number; // finished cards not looked at yet
  skipped: number;
  live: boolean;
  onHover: () => void;
  onOpen: () => void;
}) {
  return (
    <div
      style={DRAG}
      className="flex h-16 w-16 items-center justify-center rounded-full border border-white/15 bg-[#12141a]/95 shadow-lg"
    >
      <button
        type="button"
        style={NO_DRAG}
        title="Open the copilot"
        onMouseEnter={onHover}
        onClick={onOpen}
        className={`relative flex h-9 w-9 items-center justify-center rounded-full ${
          unseen
            ? "animate-pulse bg-emerald-400 text-slate-900"
            : busy
              ? "animate-pulse bg-sky-400/80 text-slate-900"
              : live
                ? "bg-emerald-500/30 text-emerald-100"
                : "bg-white/10 text-slate-300"
        }`}
      >
        <Listening live={live} />
        {(unseen > 0 || skipped > 0) && (
          <span className="absolute -end-1 -top-1 min-w-4 rounded-full bg-rose-500 px-1 text-center text-[9px] font-semibold leading-4 text-white">
            {unseen || skipped}
          </span>
        )}
      </button>
    </div>
  );
}

// The newest card, small, next to the orb. Goes back to the orb by itself (the app decides when).
export function Peek({
  card,
  skipped,
  onOpen,
  onHover,
  onLeave,
  onClose,
}: {
  card: Card | null;
  skipped: number;
  onOpen: () => void;
  onHover: () => void;
  onLeave: () => void;
  onClose: () => void;
}) {
  return (
    <div
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      className="flex h-screen flex-col overflow-hidden rounded-2xl border border-white/15 bg-[#12141a]/95 text-slate-200 shadow-xl"
    >
      <div
        style={DRAG}
        className="flex items-center gap-2 px-3 pt-2 text-[10px] uppercase tracking-wide text-emerald-300/80"
      >
        <span className="flex-1 truncate">{card?.label ?? "Copilot"}</span>
        {skipped > 0 && <span className="text-slate-400">{skipped} skipped</span>}
        <button
          type="button"
          style={NO_DRAG}
          onClick={onClose}
          className="text-slate-500 hover:text-slate-100"
        >
          ×
        </button>
      </div>
      <button
        type="button"
        style={NO_DRAG}
        onClick={onOpen}
        className="min-h-0 flex-1 overflow-hidden px-3 pb-3 text-start"
      >
        {card ? (
          <>
            <h3 className="mb-0.5 text-[13px] font-semibold text-slate-50">{card.title}</h3>
            <div className="copilot-md text-[12px] leading-snug">
              <MarkdownRenderer content={card.body ?? ""} />
            </div>
          </>
        ) : (
          <p className="pt-3 text-[12px] text-slate-500">Nothing new yet. Click to open.</p>
        )}
      </button>
    </div>
  );
}
