import { useEffect, useRef, useState } from "react";
import { Send, X, AlertTriangle, Upload, Mic, FileText } from "../icons";
import { validateUserInput } from "../../copilot/core/validation/inputValidation";
import { readAttachedFile, formatFileSize, type AttachedDocument } from "./documentReader";
import { useAudioInput } from "./useAudioInput";

interface Props {
  placeholder: string;
  target: string; // "Sending to: Main"
  quote: string;
  onClearQuote: () => void;
  onSend: (text: string, attachment?: AttachedDocument | null) => void;
  focusToken?: number; // changes -> focus the box
  disabled?: boolean;
}

export default function Composer({
  placeholder,
  target,
  quote,
  onClearQuote,
  onSend,
  focusToken,
  disabled,
}: Props) {
  const [text, setText] = useState("");
  const [warning, setWarning] = useState<string | null>(null);
  const [attachment, setAttachment] = useState<AttachedDocument | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusToken) ref.current?.focus();
  }, [focusToken]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 112)}px`;
  }, [text]);

  const {
    isRecording,
    isTranscribing,
    isSupported: isAudioSupported,
    durationSeconds,
    toggle: toggleAudio,
    stop: stopAudio,
    cancel: cancelAudio,
  } = useAudioInput({
    onTranscript: (spokenText) => {
      setText((prev) => {
        const trimmedPrev = prev.trim();
        return trimmedPrev ? `${trimmedPrev} ${spokenText}` : spokenText;
      });
      setWarning(null);
    },
    onError: (err) => {
      setWarning(err);
    },
  });

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const doc = await readAttachedFile(file);
      setAttachment(doc);
      if (warning) setWarning(null);
    } catch (err: any) {
      setWarning("Failed to read file: " + (err?.message || "unknown error"));
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const formatDuration = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const send = () => {
    if (isRecording) {
      stopAudio();
    }
    const t = text.trim();
    if (!t || disabled) return;
    const res = validateUserInput(t);
    if (!res.valid) {
      setWarning(res.message || "Please enter a valid question or complete sentence.");
      return;
    }
    setWarning(null);
    onSend(res.formattedText || t, attachment);
    setText("");
    setAttachment(null);
  };

  return (
    <div className="border-t border-white/10 bg-black/20 px-3 py-2.5">
      <input
        ref={fileInputRef}
        type="file"
        accept=".txt,.md,.pdf,.docx,.json,.csv,.ts,.js,.py,.log"
        onChange={handleFileSelect}
        className="hidden"
      />
      {quote && (
        <div className="mb-2 flex items-start gap-1.5 rounded-lg bg-emerald-500/10 px-2.5 py-1.5 text-[11px] text-emerald-200">
          <span className="line-clamp-2 flex-1">“{quote}”</span>
          <button
            type="button"
            title="Remove quote"
            onClick={onClearQuote}
            className="rounded p-0.5 text-emerald-300/70 hover:bg-white/10 hover:text-emerald-100"
          >
            <X size={12} />
          </button>
        </div>
      )}
      {attachment && (
        <div className="mb-2 flex items-center justify-between rounded-lg border border-sky-400/25 bg-sky-500/10 px-2.5 py-1.5 text-[11px] text-sky-200">
          <div className="flex min-w-0 items-center gap-1.5">
            <FileText size={13} className="shrink-0 text-sky-300" />
            <span className="truncate font-medium">{attachment.name}</span>
            <span className="shrink-0 text-[10px] text-sky-300/70">
              ({formatFileSize(attachment.size)})
            </span>
          </div>
          <button
            type="button"
            title="Remove attachment"
            onClick={() => setAttachment(null)}
            className="rounded p-0.5 text-sky-300/70 hover:bg-white/10 hover:text-sky-100"
          >
            <X size={12} />
          </button>
        </div>
      )}
      {isTranscribing && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-sky-400/30 bg-sky-500/15 px-2.5 py-1.5 text-[11px] text-sky-200">
          <span className="h-2 w-2 shrink-0 rounded-full bg-sky-400 animate-pulse" />
          <span>Transcribing voice…</span>
        </div>
      )}
      {isRecording && (
        <div className="mb-2 flex items-center justify-between rounded-lg border border-rose-400/30 bg-rose-500/15 px-2.5 py-1.5 text-[11px] text-rose-200">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full bg-rose-400 animate-ping" />
            <span>Listening… {formatDuration(durationSeconds)}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={stopAudio}
              className="rounded border border-rose-400/30 bg-rose-500/20 px-2 py-0.5 text-[10px] font-medium text-rose-100 hover:bg-rose-500/30"
              title="Finish recording"
            >
              Done
            </button>
            <button
              type="button"
              onClick={cancelAudio}
              className="rounded p-0.5 text-rose-300/70 hover:bg-white/10 hover:text-rose-100"
              title="Cancel recording"
            >
              <X size={12} />
            </button>
          </div>
        </div>
      )}
      {warning && (
        <div
          role="alert"
          className="mb-2 flex items-center justify-between gap-1.5 rounded-lg border border-amber-400/30 bg-amber-500/15 px-2.5 py-1.5 text-[11px] text-amber-200"
        >
          <div className="flex min-w-0 items-center gap-1.5">
            <AlertTriangle size={13} className="shrink-0 text-amber-300" />
            <span className="truncate">{warning}</span>
          </div>
          <button
            type="button"
            title="Dismiss warning"
            onClick={() => setWarning(null)}
            className="shrink-0 rounded p-0.5 text-amber-300/70 hover:bg-white/10 hover:text-amber-100"
          >
            <X size={12} />
          </button>
        </div>
      )}
      <div
        className={`flex items-end gap-1.5 rounded-xl border px-2 py-1.5 transition-colors ${
          warning
            ? "border-amber-400/50 bg-amber-500/5 ring-1 ring-amber-400/30"
            : "border-white/10 bg-white/[0.05] focus-within:border-emerald-400/50"
        }`}
      >
        <button
          type="button"
          title={attachment ? `Attached: ${attachment.name}` : "Attach document"}
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors ${
            attachment
              ? "bg-sky-500/20 text-sky-300 hover:bg-sky-500/30"
              : "text-slate-400 hover:bg-white/10 hover:text-slate-200"
          }`}
        >
          <Upload size={14} />
        </button>
        <textarea
          ref={ref}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.target.value);
            if (warning) setWarning(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          className="input-inline max-h-28 min-h-[28px] min-w-0 flex-1 resize-none border-0 bg-transparent px-1 py-1 text-[13px] leading-[20px] text-slate-100 outline-none placeholder:text-slate-500 focus:outline-none focus:ring-0"
        />
        <button
          type="button"
          title={
            !isAudioSupported
              ? "Voice input is unavailable"
              : isTranscribing
                ? "Transcribing voice…"
                : isRecording
                  ? "Stop voice input"
                  : "Voice input"
          }
          onClick={toggleAudio}
          disabled={disabled || isTranscribing || !isAudioSupported}
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors ${
            isRecording
              ? "bg-rose-500/20 text-rose-300 animate-pulse hover:bg-rose-500/30"
              : isTranscribing || !isAudioSupported
                ? "text-slate-600 cursor-not-allowed"
                : "text-slate-400 hover:bg-white/10 hover:text-slate-200"
          }`}
        >
          <Mic size={14} />
        </button>
        <button
          type="button"
          title="Send"
          onClick={send}
          disabled={!text.trim() || disabled}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-emerald-300 transition-colors hover:bg-white/10 disabled:text-slate-600 disabled:hover:bg-transparent"
        >
          <Send size={15} />
        </button>
      </div>
      {target && <div className="mt-1.5 px-1 text-[11px] text-slate-400">{target}</div>}
    </div>
  );
}
