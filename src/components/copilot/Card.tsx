import { useState } from "react";
import { Loader2 } from "../icons";
import MarkdownRenderer from "../ui/MarkdownRenderer";
import type { Card as CardData } from "./copilotState";

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

interface Props {
  card: CardData;
  onAsk: (text: string) => void; // a tapped follow-up question
  onDeeper: () => void; // ask again on the high-effort model and its tools
  onFeedback: (value: "down" | null) => void; // "not helpful" (or undo)
}

export default function Card({ card, onAsk, onDeeper, onFeedback }: Props) {
  const [openSource, setOpenSource] = useState<number | null>(null);
  const working = card.status === "queued" || card.status === "searching";

  return (
    <article
      className={`rounded-xl border border-white/10 bg-white/[0.04] p-3 text-[13px] leading-snug text-slate-200 ${
        card.feedback === "down" ? "opacity-50" : ""
      }`}
    >
      {card.label && (
        <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-300/80">
          {card.label}
        </div>
      )}
      <h3 className="font-semibold text-slate-50">
        {card.title || (working ? card.focus : "")}
        {card.status === "done" && card.confidence === "low" && (
          <span className="ms-2 rounded-full bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-medium text-rose-300">
            Unsure
          </span>
        )}
      </h3>

      {working && (
        <p className="mt-1 flex items-center gap-1.5 text-slate-400">
          <Loader2 size={12} className="animate-spin" />
          {card.status === "queued" ? "Waiting…" : "Working on it…"}
        </p>
      )}
      {card.status === "error" && <p className="mt-1 text-rose-300">{card.error}</p>}
      {card.body && (
        <div className="copilot-md mt-1">
          <MarkdownRenderer content={card.body} />
          {card.status === "streaming" && (
            <Loader2 size={12} className="mt-1 animate-spin text-slate-500" />
          )}
        </div>
      )}
      {card.status === "streaming" && !card.body && (
        <Loader2 size={14} className="mt-2 animate-spin text-slate-500" />
      )}

      {!!card.sources?.length && (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {card.sources.slice(0, 3).map((s, i) => (
            <li key={s.url + i}>
              <button
                type="button"
                title={s.snippet || s.url}
                onClick={() => setOpenSource(openSource === i ? null : i)}
                className="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[11px] text-sky-300 hover:bg-white/10"
              >
                {host(s.url)}
              </button>
            </li>
          ))}
        </ul>
      )}
      {openSource != null && card.sources?.[openSource] && (
        <div className="mt-1.5 rounded-md bg-black/25 p-2 text-[11px] text-slate-400">
          <a
            href={card.sources[openSource].url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sky-300 underline"
          >
            {card.sources[openSource].title || card.sources[openSource].url}
          </a>
        </div>
      )}

      {card.status === "done" && !!card.followups?.length && (
        <div className="mt-2 flex flex-col gap-1">
          {card.followups.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => onAsk(q)}
              className="rounded-lg border border-white/10 px-2 py-1 text-start text-[12px] text-slate-300 hover:border-emerald-400/50 hover:text-emerald-200"
            >
              {q}
            </button>
          ))}
        </div>
      )}
      {card.status === "done" && (
        <div className="mt-2 flex items-center gap-3 text-[11px]">
          {!card.deep && !card.deepened && !card.label && (
            <button
              type="button"
              onClick={onDeeper}
              className="text-slate-500 hover:text-emerald-300"
            >
              Rerun with high effort ›
            </button>
          )}
          <button
            type="button"
            onClick={() => onFeedback(card.feedback === "down" ? null : "down")}
            title="This card was not needed or not relevant: the copilot will make fewer like it"
            className={
              card.feedback === "down" ? "text-rose-300" : "text-slate-500 hover:text-rose-300"
            }
          >
            {card.feedback === "down" ? "Marked not helpful · undo" : "Not helpful"}
          </button>
        </div>
      )}
    </article>
  );
}
