import { useEffect, useRef, useState } from "react";
import { Plus, Send, X } from "../icons";

interface Props {
  placeholder: string;
  target: string; // "Sending to: Main"
  quote: string;
  onClearQuote: () => void;
  onSend: (text: string) => void;
  focusToken?: number; // changes -> focus the box
  disabled?: boolean;
  onNewThread?: () => void; // opens a side thread
}

export default function Composer({
  placeholder,
  target,
  quote,
  onClearQuote,
  onSend,
  focusToken,
  disabled,
  onNewThread,
}: Props) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusToken) ref.current?.focus();
  }, [focusToken]);

  const send = () => {
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t);
    setText("");
  };

  return (
    <div className="border-t border-white/10 bg-black/20 p-2">
      {quote && (
        <div className="mb-1.5 flex items-start gap-1 rounded-md bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-200">
          <span className="line-clamp-2 flex-1">“{quote}”</span>
          <button type="button" title="Remove quote" onClick={onClearQuote}>
            <X size={12} />
          </button>
        </div>
      )}
      <div className="flex items-end gap-1.5 rounded-xl border border-white/10 bg-white/[0.05] px-2 py-1.5 focus-within:border-emerald-400/50">
        {onNewThread && (
          <button
            type="button"
            title="New thread"
            onClick={onNewThread}
            className="rounded p-1 text-slate-500 hover:bg-white/10 hover:text-slate-200"
          >
            <Plus size={15} />
          </button>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          className="max-h-28 min-h-[22px] flex-1 resize-none bg-transparent text-[13px] text-slate-100 outline-none placeholder:text-slate-500"
        />
        <button
          type="button"
          title="Send"
          onClick={send}
          disabled={!text.trim() || disabled}
          className="rounded p-1 text-emerald-300 hover:bg-white/10 disabled:text-slate-600"
        >
          <Send size={15} />
        </button>
      </div>
      {target && <div className="mt-1 px-1 text-[10px] text-slate-500">{target}</div>}
    </div>
  );
}
