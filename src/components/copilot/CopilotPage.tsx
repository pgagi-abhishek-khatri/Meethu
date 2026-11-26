import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AudioLines, Brain, Code2, Folder, MessageSquareText, Settings2 } from "../icons";
import { Button } from "../ui/button";
import { Toggle } from "../ui/toggle";
import { SettingsGroup, SettingsRow, SettingsSection } from "../ui/SettingsSection";
import { MeetingTranscriptionPanel } from "../settings/MeetingSettings";
import { cn } from "../lib/utils";
import { BlurField, useCopilotSettings } from "./CopilotFields";
import CopilotSettingsTab, { DenoiseRow, OpenRouterKeySection } from "./CopilotSettingsTab";
import CopilotProjects from "./CopilotProjects";
import CopilotCodePanel from "./CopilotCodePanel";
import { WORKING } from "./copilotFormat";
import CopilotMeetings from "./CopilotMeetings";
import { Block, PaneHeader } from "./CopilotPane";
import { useMeetingAudio } from "./CopilotOverview";
import type { FileReferenceTarget, PastSession, Project } from "./copilotApi";

export type CopilotSection = "projects" | "code" | "meetings" | "behaviour" | "audio" | "settings";
type Section = CopilotSection;
const SECTIONS: { id: Section; label: string; icon: typeof Folder }[] = [
  { id: "projects", label: "Projects", icon: Folder },
  { id: "code", label: "Code", icon: Code2 },
  { id: "meetings", label: "Meetings", icon: MessageSquareText },
  { id: "behaviour", label: "Behaviour", icon: Brain },
  { id: "audio", label: "Audio & keys", icon: AudioLines },
  { id: "settings", label: "Settings", icon: Settings2 },
];

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

export default function CopilotPage({
  section: controlledSection,
  onSectionChange,
  onCountsChange,
  pendingRef,
  onClearPendingRef,
  pendingNavigation,
  onClearPendingNavigation,
}: {
  section?: CopilotSection;
  onSectionChange?: (section: CopilotSection) => void;
  onCountsChange?: (counts: { projects: number; meetings: number }) => void;
  pendingRef?: FileReferenceTarget | null;
  onClearPendingRef?: () => void;
  pendingNavigation?: { section: CopilotSection; meetingId?: string | null } | null;
  onClearPendingNavigation?: () => void;
} = {}) {
  const [uncontrolledSection, setUncontrolledSection] = useState<Section>("projects");
  const section = controlledSection ?? uncontrolledSection;
  const setSection = useCallback(
    (next: Section) => {
      if (onSectionChange) onSectionChange(next);
      else setUncontrolledSection(next);
    },
    [onSectionChange]
  );
  const [projects, setProjects] = useState<Project[]>([]);
  const [meetings, setMeetings] = useState<PastSession[]>([]);
  const [meetingCount, setMeetingCount] = useState<number | null>(null);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [meetingId, setMeetingId] = useState<string | null>(null);

  useEffect(() => {
    if (!pendingNavigation) return;
    setSection(pendingNavigation.section);
    setMeetingId(pendingNavigation.meetingId ?? null);
    onClearPendingNavigation?.();
  }, [pendingNavigation, setSection, onClearPendingNavigation]);

  useEffect(() => {
    if (!pendingRef) return;
    setSection("projects");
    if (pendingRef.projectId != null) {
      setProjectId(pendingRef.projectId);
    }
  }, [pendingRef, setSection]);

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
  useEffect(() => {
    onCountsChange?.({ projects: projects.length, meetings: meetingTotal });
  }, [onCountsChange, projects.length, meetingTotal]);
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
  const count: Partial<Record<Section, number>> = {
    projects: projects.length,
    meetings: meetingTotal,
  };

  const panes: Record<Section, ReactNode> = {
    projects: (
      <CopilotProjects
        list={projects}
        reload={loadProjects}
        selected={projectId}
        onSelect={setProjectId}
        pendingRef={pendingRef}
        onClearPendingRef={onClearPendingRef}
      />
    ),
    code: <CopilotCodePanel />,
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
    <div className="flex h-full min-h-0 flex-col">
      <nav
        aria-label="Copilot sections"
        className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/70 px-6 py-2 dark:border-white/8"
      >
        {SECTIONS.map(({ id, label, icon: Icon }) => {
          const on = id === section;
          return (
            <button
              key={id}
              type="button"
              aria-current={on ? "page" : undefined}
              onClick={() => go(id)}
              className={cn(
                "group flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-primary/30",
                on
                  ? "bg-primary/10 font-medium text-foreground dark:bg-primary/15"
                  : "text-foreground/75 hover:bg-foreground/4 hover:text-foreground dark:hover:bg-white/4"
              )}
            >
              <Icon
                size={14}
                className={cn(
                  "shrink-0",
                  on ? "text-primary" : "text-foreground/60 group-hover:text-foreground/85"
                )}
              />
              <span>{label}</span>
              {!!count[id] && (
                <span className="ms-0.5 text-[11px] tabular-nums text-muted-foreground">
                  {count[id]}
                </span>
              )}
            </button>
          );
        })}
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto px-8 pt-6 pb-10">
        <div className="max-w-[820px]">{panes[section]}</div>
      </div>
    </div>
  );
}
