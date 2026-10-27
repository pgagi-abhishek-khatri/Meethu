// Types of the bridge that src/copilot/main/preload.js puts on `window.copilot`.
import type { CopilotEvent, Thread } from "./copilotState";

export interface CopilotSettings {
  enabled: boolean;
  autoOpen: boolean;
  idleMode: "orb" | "full"; // how the window opens: a small orb that peeks, or the whole panel
  peekSeconds: number; // how long a new card stays beside the orb
  onEnd: "close" | "orb" | "keep"; // what the window does when the meeting stops
  mainModel: string;
  deepModel: string;
  summaryModel: string;
  quiet: "quiet" | "normal" | "chatty";
  web: boolean;
  instructions: string;
  plan: string;
  startPrompt: string;
  endPrompt: string;
  endRecap: boolean;
  closingCard: boolean; // a card with lines to say when the call is ending
  closingPrompt: string;
  autoProject: boolean; // pick the project from the calendar event
  maxParallel: number;
  hotkey: string;
  hotkeyError?: string;
  opacity: number;
  fadeWhenIdle: boolean;
  retentionDays: number;
  behavior: string; // learned, global guide on how the copilot behaves (editable)
  ragEnabled: boolean; // index project files and search them in meetings
  mediaEmbedMinutes: number; // minutes of each audio/video file embedded as sound/picture
  hasKey: boolean;
  keyFromEnv: boolean;
}

export type FileStatus = "queued" | "reading" | "analysing" | "embedding" | "ready" | "error";
export interface ProjectFile {
  id: number;
  path: string;
  name: string;
  kind: string | null; // text | office | pdf | image | audio | video
  status: FileStatus; // where indexing is; "ready" = the copilot can search it
  stage: string | null; // what it is doing now
  error: string | null;
  note: string | null; // e.g. only the first part was read
  summary: string | null; // what the file is, written when it was indexed
  bytes: number | null;
  chunks: number;
  cost: number; // dollars spent indexing it
}
export type RuleKind = "title" | "domain" | "meet_url";
export interface ProjectRule {
  id: number;
  kind: RuleKind;
  pattern: string;
}
export interface Project {
  id: number;
  name: string;
  active: boolean;
  instructions: string; // how the copilot should talk in this project
  plan: string; // standing notes: goals, prices, who is who
  rules: ProjectRule[]; // calendar rules that pick this project for a meeting
  files: ProjectFile[];
}
// The project of the meeting on now, and the calendar event it is linked to.
export interface MeetingProject {
  projectId: number | null;
  name: string | null;
  event: { title: string; endsAt: number | null } | null;
}
export interface PastSession {
  id: string;
  started_at: number;
  ended_at: number | null;
  title: string | null;
  summary: string | null;
  project_id: number | null;
  cards: number;
}
export interface PastSessionDetail {
  session: PastSession;
  segments: {
    seq: number;
    source: string;
    speaker: string | null;
    text: string;
    at: number | null;
  }[];
  threads: Thread[];
  cards: {
    id: string;
    threadId: string;
    label: string | null;
    title: string | null;
    body: string | null;
    confidence: string | null;
    sources: { url: string; title?: string }[];
    status: string;
    feedback: string | null;
  }[];
}

export interface CopilotBridge {
  onEvent(cb: (e: CopilotEvent) => void): () => void;
  ask(q: {
    text: string;
    web?: boolean;
    threadId?: string;
    quote?: string;
    skippedId?: string; // a tapped item of the Skipped box: it leaves the box
  }): Promise<string | false>;
  cancel(id: string): Promise<void>;
  rerun(id: string): Promise<string | false>; // "Rerun with high effort": ask again on the deep model with its tools
  createThread(title?: string): Promise<string>;
  renameThread(id: string, title: string): Promise<boolean>;
  closeThread(id: string): Promise<boolean>;
  feedback(
    sessionId: string | null,
    jobId: string,
    value: "up" | "down" | "dismissed" | null
  ): Promise<void>;
  getSettings(): Promise<CopilotSettings>;
  updateSettings(patch: Partial<CopilotSettings> & { apiKey?: string }): Promise<CopilotSettings>;
  projects: {
    list(): Promise<Project[]>;
    create(name: string): Promise<number>;
    rename(id: number, name: string): Promise<void>;
    update(
      id: number,
      patch: { name?: string; instructions?: string; plan?: string }
    ): Promise<void>;
    addRule(id: number, kind: RuleKind, pattern: string): Promise<number>;
    removeRule(id: number): Promise<void>;
    remove(id: number): Promise<void>;
    setActive(id: number, active: boolean): Promise<void>;
    addFiles(id: number): Promise<number>;
    removeFile(id: number): Promise<void>;
    reindex(id: number): Promise<boolean>;
  };
  sessionProject: {
    get(): Promise<MeetingProject>;
    set(id: number | null, remember?: boolean): Promise<MeetingProject>; // remember = teach the calendar rule
  };
  sessions: {
    list(): Promise<PastSession[]>;
    get(id: string): Promise<PastSessionDetail | null>;
    remove(id: string): Promise<void>;
  };
  window(
    action: "expand" | "mode" | "opacity" | "hide" | "close",
    value?: unknown // mode: "orb" | "peek" | "full"
  ): Promise<void>;
}

declare global {
  interface Window {
    copilot?: CopilotBridge;
  }
}
