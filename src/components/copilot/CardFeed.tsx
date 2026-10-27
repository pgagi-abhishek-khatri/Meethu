import { useEffect, useLayoutEffect, useRef } from "react";
import type { Card as CardData } from "./copilotState";
import Card from "./Card";

interface Props {
  cards: CardData[]; // oldest first: the newest is at the bottom, like a chat
  emptyText: string;
  onAsk: (text: string, card: CardData) => void;
  onDeeper: (card: CardData) => void;
  onFeedback: (card: CardData, value: "down" | null) => void;
}

export default function CardFeed({ cards, emptyText, onAsk, onDeeper, onFeedback }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // follow the newest, unless the user scrolled up to read
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const on = () => (stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80);
    el.addEventListener("scroll", on, { passive: true });
    return () => el.removeEventListener("scroll", on);
  }, []);
  // body text streams in, so the height changes on every update, not only when a card is added
  const sig = cards.map((c) => `${c.id}${c.status}${c.body?.length ?? 0}`).join();
  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTo({ top: el.scrollHeight });
  }, [sig]);

  const item = (c: CardData) => (
    <Card
      key={c.id}
      card={c}
      onAsk={(q) => onAsk(q, c)}
      onDeeper={() => onDeeper(c)}
      onFeedback={(v) => onFeedback(c, v)}
    />
  );

  return (
    <div ref={box} className="flex-1 space-y-2 overflow-y-auto p-3">
      {!cards.length && (
        <p className="mx-auto mt-16 max-w-[16rem] text-center text-[13px] text-slate-500">
          {emptyText}
        </p>
      )}
      {cards.map(item)}
    </div>
  );
}
