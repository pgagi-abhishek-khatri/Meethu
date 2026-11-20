import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  AudioLines,
  Brain,
  Check,
  ChevronRight,
  Folder,
  Home,
  MessageSquareText,
  Monitor,
  Settings2,
  Sparkles,
  Zap,
} from "../icons";
import { Button } from "../ui/button";
import { Toggle } from "../ui/toggle";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsGroup, SettingsRow, SettingsSection } from "../ui/SettingsSection";
import { MeetingTranscriptionPanel } from "../settings/MeetingSettings";
import { cn } from "../lib/utils";
import { useSettingsStore } from "../../stores/settingsStore";
import { fetchProviders } from "../../stores/streamingProvidersStore";
import { getMeetingStreamingTranscriptionProviders } from "../../models/ModelRegistry";
import { BlurField, useCopilotSettings } from "./CopilotFields";
import CopilotSettingsTab, { DenoiseRow, OpenRouterKeySection } from "./CopilotSettingsTab";
import CopilotProjects from "./CopilotProjects";
import { WORKING } from "./copilotFormat";
import CopilotMeetings, { MeetingRow } from "./CopilotMeetings";
import { Block, PaneHeader } from "./CopilotPane";
import type { PastSession, Project } from "./copilotApi";

type Section = "overview" | "projects" | "meetings" | "behaviour" | "audio" | "settings";
const SECTIONS: { id: Section; label: string; icon: typeof Home }[] = [
  { id: "overview", label: "Overview", icon: Home },
  { id: "projects", label: "Projects", icon: Folder },
  { id: "meetings", label: "Meetings", icon: MessageSquareText },
  { id: "behaviour", label: "Behaviour", icon: Brain },
  { id: "audio", label: "Audio & keys", icon: AudioLines },
  { id: "settings", label: "Settings", icon: Settings2 },
];

const PACE: Record<string, string> = {
  quiet: "Calm",
  normal: "Balanced",
  chatty: "Lively",
};

// The saved key each BYOK meeting provider authenticates with (Corti uses client credentials).
const MEETING_PROVIDER_KEY: Record<string, string> = {
  openai: "openaiApiKey",
  deepgram: "deepgramApiKey",
  assemblyai: "assemblyaiApiKey",
  soniox: "sonioxApiKey",
  tinfoil: "tinfoilApiKey",
};

// Whether a note recording can actually start with the chosen route, so the setup check never
// shows a green tick for audio that will fail at the first recording (no key, cloud unreachable).
function useMeetingAudio(): { label: string; ok: boolean; detail: string } {
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

function Overview({
  projects,
  meetings,
  meetingTotal,
  go,
  openMeeting,
}: {
  projects: Project[];
  meetings: PastSession[];
  meetingTotal: number;
  go: (s: Section) => void;
  openMeeting: (id: string) => void;
}) {
  const { settings: s, update } = useCopilotSettings();
  const audio = useMeetingAudio();
  if (!s) return null;
  const active = projects.filter((p) => p.active);
  const files = active.reduce((n, p) => n + p.files.filter((f) => f.status === "ready").length, 0);
  const indexing = projects.some((p) => p.files.some((f) => WORKING.has(f.status)));
  const names = new Map(projects.map((p) => [p.id, p.name]));

  return (
    <div className="space-y-7">
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
        <Button size="sm" variant="outline" onClick={() => void window.copilot?.openWindow?.()}>
          <Monitor size={13} className="me-1" /> Open window
        </Button>
        <Toggle
          checked={s.enabled}
          onChange={(enabled) => update({ enabled })}
          ariaLabel="Copilot on"
        />
      </div>

      <Block title="Setup">
        <div className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70 bg-card/50 dark:divide-border-subtle/50 dark:border-border-subtle dark:bg-surface-2/50">
          <CheckRow
            ok={s.hasKey}
            label="OpenRouter key"
            detail={s.hasKey ? (s.keyFromEnv ? "From .env" : "Saved") : "Needed to answer"}
            onClick={() => go("audio")}
          />
          <CheckRow
            ok={audio.ok}
            label="Meeting audio"
            detail={audio.detail}
            onClick={() => go("audio")}
          />
          <CheckRow
            ok={active.length > 0}
            label="Projects"
            detail={
              active.length
                ? `${active.length} in use · ${files} file${files === 1 ? "" : "s"} ready${indexing ? " · reading…" : ""}`
                : "Optional: add your material"
            }
            onClick={() => go("projects")}
          />
        </div>
      </Block>

      <Block title="How it works">
        <div className="grid grid-cols-2 gap-2.5 @3xl:grid-cols-4">
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
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">{text}</p>
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
                onOpen={openMeeting}
              />
            ))}
            {meetingTotal > 4 && (
              <button
                type="button"
                onClick={() => go("meetings")}
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
  );
}

function Behaviour() {
  const { settings: s, update } = useCopilotSettings();
  if (!s) return null;
  return (
    <div className="space-y-6">
      <PaneHeader
        title="Behaviour"
        description="What the copilot makes cards about and how it talks, in every meeting."
      />
      <SettingsSection
        title="Learned guide"
        description="Rewritten now and then from your Not helpful taps and the skipped moments you ask for. Short and general; you can edit it."
      >
        <SettingsGroup>
          <BlurField
            rows={6}
            value={s.behavior}
            placeholder="Nothing learned yet."
            onSave={(behavior) => update({ behavior })}
          />
        </SettingsGroup>
      </SettingsSection>
      <SettingsSection
        title="Global context"
        description="Used in every meeting, before the project's own briefing."
      >
        <SettingsGroup>
          <BlurField
            label="Who you are and how to talk"
            rows={4}
            value={s.instructions}
            placeholder="e.g. I am a sales lead. Answer in short English. Point out risks in what the client says."
            onSave={(instructions) => update({ instructions })}
          />
          <BlurField
            label="Standing notes"
            rows={4}
            value={s.plan}
            placeholder="Goals, prices, who is who…"
            onSave={(plan) => update({ plan })}
          />
        </SettingsGroup>
      </SettingsSection>
      <SettingsSection title="Start and end of a meeting">
        <SettingsGroup>
          <BlurField
            label="Start card (runs when you wrote notes for the meeting)"
            rows={2}
            value={s.startPrompt}
            placeholder="Remind me of the goals and the points to cover."
            onSave={(startPrompt) => update({ startPrompt })}
          />
          <SettingsRow label="Closing card" description="Lines to say when the call is ending.">
            <Toggle checked={s.closingCard} onChange={(closingCard) => update({ closingCard })} />
          </SettingsRow>
          {s.closingCard && (
            <BlurField
              rows={2}
              value={s.closingPrompt}
              onSave={(closingPrompt) => update({ closingPrompt })}
            />
          )}
          <SettingsRow label="Recap card when the meeting ends">
            <Toggle checked={s.endRecap} onChange={(endRecap) => update({ endRecap })} />
          </SettingsRow>
          {s.endRecap && (
            <BlurField
              rows={2}
              value={s.endPrompt}
              placeholder="Wrap up: decisions, open questions and next steps."
              onSave={(endPrompt) => update({ endPrompt })}
            />
          )}
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}

function AudioAndKeys() {
  return (
    <div className="space-y-6">
      <PaneHeader
        title="Audio & keys"
        description="How meeting audio is transcribed for the copilot, and the key it answers with."
      />
      <OpenRouterKeySection />
      <SettingsSection
        title="Meeting transcription"
        description="The same engine as note recordings. Streaming providers like Soniox need their own key here."
      >
        <MeetingTranscriptionPanel />
      </SettingsSection>
      <SettingsSection title="Microphone">
        <SettingsGroup>
          <DenoiseRow />
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}

export default function CopilotPage() {
  const [section, setSection] = useState<Section>("overview");
  const [projects, setProjects] = useState<Project[]>([]);
  const [meetings, setMeetings] = useState<PastSession[]>([]);
  const [meetingCount, setMeetingCount] = useState<number | null>(null);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [meetingId, setMeetingId] = useState<string | null>(null);

  const loadProjects = useCallback(
    () => void window.copilot?.projects.list().then(setProjects),
    []
  );
  const loadMeetings = useCallback(() => {
    void window.copilot?.sessions.list().then(setMeetings, () => {});
    void window.copilot?.sessions.count?.().then(setMeetingCount, () => {});
  }, []);
  useEffect(() => {
    loadProjects();
    loadMeetings();
  }, [loadProjects, loadMeetings]);
  // A meeting can end while the page is open (the bridge here has no events): look again when the window
  // comes back to the front, and now and then while it stays open.
  useEffect(() => {
    const refresh = () => document.visibilityState === "visible" && loadMeetings();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const t = setInterval(refresh, 30_000);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      clearInterval(t);
    };
  }, [loadMeetings]);
  const meetingTotal = Math.max(meetingCount ?? 0, meetings.length);
  // While a file is being read, the page follows it.
  const busy = projects.some((p) => p.files.some((f) => WORKING.has(f.status)));
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(loadProjects, 1500);
    return () => clearInterval(t);
  }, [busy, loadProjects]);

  if (!window.copilot)
    return <p className="p-6 text-sm text-muted-foreground">Copilot is not available.</p>;

  const go = (s: Section) => {
    if (s === "meetings") {
      loadMeetings();
      setMeetingId(null); // the nav and "See all" land on the list, not on a stale open meeting
    }
    setSection(s);
  };
  const openMeeting = (id: string) => {
    setMeetingId(id);
    setSection("meetings");
  };
  const count: Partial<Record<Section, number>> = {
    projects: projects.length,
    meetings: meetingTotal,
  };

  const panes: Record<Section, ReactNode> = {
    overview: (
      <Overview
        projects={projects}
        meetings={meetings}
        meetingTotal={meetingTotal}
        go={go}
        openMeeting={openMeeting}
      />
    ),
    projects: (
      <CopilotProjects
        list={projects}
        reload={loadProjects}
        selected={projectId}
        onSelect={setProjectId}
      />
    ),
    meetings: (
      <CopilotMeetings
        list={meetings}
        total={meetingTotal}
        projects={projects}
        reload={loadMeetings}
        open={meetingId}
        onOpen={setMeetingId}
      />
    ),
    behaviour: <Behaviour />,
    audio: <AudioAndKeys />,
    settings: (
      <div className="space-y-6">
        <PaneHeader
          title="Settings"
          description="Pace, window, models, project file search and how long meetings are kept."
        />
        <CopilotSettingsTab embedded />
      </div>
    ),
  };

  return (
    <div className="@container flex h-full min-h-0">
      <nav
        aria-label="Copilot"
        className="flex w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-e border-border/70 px-2 pt-3 pb-3 @max-2xl:hidden dark:border-white/8"
      >
        <div className="px-2.5 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
          Copilot
        </div>
        {SECTIONS.map(({ id, label, icon: Icon }) => {
          const on = id === section;
          return (
            <button
              key={id}
              type="button"
              aria-current={on ? "page" : undefined}
              onClick={() => go(id)}
              className={cn(
                "group flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-start outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-primary/30",
                on
                  ? "bg-primary/8 dark:bg-primary/10"
                  : "hover:bg-foreground/4 active:bg-foreground/6 dark:hover:bg-white/4"
              )}
            >
              <Icon
                size={15}
                className={cn(
                  "shrink-0",
                  on ? "text-primary" : "text-foreground/60 group-hover:text-foreground/85"
                )}
              />
              <span
                className={cn(
                  "truncate text-[12.5px]",
                  on ? "font-medium text-foreground" : "text-foreground/85"
                )}
              >
                {label}
              </span>
              {!!count[id] && (
                <span className="ms-auto text-[11px] tabular-nums text-muted-foreground">
                  {count[id]}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="px-5 pt-6 pb-2 @2xl:hidden">
          <Select value={section} onValueChange={(v) => go(v as Section)}>
            <SelectTrigger className="h-8 w-full rounded-lg text-xs" aria-label="Copilot section">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SECTIONS.map(({ id, label }) => (
                <SelectItem key={id} value={id}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-8 pt-6 pb-10 @max-2xl:px-5">
          <div className="max-w-[760px]">
            {section === "overview" && <PaneHeader title="Meeting copilot" />}
            <div className={section === "overview" ? "mt-4" : ""}>{panes[section]}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
