import { useCallback, useEffect, useState } from "react";
import { AudioLines, Brain, Check, ChevronRight, Home, Monitor, Sparkles, X, Zap } from "../icons";
import { Button } from "../ui/button";
import { Toggle } from "../ui/toggle";
import { cn } from "../lib/utils";
import { useSettingsStore } from "../../stores/settingsStore";
import { fetchProviders } from "../../stores/streamingProvidersStore";
import { getMeetingStreamingTranscriptionProviders } from "../../models/ModelRegistry";
import { useCopilotSettings } from "./CopilotFields";
import { WORKING } from "./copilotFormat";
import { MeetingRow } from "./CopilotMeetings";
import { Block, PaneHeader } from "./CopilotPane";
import type { PastSession, Project } from "./copilotApi";

const PACE: Record<string, string> = {
  quiet: "Calm",
  normal: "Balanced",
  chatty: "Lively",
};

const MEETING_PROVIDER_KEY: Record<string, string> = {
  openai: "openaiApiKey",
  deepgram: "deepgramApiKey",
  assemblyai: "assemblyaiApiKey",
  soniox: "sonioxApiKey",
  tinfoil: "tinfoilApiKey",
};

export function useMeetingAudio(): { label: string; ok: boolean; detail: string } {
  const mode = useSettingsStore((s) => s.meetingTranscriptionMode);
  const provider = useSettingsStore(
    (s) => s.meetingCloudTranscriptionProvider || s.cloudTranscriptionProvider
  );
  const isSignedIn = useSettingsStore((s) => s.isSignedIn);
  const keyField = MEETING_PROVIDER_KEY[provider];
  const providerKey = useSettingsStore((s) =>
    keyField ? String((s as unknown as Record<string, unknown>)[keyField] ?? "") : ""
  );
  const [cloudError, setCloudError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "openwhispr") return;
    let live = true;
    void fetchProviders().then((r) => {
      if (live) setCloudError(r && r.success === false ? r.error || "unavailable" : null);
    });
    return () => {
      live = false;
    };
  }, [mode]);

  if (mode === "local") return { label: "Local model", ok: true, detail: "Local model" };
  if (mode === "openwhispr") {
    if (!isSignedIn)
      return {
        label: "OpenWhispr Cloud",
        ok: false,
        detail: "Sign in, or pick a provider (e.g. Soniox)",
      };
    if (cloudError)
      return {
        label: "OpenWhispr Cloud",
        ok: false,
        detail: "Cloud unavailable here: pick Soniox or a local model",
      };
    return { label: "OpenWhispr Cloud", ok: true, detail: "OpenWhispr Cloud" };
  }
  if (mode !== "providers")
    return { label: "Unsupported", ok: false, detail: "Pick a provider or a local model" };
  const name = getMeetingStreamingTranscriptionProviders().find((p) => p.id === provider)?.name;
  if (!name) return { label: "No provider", ok: false, detail: "Pick a provider" };
  const hasKey = keyField ? !!providerKey.trim() : true;
  return {
    label: name,
    ok: hasKey,
    detail: hasKey ? name : `${name}: add its API key`,
  };
}

function CheckRow({
  ok,
  label,
  detail,
  onClick,
}: {
  ok: boolean;
  label: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 px-4 py-3 text-start transition-colors hover:bg-foreground/3 dark:hover:bg-white/3"
    >
      <span
        className={cn(
          "flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
          ok ? "bg-success/15 text-success" : "bg-warning/15 text-warning"
        )}
      >
        {ok ? <Check size={11} /> : <span className="text-[11px] font-bold">!</span>}
      </span>
      <span className="flex-1 text-xs font-medium text-foreground">{label}</span>
      <span className="truncate text-xs text-muted-foreground">{detail}</span>
      <ChevronRight size={14} className="shrink-0 text-muted-foreground/60" />
    </button>
  );
}

const FLOW: { icon: typeof Home; title: string; text: string }[] = [
  {
    icon: AudioLines,
    title: "Listens",
    text: "Your mic and the call audio are transcribed live while a note records.",
  },
  {
    icon: Zap,
    title: "Decides",
    text: "Spots questions, objections and moments where a card would help.",
  },
  {
    icon: Sparkles,
    title: "Answers",
    text: "Short lines you can say, drawn from your project's files and briefing.",
  },
  {
    icon: Brain,
    title: "Learns",
    text: "Not helpful taps and skipped questions you ask for tune its behaviour.",
  },
];

export default function CopilotOverview({
  onNavigateSection,
  onOpenMeeting,
}: {
  onNavigateSection: (section: "projects" | "meetings" | "audio") => void;
  onOpenMeeting: (meetingId: string) => void;
}) {
  const { settings: s, update } = useCopilotSettings();
  const audio = useMeetingAudio();
  const [projects, setProjects] = useState<Project[]>([]);
  const [meetings, setMeetings] = useState<PastSession[]>([]);
  const [meetingCount, setMeetingCount] = useState<number | null>(null);
  const [windowOpen, setWindowOpen] = useState(false);
  const [windowPending, setWindowPending] = useState(false);

  const loadData = useCallback(() => {
    void window.copilot?.projects.list().then(setProjects, () => {});
    void window.copilot?.sessions.list().then(setMeetings, () => {});
    void window.copilot?.sessions.count?.().then(setMeetingCount, () => {});
    void window.copilot?.isWindowOpen?.().then(setWindowOpen, () => {});
  }, []);

  useEffect(() => {
    loadData();
    const offWindow = window.copilot?.onWindowState?.(setWindowOpen);
    const refresh = () => document.visibilityState === "visible" && loadData();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const t = setInterval(refresh, 30_000);
    return () => {
      offWindow?.();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      clearInterval(t);
    };
  }, [loadData]);

  if (!window.copilot) {
    return <p className="p-6 text-sm text-muted-foreground">Copilot is not available.</p>;
  }
  if (!s) return null;

  const active = projects.filter((p) => p.active);
  const files = active.reduce((n, p) => n + p.files.filter((f) => f.status === "ready").length, 0);
  const indexing = projects.some((p) => p.files.some((f) => WORKING.has(f.status)));
  const names = new Map(projects.map((p) => [p.id, p.name]));
  const meetingTotal = Math.max(meetingCount ?? 0, meetings.length);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-8 pt-6 pb-10">
      <div className="max-w-[820px]">
        <PaneHeader title="Meeting copilot" />
        <div className="mt-4 space-y-7">
          <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-border/70 bg-card/50 px-5 py-4 dark:border-white/10 dark:bg-surface-2/60">
            <div
              className={cn(
                "flex h-10 w-10 items-center justify-center rounded-xl",
                s.enabled ? "bg-primary/10 text-primary" : "bg-foreground/5 text-muted-foreground"
              )}
            >
              <Sparkles size={18} />
            </div>
            <div className="min-w-0 flex-1 basis-48">
              <p className="text-sm text-foreground">Meeting copilot is {s.enabled ? "on" : "off"}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {s.enabled
                  ? `${PACE[s.quiet]} pace · ${s.autoOpen ? "opens with each meeting" : "open it with the hotkey"}${s.hotkey ? ` (${s.hotkey})` : ""}`
                  : "Turn it on to get help cards during recorded meetings."}
              </p>
            </div>
            {windowOpen ? (
              <Button
                size="sm"
                variant="outline"
                disabled={windowPending}
                onClick={async () => {
                  setWindowPending(true);
                  try {
                    await window.copilot?.closeWindow?.();
                    setWindowOpen(false);
                  } finally {
                    setWindowPending(false);
                  }
                }}
              >
                <X size={13} className="me-1" /> Close window
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={windowPending}
                onClick={async () => {
                  setWindowPending(true);
                  try {
                    await window.copilot?.openWindow?.();
                    setWindowOpen(true);
                  } finally {
                    setWindowPending(false);
                  }
                }}
              >
                <Monitor size={13} className="me-1" /> Open window
              </Button>
            )}
            <Toggle
              checked={s.enabled}
              onChange={(enabled) => update({ enabled })}
              ariaLabel="Copilot on"
            />
          </div>

          <Block title="Setup">
            <div className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70 bg-card/50 dark:divide-border-subtle/50 dark:border-border-subtle dark:bg-surface-2/50">
              <CheckRow
                ok={s.hasKey && !s.keyWarning}
                label="OpenRouter key"
                detail={
                  s.keyWarning
                    ? "Saved key is not an OpenRouter key: open to fix"
                    : s.hasKey
                      ? s.keyFromEnv
                        ? "From .env"
                        : "Saved"
                      : "Needed to answer"
                }
                onClick={() => onNavigateSection("audio")}
              />
              <CheckRow
                ok={audio.ok}
                label="Meeting audio"
                detail={audio.detail}
                onClick={() => onNavigateSection("audio")}
              />
              <CheckRow
                ok={active.length > 0}
                label="Projects"
                detail={
                  active.length
                    ? `${active.length} in use · ${files} file${files === 1 ? "" : "s"} ready${indexing ? " · reading…" : ""}`
                    : "Optional: add your material"
                }
                onClick={() => onNavigateSection("projects")}
              />
            </div>
          </Block>

          <Block title="How it works">
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {FLOW.map(({ icon: Icon, title, text }, i) => (
                <div
                  key={title}
                  className="rounded-lg border border-border/70 bg-card/50 p-3 dark:border-border-subtle dark:bg-surface-2/50"
                >
                  <div className="flex items-center gap-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10 text-primary">
                      <Icon size={13} />
                    </span>
                    <span className="text-xs font-medium text-foreground">
                      {i + 1}. {title}
                    </span>
                  </div>
                  <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
                    {text}
                  </p>
                </div>
              ))}
            </div>
          </Block>

          <Block title="Recent meetings">
            {meetings.length ? (
              <div className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70 bg-card/50 dark:divide-border-subtle/50 dark:border-border-subtle dark:bg-surface-2/50">
                {meetings.slice(0, 4).map((m) => (
                  <MeetingRow
                    key={m.id}
                    s={m}
                    project={names.get(m.project_id ?? -1)}
                    onOpen={onOpenMeeting}
                  />
                ))}
                {meetingTotal > 4 && (
                  <button
                    type="button"
                    onClick={() => onNavigateSection("meetings")}
                    className="w-full px-4 py-2 text-xs text-primary/80 hover:text-primary"
                  >
                    See all {meetingTotal}
                  </button>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                None yet. Record a note during a call and the copilot listens along.
              </p>
            )}
          </Block>
        </div>
      </div>
    </div>
  );
}
