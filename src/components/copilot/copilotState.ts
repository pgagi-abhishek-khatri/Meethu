// What the copilot window knows, rebuilt from the engine's event stream (src/copilot/main/engine.js).
// Pure and idempotent: replaying the same events (the window reloads, or an event arrives both live and
// in the replay) gives the same state.

export type Confidence = "high" | "medium" | "low";
export type CardStatus = "queued" | "searching" | "streaming" | "done" | "error";

export interface Source {
  url: string;
  title?: string;
  snippet?: string;
}

export interface Card {
  id: string;
  threadId: string;
  status: CardStatus;
  label?: string; // "Before the meeting", "Meeting recap"
  deliverable?: string;
  proactive?: boolean;
  focus?: string;
  title?: string;
  body?: string;
  confidence?: Confidence;
  sources?: Source[];
  timing?: { firstTokenMs?: number; totalMs?: number } | null;
  truncated?: boolean;
  error?: string;
  feedback?: "up" | "down" | null;
  followups?: string[]; // short questions the user can tap to ask next
  deep?: boolean; // a "Rerun with high effort" re-run
  deepened?: boolean; // a high-effort answer was already asked for this card
}

export interface Segment {
  id: number;
  source: string;
  label: string; // USER, OTHER-1 ...
  text: string;
  at?: number;
}

export interface Decision {
  kind: string; // run | wait | skip | recheck
  trigger?: string;
  deliverable?: string;
  newText: string;
  reasons?: string[];
  confidence?: number;
  callMs?: number;
  inputTokens?: number;
  at: number;
}

export interface Thread {
  id: string;
  title: string;
}

// A moment the copilot passed on (below its bar, or the model found it not worth a card): one tap asks it.
export interface Skipped {
  id: string;
  line: string;
  why?: string;
}

export type WindowMode = "orb" | "peek" | "full";

export interface CopilotState {
  sessionId: string | null;
  phase: "idle" | "live" | "ended";
  active: boolean; // false = no API key: transcript only
  canAnswer: boolean;
  segments: Segment[];
  partial: { label: string; text: string } | null;
  summary: string;
  threads: Thread[];
  cards: Card[]; // oldest first
  decisions: Decision[];
  skipped: Skipped[]; // newest first
  mode: WindowMode;
  project: {
    projectId: number | null;
    name: string | null;
    event: { title: string; endsAt: number | null } | null;
  };
  problem: "key" | "credits" | null; // the AI account refuses every call
  busy: boolean; // the copilot is thinking about something right now
  stats: Record<string, unknown> | null;
}

export type CopilotEvent = { type: string; [key: string]: any };

export const MAIN_THREAD: Thread = { id: "main", title: "Main" };
const MAX_SEGMENTS = 600;
const MAX_DECISIONS = 60;

export const initialState = (): CopilotState => ({
  sessionId: null,
  phase: "idle",
  active: true,
  canAnswer: true,
  segments: [],
  partial: null,
  summary: "",
  threads: [MAIN_THREAD],
  cards: [],
  decisions: [],
  skipped: [],
  mode: "full",
  project: { projectId: null, name: null, event: null },
  problem: null,
  busy: false,
  stats: null,
});

const upsertCard = (cards: Card[], id: string, make: (old: Card | undefined) => Card): Card[] => {
  const i = cards.findIndex((c) => c.id === id);
  if (i < 0) return [...cards, make(undefined)];
  const next = cards.slice();
  next[i] = make(cards[i]);
  return next;
};

export function reduce(state: CopilotState, e: CopilotEvent): CopilotState {
  switch (e.type) {
    case "session":
      if (e.state === "start") {
        return {
          ...initialState(),
          sessionId: e.sessionId ?? null,
          phase: "live",
          active: e.active !== false,
          canAnswer: !!e.canAnswer,
        };
      }
      return {
        ...state,
        phase: "ended",
        partial: null,
        busy: false,
        skipped: [],
        summary: e.summary || state.summary,
        stats: e.stats ?? state.stats,
      };
    case "segment": {
      if (state.segments.some((s) => s.id === e.id)) return state;
      const seg: Segment = { id: e.id, source: e.source, label: e.label, text: e.text, at: e.at };
      const segments = [...state.segments, seg].slice(-MAX_SEGMENTS);
      return {
        ...state,
        segments,
        partial:
          state.partial && (state.partial.label === "USER") === (e.label === "USER")
            ? null
            : state.partial,
      };
    }
    case "partial":
      return { ...state, partial: e.text ? { label: e.label, text: e.text } : null };
    case "summary":
      return { ...state, summary: e.text };
    case "stats":
      return { ...state, stats: e.stats };
    case "skipped":
      return { ...state, skipped: (e.items ?? []) as Skipped[] };
    case "project":
      return {
        ...state,
        project: { projectId: e.projectId ?? null, name: e.name ?? null, event: e.event ?? null },
      };
    case "feedback": // the user marked a card (local, not from the engine)
      return {
        ...state,
        cards: state.cards.map((c) => (c.id === e.id ? { ...c, feedback: e.value } : c)),
      };
    case "mode":
      return { ...state, mode: e.mode };
    case "problem":
      return { ...state, problem: e.kind ?? null };
    case "activity":
      return { ...state, busy: !!e.busy };
    case "decision": {
      const d: Decision = {
        kind: e.decision?.kind,
        trigger: e.decision?.trigger,
        deliverable: e.decision?.deliverable,
        newText: e.newText,
        reasons: e.decision?.reasons,
        confidence: e.decision?.confidence,
        callMs: e.callMs,
        inputTokens: e.inputTokens,
        at: Date.now(),
      };
      return { ...state, decisions: [...state.decisions, d].slice(-MAX_DECISIONS) };
    }
    case "thread": {
      const t = e.thread as Thread;
      if (e.action === "create")
        return state.threads.some((x) => x.id === t.id)
          ? state
          : { ...state, threads: [...state.threads, t] };
      if (e.action === "rename")
        return {
          ...state,
          threads: state.threads.map((x) => (x.id === t.id ? { ...x, title: t.title } : x)),
        };
      if (e.action === "close")
        return {
          ...state,
          threads: state.threads.filter((x) => x.id !== t.id),
          cards: state.cards.filter((c) => c.threadId !== t.id),
        };
      return state;
    }
    case "card_queued":
      return {
        ...state,
        cards: upsertCard(
          state.cards,
          e.id,
          (o) =>
            o ?? {
              id: e.id,
              threadId: e.threadId ?? "main",
              status: "queued",
              focus: e.focus,
              deliverable: e.deliverable,
            }
        ),
      };
    case "card_start":
      return {
        ...state,
        cards: upsertCard(
          e.of
            ? state.cards.map((c) => (c.id === e.of ? { ...c, deepened: true } : c))
            : state.cards,
          e.id,
          (o) =>
            o?.status === "done"
              ? o
              : {
                  ...(o ?? {}),
                  id: e.id,
                  threadId: e.threadId ?? "main",
                  status: e.web ? "searching" : "streaming",
                  label: e.label,
                  deliverable: e.deliverable,
                  proactive: e.proactive,
                  deep: e.deep,
                  focus: e.focus,
                }
        ),
      };
    case "card_update":
      return {
        ...state,
        cards: state.cards.map((c) =>
          c.id === e.id && c.status !== "done"
            ? {
                ...c,
                status: "streaming",
                title: e.title ?? c.title,
                body: e.body ?? c.body,
                confidence: e.confidence ?? c.confidence,
              }
            : c
        ),
      };
    case "card_done":
      return {
        ...state,
        cards: upsertCard(state.cards, e.id, (o) => ({
          ...(o ?? { id: e.id, threadId: e.threadId ?? "main" }),
          status: "done",
          title: e.title,
          body: e.body,
          confidence: e.confidence,
          sources: e.sources ?? [],
          timing: e.timing ?? null,
          truncated: !!e.truncated,
          followups: e.followups ?? [],
        })),
      };
    case "card_error":
      // A card nobody asked for that failed is not worth showing; an asked one says what went wrong.
      if (e.proactive) return { ...state, cards: state.cards.filter((c) => c.id !== e.id) };
      return {
        ...state,
        cards: state.cards.map((c) =>
          c.id === e.id
            ? { ...c, status: "error", error: errorText(e as { code?: string; message?: string }) }
            : c
        ),
      };
    case "card_skip":
    case "card_cancel":
      return { ...state, cards: state.cards.filter((c) => c.id !== e.id) };
    default:
      return state;
  }
}

export function errorText(e: { code?: string; message?: string }): string {
  if (e.code === "no_key") return "No API key. Add one in Settings.";
  if (e.code === "http_401" || e.code === "http_403")
    return "The API key was refused. Check it in Settings.";
  if (e.code === "http_402")
    return "The AI account refused this request (credits, or too many at once). Try again.";
  if (e.code === "http_429") return "Rate limited. Try again in a moment.";
  if (e.code === "empty") return "The model sent nothing back.";
  return e.message || "Something went wrong.";
}

export const cardsOf = (state: CopilotState, threadId: string): Card[] =>
  state.cards.filter((c) => c.threadId === threadId);
