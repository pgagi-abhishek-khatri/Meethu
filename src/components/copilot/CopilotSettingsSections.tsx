import { useCallback, useEffect, useState } from "react";
import { SettingsGroup, SettingsRow, SettingsSection } from "../ui/SettingsSection";
import { Toggle } from "../ui/toggle";
import { MeetingTranscriptionPanel } from "../settings/MeetingSettings";
import { BlurField, useCopilotSettings } from "./CopilotFields";
import { DenoiseRow, OpenRouterKeySection } from "./CopilotSettingsTab";
import { PaneHeader } from "./CopilotPane";
import CopilotProjects from "./CopilotProjects";
import { WORKING } from "./copilotFormat";
import type { FileReferenceTarget, Project } from "./copilotApi";

export function CopilotBehaviourSection() {
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

export function CopilotAudioSection() {
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

export function CopilotProjectsView({
  pendingRef,
  onClearPendingRef,
}: {
  pendingRef?: FileReferenceTarget | null;
  onClearPendingRef?: () => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<number | null>(null);

  const loadProjects = useCallback(
    () => void window.copilot?.projects.list().then(setProjects, () => {}),
    []
  );

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    if (pendingRef?.projectId != null) {
      setProjectId(pendingRef.projectId);
    }
  }, [pendingRef]);

  const busy = projects.some((p) => p.files.some((f) => WORKING.has(f.status)));
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(loadProjects, 1500);
    return () => clearInterval(t);
  }, [busy, loadProjects]);

  if (!window.copilot) {
    return <p className="p-6 text-sm text-muted-foreground">Projects are not available.</p>;
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-8 pt-6 pb-10">
      <div className="max-w-[820px]">
        <CopilotProjects
          list={projects}
          reload={loadProjects}
          selected={projectId}
          onSelect={setProjectId}
          pendingRef={pendingRef}
          onClearPendingRef={onClearPendingRef}
        />
      </div>
    </div>
  );
}
