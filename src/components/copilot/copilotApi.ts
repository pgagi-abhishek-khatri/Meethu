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
  keyStorage?: "none" | "keychain" | "plaintext"; // plaintext: the OS keychain was unavailable
  keyWarning?: string; // a saved key that is not an OpenRouter key (ignored; the .env key is used)
  keyError?: string; // the key just pasted was refused
}

export type FileStatus = "queued" | "reading" | "analysing" | "indexing" | "embedding" | "ready" | "error";
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

export interface FileReferenceTarget {
  fileId?: number;
  projectId?: number;
  name: string;
  page?: number | null;
  where?: string | null;
  snippet?: string | null;
}

export interface ProjectFilePreview {
  ok: boolean;
  kind?: string;
  name?: string;
  mime?: string;
  text?: string;
  dataBase64?: string;
  truncated?: boolean;
  error?: string;
}

export interface LocalCodeRepoStats {
  filesScanned: number;
  codeModules: number;
  indexedDocuments: number;
  indexMs: number;
  vectorCalls: number;
  embeddingTokens: number;
  truncated?: boolean; // the file cap was reached: part of the repo is not indexed
  skippedLarge?: number; // files over the size limit, left out
  secretsRedacted?: number; // credentials replaced in place before indexing
}

export interface LocalCodeRepo {
  id: number;
  path: string;
  name: string;
  activeBranch: string | null;
  lastIndexedAt: number | null;
  stats: LocalCodeRepoStats | null;
}

export interface CodeHit {
  id: string;
  type: "module_md" | "ast_chunk" | "markdown_doc";
  relPath: string;
  heading: string;
  lineStart: number;
  score: number;
  matchedTerms: string[];
  text: string;
}

export interface CommitMatch {
  sha: string;
  fullSha: string;
  author: string;
  date: string;
  message: string;
  files: string[];
  score: number;
}

export interface LocalBranchInfo {
  name: string;
  sha: string;
  upstream: string | null;
  lastCommitSubject: string;
  isCurrent: boolean;
}

export interface LocalBranchDiffResult {
  ok: boolean;
  diff?: string;
  diffStat?: string;
  truncated?: boolean;
  stats?: { filesChanged: number; keptFiles: number; droppedFiles: string[] };
  error?: string;
}

export interface CodeModuleSummary {
  relPath: string;
  language: string;
  totalLines: number;
  classes: string[];
  functions: string[];
  markdown: string;
}

export interface SingleCodeContextResult {
  ok: boolean;
  fileName?: string;
  activeBranch?: string;
  summary?: string;
  markdown?: string;
  metrics?: {
    repoName: string;
    totalModules: number;
    includedModules: number;
    rawCodeChars: number;
    markdownChars: number;
    estRawTokens: number;
    estMarkdownTokens: number;
    compressionPct: number;
    vectorCalls: number;
    githubApiCalls: number;
  };
  error?: string;
}

export interface CodeAnalysisResult {
  ok: boolean;
  query?: string;
  route?: string;
  intent?: { route: string; tier: string; latencyMs: number; rationale: string };
  markdown?: string;
  evidence?: {
    gitFacts: { type: string; id: string; data: Record<string, unknown>; authority: number }[];
    branchComparison: LocalBranchDiffResult | null;
    commitMatches: CommitMatch[];
    codeHits: CodeHit[];
  };
  telemetry?: {
    totalMs: number;
    indexMs: number;
    searchMs: number;
    vectorCalls: number;
    embeddingTokens: number;
    githubApiCalls: number;
  };
  error?: string;
}

export interface CopilotBridge {
  onEvent(cb: (e: CopilotEvent) => void): () => void;
  startMeeting?(): Promise<void>;
  stopMeeting?(): Promise<void>;
  onHover?(cb: (over: boolean) => void): () => void;
  ask(q: {
    text: string;
    web?: boolean;
    threadId?: string;
    quote?: string;
    skippedId?: string; // a tapped item of the Skipped box: it leaves the box
    attachment?: {
      name: string;
      content: string;
      size?: number;
      type?: string;
    };
  }): Promise<string | false>;
  transcribeAudio?(
    audioData: ArrayBuffer,
    mimeType?: string
  ): Promise<{ ok: boolean; text?: string; error?: string }>;
  pause?(): Promise<boolean>;
  resume?(): Promise<boolean>;
  togglePause?(): Promise<boolean>;
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
    addDropped?(id: number, files: FileList | File[]): Promise<number>; // control panel only
    removeFile(id: number): Promise<void>;
    downloadFile?(id: number): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
    previewFile?(id: number): Promise<ProjectFilePreview>;
    reindex(id: number): Promise<boolean>;
  };
  sessionProject: {
    get(): Promise<MeetingProject>;
    set(id: number | null, remember?: boolean): Promise<MeetingProject>; // remember = teach the calendar rule
  };
  sessions: {
    list(): Promise<PastSession[]>; // the newest 50
    count?(): Promise<number>; // control panel only: how many are saved in all
    get(id: string): Promise<PastSessionDetail | null>;
    remove(id: string): Promise<void>;
  };
  code?: {
    listRepos(): Promise<LocalCodeRepo[]>;
    pickRepo(): Promise<{ ok: boolean; canceled?: boolean; repo?: LocalCodeRepo | null; error?: string }>;
    refreshRepo(repoDir: string): Promise<{ ok: boolean; repo?: LocalCodeRepo | null; error?: string }>;
    removeRepo(id: number): Promise<boolean>;
    analyze(repoDir: string, query: string, topK?: number): Promise<CodeAnalysisResult>;
    branches(repoDir: string): Promise<{ ok: boolean; current?: string; branches: LocalBranchInfo[] }>;
    diff(repoDir: string, base: string, head: string): Promise<LocalBranchDiffResult>;
    modules(repoDir: string): Promise<{ ok: boolean; stats?: LocalCodeRepoStats; modules: CodeModuleSummary[] }>;
    getContextFile(repoDir: string): Promise<SingleCodeContextResult>;
    downloadContextFile(
      repoDir: string
    ): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
  };
  openWindow?(): Promise<void>; // control panel only: show the live window
  closeWindow?(): Promise<void>; // control panel only: hide the live window
  isWindowOpen?(): Promise<boolean>; // control panel only: whether the live window is visible
  onWindowState?(cb: (open: boolean) => void): () => void; // control panel only: live window visibility
  onSettingsUpdated?(cb: (settings: CopilotSettings) => void): () => void; // control panel only: settings sync
  openReference?(ref: FileReferenceTarget): Promise<{ ok: boolean; error?: string }>;
  onOpenReference?(cb: (ref: FileReferenceTarget) => void): () => void;
  openSettings?(section?: string): Promise<void>;
  window(
    action: "expand" | "mode" | "opacity" | "hide" | "close" | "open" | "drag-start" | "drag-stop",
    value?: unknown // mode: "orb" | "peek" | "full"
  ): Promise<void>;
}

declare global {
  interface Window {
    copilot?: CopilotBridge;
  }
}
