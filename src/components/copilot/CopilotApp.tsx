import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Key, Minus, Plus, Settings, Sparkles, X } from "../icons";
import { MAIN_THREAD, cardsOf, type Skipped } from "./copilotState";
import { useCopilot } from "./useCopilot";
import CardFeed from "./CardFeed";
import Composer from "./Composer";
import TranscriptView from "./TranscriptView";
import ContextView, { SummaryBlock } from "./ContextView";
import { LiveStrip, ProblemBanner, SkippedBox } from "./LiveHeader";
import { Orb, Peek } from "./OrbView";
import type { Project, CopilotSettings } from "./copilotApi";
import { PastMeeting } from "./PastMeetings";
import type { AttachedDocument } from "./documentReader";

type Tab = "copilot" | "transcript" | "context";
const EXPANDED_FROM = 900; // px: wide enough for the three-pane layout (main resizes the window)

function useWidth() {
  const [w, setW] = useState(window.innerWidth);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}

function ThreadChips({
  threads,
  current,
  onPick,
  onClose,
  onNew,
  unseen,
}: {
  threads: { id: string; title: string }[];
  current: string;
  onPick: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  unseen: Set<string>;
}) {
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto border-b border-white/10 px-3 py-1.5">
      {threads.map((t) => (
        <span
          key={t.id}
          className={`flex items-center rounded-full border text-[11px] ${current === t.id ? "border-emerald-400/60 bg-emerald-400/10 text-emerald-100" : "border-white/10 text-slate-400 hover:text-slate-200"}`}
        >
          <button type="button" className="px-2.5 py-0.5" onClick={() => onPick(t.id)}>
            {t.title}
            {unseen.has(t.id) && (
              <span className="ms-1 inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
            )}
          </button>
          {t.id !== "main" && (
            <button
              type="button"
              title="Close thread"
              onClick={() => onClose(t.id)}
              className="pe-1.5 text-slate-500 hover:text-rose-300"
            >
              <X size={11} />
            </button>
          )}
        </span>
      ))}
      <button
        type="button"
        title="New thread"
        onClick={onNew}
        className="rounded-full p-1 text-slate-500 hover:text-slate-100"
      >
        <Plus size={12} />
      </button>
    </div>
  );
}

export default function CopilotApp() {
  const {
    state,
    settings,
    updateSettings,
    markFeedback,
    dismissCard,
    skipFollowups,
    skipGaps,
    skipAllMoments,
    togglePause,
  } = useCopilot();
  useEffect(() => {
    document.title = "Copilot";
  }, []);
  const expanded = useWidth() >= EXPANDED_FROM;
  const [tab, setTab] = useState<Tab>("copilot");
  const [thread, setThread] = useState("main"); // the thread on show (compact) / the side thread (expanded)
  const [viewing, setViewing] = useState<string | null>(null); // an earlier meeting
  const [quote, setQuote] = useState("");
  const [focusToken, setFocusToken] = useState(0);
  const [unseen, setUnseen] = useState(false); // a card arrived while another tab was open
  const [seen, setSeen] = useState<Record<string, number>>({}); // finished cards per thread already looked at

  const custom = state.threads.filter((t) => t.id !== MAIN_THREAD.id);
  const sideThread = custom.some((t) => t.id === thread) ? thread : (custom[0]?.id ?? null);
  const shownThread = state.threads.some((t) => t.id === thread) ? thread : "main";

  const doneIn = (id: string) =>
    state.cards.filter((c) => c.threadId === id && c.status === "done").length;
  useEffect(() => {
    const n = doneIn(shownThread);
    setSeen((x) => (x[shownThread] === n ? x : { ...x, [shownThread]: n }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownThread, state.cards]);
  const unseenThreads = new Set(
    state.threads
      .filter((t) => t.id !== shownThread && doneIn(t.id) > (seen[t.id] ?? 0))
      .map((t) => t.id)
  );
  const askSkipped = (i: Skipped) =>
    void window.copilot?.ask({ text: i.line, skippedId: i.id, threadId: "main" });
  const dropSkipped = (i: Skipped) => void window.copilot?.cancel(i.id);
  const dropAllSkipped = () => {
    for (const item of state.skipped) void window.copilot?.cancel(item.id);
    skipAllMoments();
  };

  // ---- window modes: orb (small), peek (newest card beside it), full (the panel) ----
  const mode = state.mode;
  const [mouseIn, setMouseIn] = useState(false); // DOM enter/leave: misses the drag header
  const [cursorOver, setCursorOver] = useState(false); // main's cursor poll: sees the header too
  const hovered = mouseIn || cursorOver;
  const [localOpacity, setLocalOpacity] = useState<number | null>(null);
  const currentOpacityRef = useRef(settings?.opacity ?? 0.5);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wheelAccumulator = useRef(0);

  useEffect(() => {
    if (settings?.opacity != null) {
      currentOpacityRef.current = settings.opacity;
      setLocalOpacity(settings.opacity);
    }
  }, [settings?.opacity]);

  const applyOpacityChange = useCallback(
    (step: number) => {
      const cur = currentOpacityRef.current;
      const next = Math.round(Math.min(1, Math.max(0.3, cur + step)) * 100) / 100;
      if (next === cur) return;

      currentOpacityRef.current = next;
      setLocalOpacity(next);

      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(() => {
        void updateSettings({ opacity: next });
      }, 150);
    },
    [updateSettings]
  );

  const handleSettingsUpdate = useCallback(
    (patch: Partial<CopilotSettings> & { apiKey?: string }) => {
      if (patch.opacity !== undefined) {
        currentOpacityRef.current = patch.opacity;
        setLocalOpacity(patch.opacity);
      }
      return updateSettings(patch);
    },
    [updateSettings]
  );

  // The drag header swallows mouse events, so main reports whether the cursor is over the window.
  useEffect(() => window.copilot?.onHover?.(setCursorOver), []);

  useEffect(() => {
    if (mode !== "full") return;

    // Opacity by wheel only while Alt is held; a plain scroll or touchpad swipe must never change it.
    const handleWheel = (e: WheelEvent) => {
      if (!e.altKey) return;
      e.preventDefault();
      wheelAccumulator.current += e.deltaY || e.deltaX;
      if (Math.abs(wheelAccumulator.current) >= 30) {
        const step = wheelAccumulator.current < 0 ? 0.05 : -0.05;
        wheelAccumulator.current = 0;
        applyOpacityChange(step);
      }
    };

    window.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      window.removeEventListener("wheel", handleWheel);
    };
  }, [mode, applyOpacityChange]);

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, []);

  const setMode = useCallback(
    (m: "orb" | "peek" | "full") => void window.copilot?.window("mode", m),
    []
  );
  const doneCount = state.cards.filter((c) => c.status === "done").length;
  // Main-thread cards that have words on screen (streaming or finished): the orb peeks at the first words of a
  // card, not only once it is done (docs/copilot/LATENCY_1S_PLAN.md, Phase 1).
  const shownCount = state.cards.filter(
    (c) => c.threadId === "main" && (c.status === "streaming" || c.status === "done")
  ).length;
  const [seenDone, setSeenDone] = useState(0); // finished cards already looked at (orb badge)
  const lastShown = useRef(shownCount);
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearPeek = () => {
    if (peekTimer.current) clearTimeout(peekTimer.current);
    peekTimer.current = null;
  };
  const backToOrb = (ms: number) => {
    clearPeek();
    peekTimer.current = setTimeout(() => setMode("orb"), ms);
  };
  const peekMs = (settings?.peekSeconds ?? 8) * 1000;
  // A new card while small: peek at it as soon as its first words arrive; shrink again once it is done (below).
  // "Before the meeting" cards do not trigger the peek popup.
  useEffect(() => {
    if (shownCount > lastShown.current && mode !== "full") {
      const card = newest;
      if (card?.label !== "Before the meeting") {
        clearPeek();
        setMode("peek");
      }
    }
    lastShown.current = shownCount;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownCount]);
  useEffect(() => {
    if (doneCount > 0 && tab !== "copilot") setUnseen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doneCount]);
  useEffect(() => {
    if (mode === "full") {
      clearPeek();
      setSeenDone(doneCount);
    }
    if (mode === "peek") setSeenDone(doneCount);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);
  useEffect(() => clearPeek, []);
  const newest =
    [...state.cards]
      .reverse()
      .find((c) => (c.status === "done" || c.status === "streaming") && c.threadId === "main") ??
    null;
  // The peek stays open while the card is still being written, and shrinks back a while after it is done.
  useEffect(() => {
    if (mode === "peek" && newest?.status === "done") backToOrb(peekMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newest?.id, newest?.status, mode]);

  // The meeting stopped: close the window, shrink it, or leave it, as set. A recap still being written is awaited.
  // Only trigger on a live -> ended transition, never when opening the window while a prior meeting is already ended.
  const prevPhaseRef = useRef(state.phase);
  const justEndedRef = useRef(false);
  if (prevPhaseRef.current !== state.phase) {
    justEndedRef.current = prevPhaseRef.current === "live" && state.phase === "ended";
    prevPhaseRef.current = state.phase;
  }
  const ended = state.phase === "ended";
  const working = state.cards.some(
    (c) => c.status === "queued" || c.status === "searching" || c.status === "streaming"
  );
  useEffect(() => {
    if (!ended || !justEndedRef.current || !settings) return;
    if (settings.onEnd === "orb") {
      justEndedRef.current = false;
      setMode("orb");
    } else if (settings.onEnd === "close") {
      const t = setTimeout(() => {
        justEndedRef.current = false;
        void window.copilot?.window("close");
      }, working ? 25000 : 6000);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ended, working, settings?.onEnd]);

  // The project of this meeting (from the calendar, or picked here).
  const [projects, setProjects] = useState<Project[]>([]);
  useEffect(() => {
    void window.copilot?.projects.list().then(setProjects);
  }, [state.project.projectId, state.phase]);
  const pickProject = (value: string) =>
    void window.copilot?.sessionProject.set(value ? Number(value) : null, !!state.project.event);

  const status = useMemo(() => {
    if (settings && !settings.hasKey)
      return { dot: "bg-amber-400", text: "No API key: open Settings" };
    if (!settings?.enabled) return { dot: "bg-slate-500", text: "Copilot is off" };
    if (state.paused) return { dot: "bg-amber-400", text: "Paused" };
    if (state.phase === "live") return { dot: "bg-emerald-400 animate-pulse", text: "Listening" };
    if (state.phase === "ended") return { dot: "bg-slate-400", text: "Meeting ended" };
    return { dot: "bg-slate-500", text: "Waiting for a meeting" };
  }, [settings, state.phase, state.paused]);

  const go = (t: Tab) => {
    setTab(t);
    setViewing(null);
    if (t === "copilot") setUnseen(false);
  };
  const send = (text: string, threadId: string, attachment?: AttachedDocument | null) => {
    void window.copilot?.ask({
      text,
      threadId,
      quote,
      attachment: attachment
        ? {
            name: attachment.name,
            content: attachment.content,
            size: attachment.size,
            type: attachment.type,
          }
        : undefined,
    });
    setQuote("");
    go("copilot");
  };
  const newThread = async (): Promise<string | undefined> => {
    const id = await window.copilot?.createThread();
    if (id) setThread(id);
    return id;
  };
  const closeThread = (id: string) => {
    void window.copilot?.closeThread(id);
    if (thread === id) setThread("main");
  };

  const feed = (threadId: string, empty: string) => {
    return (
      <CardFeed
        cards={cardsOf(state, threadId)}
        emptyText={empty}
        onAsk={(text, card) => void window.copilot?.ask({ text, threadId: card.threadId })}
        onDeeper={(card) => void window.copilot?.rerun(card.id)}
        onFeedback={(card, value) => markFeedback(card.id, value, state.sessionId)}
        onDismissCard={(card) => dismissCard(card.id)}
        onSkipFollowups={(card) => skipFollowups(card.id)}
        onSkipGaps={(card) => skipGaps(card.id)}
      />
    );
  };
  const emptyMain = !settings?.hasKey
    ? "Add your OpenRouter key in Settings to start."
    : state.phase === "live"
      ? "Listening. Answers appear here when something is worth it, and skipped moments wait below for a tap. You can ask anything."
      : "Start a meeting note and the copilot joins. You can already ask it something.";

  const tabBtn = (id: Tab, label: string) => (
    <button
      key={id}
      type="button"
      onClick={() => go(id)}
      className={`relative rounded-lg px-2.5 py-1 text-[12px] font-medium ${tab === id && !viewing ? "bg-white/10 text-white" : "text-slate-400 hover:text-slate-200"}`}
    >
      {label}
      {id === "copilot" && unseen && (
        <span className="absolute end-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-emerald-400" />
      )}
    </button>
  );

  const centerBody = viewing ? (
    <PastMeeting id={viewing} onBack={() => setViewing(null)} onDeleted={() => setViewing(null)} />
  ) : tab === "transcript" ? (
    <TranscriptView
      segments={state.segments}
      partial={state.partial}
      onAsk={(q) => {
        setQuote(q);
        setFocusToken((n) => n + 1);
      }}
    />
  ) : tab === "context" ? (
    <ContextView
      summary={state.summary}
      settings={settings}
      onSettings={handleSettingsUpdate}
      phase={state.phase}
      onPickPast={setViewing}
    />
  ) : (
    <>
      {!expanded && custom.length > 0 && (
        <ThreadChips
          threads={state.threads}
          current={shownThread}
          onPick={setThread}
          onClose={closeThread}
          onNew={() => void newThread()}
          unseen={unseenThreads}
        />
      )}
      {feed(expanded ? "main" : shownThread, emptyMain)}
    </>
  );

  const composerThread = expanded ? "main" : shownThread;
  const composerTitle = state.threads.find((t) => t.id === composerThread)?.title ?? "Main";

  const style = (
    <style>{`html,body,#root{background:transparent!important}.copilot-md code,.copilot-md pre{background:rgba(255,255,255,.08)!important}.copilot-md a{color:#7dd3fc}select option{background-color:#1a1d26!important;color:#e2e8f0!important;}`}</style>
  );
  if (mode === "orb")
    return (
      <>
        {style}
        <Orb
          busy={state.busy}
          unseen={Math.max(0, doneCount - seenDone)}
          skipped={state.skipped.length}
          live={state.phase === "live"}
          paused={state.paused}
          onHover={() => {}}
          onOpen={() => setMode("full")}
        />
      </>
    );
  if (mode === "peek") {
    if (newest?.label === "Before the meeting") {
      setMode("orb");
      return null;
    }
    return (
      <>
        {style}
        <Peek
          card={newest}
          skipped={state.skipped.length}
          onOpen={() => {
            void handleSettingsUpdate({ opacity: 1.0 });
            setMode("full");
          }}
          onHover={clearPeek}
          onLeave={() => backToOrb(1500)}
          onClose={() => setMode("orb")}
        />
      </>
    );
  }

  const currentOpacity = localOpacity ?? settings?.opacity ?? 0.5;
  const isFadeWhenIdle = !!settings?.fadeWhenIdle;

  const effectiveOpacity = isFadeWhenIdle && (hovered || ended) ? 1 : currentOpacity;
  const needsSetup = settings !== null && (!settings.hasKey || !!settings.keyWarning);

  if (needsSetup && settings) {
    return (
      <CopilotCredentialOnboarding
        style={style}
        settings={settings}
        opacity={effectiveOpacity}
        onMouseEnter={() => setMouseIn(true)}
        onMouseLeave={() => setMouseIn(false)}
        onSaveKey={(apiKey) => updateSettings({ apiKey })}
        onMinimize={() => setMode("orb")}
        onClose={() => void window.copilot?.window("hide")}
      />
    );
  }

  return (
    <div
      data-copilot-root="true"
      className="dark flex h-screen min-h-0 flex-col overflow-hidden rounded-xl border border-white/10 bg-[#12141a] text-slate-200 transition-opacity duration-200 ease-out [color-scheme:dark]"
      style={{ opacity: effectiveOpacity }}
      onMouseEnter={() => setMouseIn(true)}
      onMouseLeave={() => setMouseIn(false)}
    >
      {style}
      <header
        style={{ WebkitAppRegion: "drag" }}
        className="flex items-center gap-1 border-b border-white/10 px-3 py-1.5 [&_button]:[-webkit-app-region:no-drag] [&_select]:[-webkit-app-region:no-drag]"
      >
        {tabBtn("copilot", "Copilot")}
        {tabBtn("transcript", "Transcript")}
        {tabBtn("context", "Context")}
        <div className="ms-auto flex items-center gap-1 text-slate-400">
          <span
            title={status.text}
            className={`me-1 inline-block h-2 w-2 rounded-full ${status.dot}`}
          />
          {state.phase !== "live" && tab === "copilot" && (
            <button
              type="button"
              title="New thread"
              onClick={() => void newThread()}
              className="flex h-7 w-7 items-center justify-center rounded-lg hover:bg-white/10 hover:text-slate-200"
            >
              <Plus size={14} />
            </button>
          )}
          <button
            type="button"
            title="Shrink to the orb"
            onClick={() => setMode("orb")}
            className="flex h-7 w-7 items-center justify-center rounded-lg hover:bg-white/10 hover:text-slate-200"
          >
            <Minus size={14} />
          </button>
          <button
            type="button"
            title="Settings"
            onClick={() => void window.copilot?.openSettings?.("copilot")}
            className="flex h-7 w-7 items-center justify-center rounded-lg hover:bg-white/10 hover:text-slate-200"
          >
            <Settings size={14} />
          </button>
          <button
            type="button"
            title="Close"
            onClick={() => void window.copilot?.window("hide")}
            className="flex h-7 w-7 items-center justify-center rounded-lg hover:bg-white/10 hover:text-slate-200"
          >
            <X size={14} />
          </button>
        </div>
      </header>

      <ProblemBanner
        kind={state.problem}
        onFix={() => void window.copilot?.openSettings?.(state.problem === "key" ? "copilotAudio" : "copilot")}
      />
      <LiveStrip
        state={state}
        onTogglePause={togglePause}
        onNewThread={tab === "copilot" ? () => void newThread() : undefined}
        onEnd={() => void window.copilot?.stopMeeting?.()}
      />
      {state.phase !== "live" && tab === "copilot" && settings?.hasKey && (
        <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-2 text-[11.5px] text-slate-400">
          <span>{state.phase === "ended" ? "Meeting ended" : "No meeting note running"}</span>
          <button
            type="button"
            onClick={() => {
              if (mode !== "full") setMode("full");
              void window.copilot?.startMeeting?.();
            }}
            className="flex h-7 items-center rounded-md border border-primary/40 bg-primary/15 px-2.5 text-[11px] font-medium text-blue-200 transition-colors hover:bg-primary/25"
          >
            Start meeting notes
          </button>
        </div>
      )}
      {state.phase === "live" && (projects.length > 0 || state.project.name) && (
        <div className="flex items-center gap-2.5 border-b border-white/10 px-3 py-2 text-[11.5px] text-slate-400">
          <span className="shrink-0 font-medium">Project</span>
          <select
            value={state.project.projectId ?? ""}
            onChange={(e) => pickProject(e.target.value)}
            className="h-7 min-w-0 flex-1 truncate rounded-md border border-white/10 bg-white/[0.04] px-2 text-[11.5px] text-slate-200 outline-none transition-colors hover:bg-white/[0.07] focus:border-primary/50 [color-scheme:dark]"
          >
            <option value="" className="bg-[#1a1d26] text-slate-200">
              None
            </option>
            {projects.map((p) => (
              <option key={p.id} value={p.id} className="bg-[#1a1d26] text-slate-200">
                {p.name}
              </option>
            ))}
          </select>
          {state.project.event && (
            <span
              className="max-w-[40%] shrink-0 truncate text-slate-500"
              title={state.project.event.title}
            >
              {state.project.event.title}
            </span>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {expanded && (
          <aside className="w-56 shrink-0 overflow-y-auto border-e border-white/10 p-3">
            <SummaryBlock summary={state.summary} />
          </aside>
        )}

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {centerBody}
          {tab === "copilot" && !viewing && (
            <SkippedBox
              items={state.skipped}
              onAsk={askSkipped}
              onDismiss={dropSkipped}
              onDismissAll={dropAllSkipped}
            />
          )}
          <Composer
            placeholder="Ask the copilot…"
            target={composerThread !== "main" ? `In: ${composerTitle}` : ""}
            quote={quote}
            onClearQuote={() => setQuote("")}
            onSend={(t, doc) => send(t, composerThread, doc)}
            focusToken={focusToken}
          />
        </main>

        {expanded && (
          <section className="flex min-h-0 w-80 shrink-0 flex-col border-s border-white/10">
            <ThreadChips
              threads={custom}
              current={sideThread ?? ""}
              onPick={setThread}
              onClose={closeThread}
              onNew={() => void newThread()}
              unseen={unseenThreads}
            />
            {sideThread ? (
              feed(sideThread, "Ask anything here. It runs next to the main thread.")
            ) : (
              <div className="flex flex-1 items-center justify-center p-6 text-center text-[13px] text-slate-500">
                Side questions get their own thread, so the main one stays clean.
              </div>
            )}
            <Composer
              placeholder={sideThread ? "Ask in this thread…" : "Start a thread…"}
              target=""
              quote=""
              onClearQuote={() => {}}
              onSend={async (t, doc) => {
                const id = sideThread ?? (await newThread());
                if (id) {
                  void window.copilot?.ask({
                    text: t,
                    threadId: id,
                    attachment: doc
                      ? {
                          name: doc.name,
                          content: doc.content,
                          size: doc.size,
                          type: doc.type,
                        }
                      : undefined,
                  });
                }
              }}
            />
          </section>
        )}
      </div>
    </div>
  );
}

function CopilotCredentialOnboarding({
  style,
  settings,
  opacity,
  onMouseEnter,
  onMouseLeave,
  onSaveKey,
  onMinimize,
  onClose,
}: {
  style: React.ReactNode;
  settings: CopilotSettings;
  opacity: number;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onSaveKey: (apiKey: string) => Promise<CopilotSettings | undefined>;
  onMinimize: () => void;
  onClose: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const keyValid = settings.hasKey && !settings.keyWarning;
  const issueMessage = error || settings.keyError || settings.keyWarning || null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setError("Please enter your OpenRouter API key (starts with sk-or-).");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next = await onSaveKey(trimmed);
      if (next?.keyError) {
        setError(next.keyError);
      } else if (next?.keyWarning) {
        setError(next.keyWarning);
      } else if (next?.hasKey) {
        setApiKey("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not verify and save key.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      data-copilot-root="true"
      className="dark flex h-screen min-h-0 flex-col overflow-hidden rounded-xl border border-white/10 bg-[#12141a] text-slate-200 transition-opacity duration-200 ease-out [color-scheme:dark]"
      style={{ opacity }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {style}
      <header
        style={{ WebkitAppRegion: "drag" }}
        className="flex items-center gap-2 border-b border-white/10 px-3 py-2 [&_button]:[-webkit-app-region:no-drag]"
      >
        <Sparkles size={14} className="text-primary" />
        <span className="text-[12px] font-medium text-slate-200">Meeting Copilot · Setup</span>
        <div className="ms-auto flex items-center gap-1 text-slate-400">
          <button
            type="button"
            title="Shrink to the orb"
            onClick={onMinimize}
            className="flex h-7 w-7 items-center justify-center rounded-lg hover:bg-white/10 hover:text-slate-200"
          >
            <Minus size={14} />
          </button>
          <button
            type="button"
            title="Close window"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg hover:bg-white/10 hover:text-slate-200"
          >
            <X size={14} />
          </button>
        </div>
      </header>

      <div className="flex flex-1 flex-col justify-center overflow-y-auto p-5">
        <div className="mx-auto w-full max-w-sm space-y-4">
          <div className="space-y-1.5 text-center">
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15 text-blue-300">
              <Key size={18} />
            </div>
            <h2 className="text-sm font-semibold text-slate-100">
              API credentials required
            </h2>
            <p className="text-[12px] leading-relaxed text-slate-400">
              Add your required OpenRouter API key to unlock the copilot card. It is stored
              encrypted on this computer.
            </p>
          </div>

          <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5 text-[12px]">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-slate-200">OpenRouter API Key</span>
              {keyValid ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10.5px] font-medium text-blue-300">
                  <Check size={11} /> Verified
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-[10.5px] font-medium text-slate-300">
                  <AlertTriangle size={11} /> Required
                </span>
              )}
            </div>
          </div>

          {issueMessage && (
            <div className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-[11.5px] leading-relaxed text-rose-200">
              {issueMessage}
            </div>
          )}

          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-2.5">
            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-slate-400">
                OpenRouter API Key
              </span>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  if (error) setError(null);
                }}
                placeholder="sk-or-..."
                autoFocus
                className="w-full rounded-lg border border-white/10 bg-[#1a1d26] px-2.5 py-2 text-[12.5px] text-slate-100 outline-none placeholder:text-slate-500 focus:border-primary/60"
              />
            </label>
            <button
              type="submit"
              disabled={saving || !apiKey.trim()}
              className="w-full rounded-lg border border-primary/40 bg-primary/20 px-3 py-2 text-[12.5px] font-medium text-blue-100 transition-colors hover:bg-primary/30 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving ? "Verifying & saving…" : "Verify & unlock copilot"}
            </button>
          </form>

          <p className="text-center text-[11px] text-slate-500">
            Keys start with <code className="text-slate-400">sk-or-</code>. Get one at{" "}
            <span className="text-slate-400">openrouter.ai/keys</span>.
          </p>
        </div>
      </div>
    </div>
  );
}
