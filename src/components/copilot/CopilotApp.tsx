import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Minus, Plus, Settings, X } from "../icons";
import { MAIN_THREAD, cardsOf, type Skipped } from "./copilotState";
import { useCopilot } from "./useCopilot";
import CardFeed from "./CardFeed";
import Composer from "./Composer";
import TranscriptView from "./TranscriptView";
import ContextView, { SummaryBlock } from "./ContextView";
import SettingsView from "./SettingsView";
import { LiveStrip, ProblemBanner, SkippedBox } from "./LiveHeader";
import { Orb, Peek } from "./OrbView";
import type { Project, CopilotSettings } from "./copilotApi";
import { PastMeeting } from "./PastMeetings";
import type { AttachedDocument } from "./documentReader";

type Tab = "copilot" | "transcript" | "context" | "settings";
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

function findScrollableAncestor(target: EventTarget | null, deltaY: number): HTMLElement | null {
  let el = target && target instanceof Element ? (target as HTMLElement) : null;
  while (el && el !== document.body && el !== document.documentElement) {
    if (el.getAttribute("data-copilot-root")) break;
    const style = window.getComputedStyle(el);
    const overflowY = style.overflowY;
    if (overflowY === "auto" || overflowY === "scroll") {
      const canScrollUp = deltaY < 0 && el.scrollTop > 1;
      const canScrollDown = deltaY > 0 && el.scrollTop + el.clientHeight < el.scrollHeight - 1;
      if (canScrollUp || canScrollDown) {
        return el;
      }
    }
    el = el.parentElement;
  }
  return null;
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
  const [hovered, setHovered] = useState(false);
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

  useEffect(() => {
    if (mode !== "full") return;

    const handleWheel = (e: WheelEvent) => {
      // Horizontal swipe or tilt wheel adjustments:
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && Math.abs(e.deltaX) >= 5) {
        wheelAccumulator.current += e.deltaX;
        if (Math.abs(wheelAccumulator.current) >= 30) {
          const step = wheelAccumulator.current > 0 ? 0.05 : -0.05;
          wheelAccumulator.current = 0;
          applyOpacityChange(step);
        }
        return;
      }

      const scrollable = findScrollableAncestor(e.target, e.deltaY);
      if (!scrollable || e.altKey || e.ctrlKey || e.shiftKey || e.metaKey) {
        if (Math.abs(e.deltaY) < 3) return;
        wheelAccumulator.current += e.deltaY;
        if (Math.abs(wheelAccumulator.current) >= 30) {
          const step = wheelAccumulator.current < 0 ? 0.05 : -0.05;
          wheelAccumulator.current = 0;
          applyOpacityChange(step);
        }
        if (!scrollable) {
          e.preventDefault();
        }
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
  const ended = state.phase === "ended";
  const working = state.cards.some(
    (c) => c.status === "queued" || c.status === "searching" || c.status === "streaming"
  );
  useEffect(() => {
    if (!ended || !settings) return;
    if (settings.onEnd === "orb") setMode("orb");
    else if (settings.onEnd === "close") {
      const t = setTimeout(() => void window.copilot?.window("close"), working ? 25000 : 6000);
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
  ) : tab === "settings" ? (
    <SettingsView settings={settings} state={state} onSettings={handleSettingsUpdate} />
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

  const effectiveOpacity =
    tab === "settings"
      ? currentOpacity
      : isFadeWhenIdle
        ? (hovered || ended ? 1 : currentOpacity)
        : currentOpacity;

  return (
    <div
      data-copilot-root="true"
      className="dark flex h-screen min-h-0 flex-col overflow-hidden rounded-xl border border-white/10 bg-[#12141a] text-slate-200 transition-opacity duration-200 ease-out [color-scheme:dark]"
      style={{ opacity: effectiveOpacity }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
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
          {state.phase !== "live" && (
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
            onClick={() => go("settings")}
            className={`flex h-7 w-7 items-center justify-center rounded-lg hover:bg-white/10 hover:text-slate-200 ${tab === "settings" ? "bg-white/10 text-white" : ""}`}
          >
            <Settings size={14} />
          </button>
          <button
            type="button"
            title={expanded ? "Collapse" : "Expand"}
            onClick={() => void window.copilot?.window("expand", !expanded)}
            className="flex h-7 w-7 items-center justify-center rounded-lg hover:bg-white/10 hover:text-slate-200"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {expanded ? (
                <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
              ) : (
                <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
              )}
            </svg>
          </button>
        </div>
      </header>

      <ProblemBanner kind={state.problem} onFix={() => go("settings")} />
      <LiveStrip
        state={state}
        onTogglePause={togglePause}
        onNewThread={() => void newThread()}
      />
      {state.phase === "live" && (projects.length > 0 || state.project.name) && (
        <div className="flex items-center gap-2 border-b border-white/10 px-3 py-1 text-[11px] text-slate-400">
          <span className="shrink-0">Project</span>
          <select
            value={state.project.projectId ?? ""}
            onChange={(e) => pickProject(e.target.value)}
            className="min-w-0 flex-1 truncate rounded border border-white/10 bg-[#1a1d26] px-1.5 py-0.5 text-slate-200 outline-none [color-scheme:dark]"
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
