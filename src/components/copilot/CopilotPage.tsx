import { useCallback, useEffect, useState } from "react";
import { Plus, RotateCcw, Trash2, X } from "../icons";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Toggle } from "../ui/toggle";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { PAGE_CONTENT_WIDTH_CLASS } from "../ui/pageWidth";
import { CARD_SURFACE_CLASS } from "../ui/surfaces";
import { SettingsGroup, SettingsRow, SettingsSection } from "../ui/SettingsSection";
import { cn } from "../lib/utils";
import { BlurField, useCopilotSettings } from "./CopilotFields";
import { PastMeeting, RecentsList } from "./PastMeetings";
import type { Project, ProjectFile, RuleKind } from "./copilotApi";

const RULE_LABELS: Record<RuleKind, string> = {
  meet_url: "Meeting link",
  title: "Title contains",
  domain: "Organizer domain",
};

const WORKING = new Set(["queued", "reading", "analysing", "embedding"]);
const sizeLabel = (b: number | null) =>
  b == null
    ? ""
    : b > 1048576
      ? `${(b / 1048576).toFixed(1)} MB`
      : `${Math.max(1, Math.round(b / 1024))} KB`;

// One file and how far the copilot got with it: working / ready (what it is) / failed (why, with Retry).
function FileRow({ f, run }: { f: ProjectFile; run: (p: Promise<unknown>) => void }) {
  const api = window.copilot!.projects;
  const working = WORKING.has(f.status);
  return (
    <div className="space-y-0.5 rounded-md border border-border/50 px-2.5 py-1.5 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-foreground" title={f.path}>
          {f.name}
        </span>
        <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
          {sizeLabel(f.bytes)}
          {f.status === "ready" && (
            <span className="text-emerald-600">Ready · {f.chunks} pieces</span>
          )}
          {working && <span className="animate-pulse text-sky-600">{f.stage ?? "Working…"}</span>}
          {f.status === "error" && (
            <button type="button" title="Try again" onClick={() => run(api.reindex(f.id))}>
              <RotateCcw size={12} />
            </button>
          )}
          <button type="button" title="Remove" onClick={() => run(api.removeFile(f.id))}>
            <X size={13} />
          </button>
        </span>
      </div>
      {f.status === "error" && <p className="text-destructive">{f.error}</p>}
      {f.status === "ready" && f.summary && <p className="text-muted-foreground">{f.summary}</p>}
      {f.note && <p className="text-amber-600">{f.note}</p>}
    </div>
  );
}

function ProjectCard({ p, reload }: { p: Project; reload: () => void }) {
  const [kind, setKind] = useState<RuleKind>("title");
  const [pattern, setPattern] = useState("");
  const api = window.copilot!.projects;
  const run = (f: Promise<unknown>) => f.then(reload);

  return (
    <div className={cn(CARD_SURFACE_CLASS, "space-y-3 p-4")}>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <BlurField label="Name" value={p.name} onSave={(name) => run(api.rename(p.id, name))} />
        </div>
        <label className="flex items-center gap-2 pb-2 text-xs text-foreground">
          Active
          <input
            type="checkbox"
            checked={p.active}
            onChange={(e) => run(api.setActive(p.id, e.target.checked))}
          />
        </label>
        <Button
          variant="ghost"
          size="icon"
          title="Delete project"
          onClick={() => confirm(`Delete "${p.name}"?`) && run(api.remove(p.id))}
        >
          <Trash2 size={14} />
        </Button>
      </div>
      <BlurField
        label="How should the copilot talk in this project"
        rows={3}
        value={p.instructions}
        onSave={(instructions) => run(api.update(p.id, { instructions }))}
      />
      <BlurField
        label="Standing notes: goals, prices, who is who"
        rows={4}
        value={p.plan}
        onSave={(plan) => run(api.update(p.id, { plan }))}
      />

      <div className="space-y-1.5">
        <p className="text-xs font-medium text-foreground">Files</p>
        {p.files.map((f) => (
          <FileRow key={f.id} f={f} run={run} />
        ))}
        <Button variant="outline" size="sm" onClick={() => run(api.addFiles(p.id))}>
          <Plus size={13} /> Add files
        </Button>
      </div>

      <div className="space-y-1.5">
        <p className="text-xs font-medium text-foreground">Calendar rules</p>
        {p.rules.map((r) => (
          <div
            key={r.id}
            className="flex items-center justify-between text-xs text-muted-foreground"
          >
            <span>
              {RULE_LABELS[r.kind]}: {r.pattern}
            </span>
            <button type="button" onClick={() => run(api.removeRule(r.id))}>
              <X size={13} />
            </button>
          </div>
        ))}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!pattern.trim()) return;
            void run(api.addRule(p.id, kind, pattern.trim()));
            setPattern("");
          }}
        >
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as RuleKind)}
            className="rounded border border-border/70 bg-input px-2 text-xs text-foreground"
          >
            {Object.entries(RULE_LABELS).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
          <Input value={pattern} onChange={(e) => setPattern(e.target.value)} className="h-8" />
          <Button type="submit" variant="outline" size="sm">
            Add
          </Button>
        </form>
      </div>
    </div>
  );
}

function Projects() {
  const [list, setList] = useState<Project[]>([]);
  const [name, setName] = useState("");
  const reload = useCallback(() => void window.copilot?.projects.list().then(setList), []);
  useEffect(reload, [reload]);
  // While a file is being read, the page follows it.
  const busy = list.some((p) => p.files.some((f) => WORKING.has(f.status)));
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(reload, 1500);
    return () => clearInterval(t);
  }, [busy, reload]);
  return (
    <div className="space-y-4">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          void window.copilot?.projects.create(name.trim()).then(reload);
          setName("");
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New project" />
        <Button type="submit">Create</Button>
      </form>
      {list.map((p) => (
        <ProjectCard key={p.id} p={p} reload={reload} />
      ))}
    </div>
  );
}

function Prompts() {
  const { settings: s, update } = useCopilotSettings();
  if (!s) return null;
  return (
    <div className="space-y-6">
      <SettingsSection
        title="Learned behaviour"
        description="Short and general: it applies to every project. The copilot rewrites it now and then from your Not helpful taps and the skipped questions you ask for. You can edit it."
      >
        <SettingsGroup>
          <BlurField
            label="How the copilot should behave"
            rows={6}
            value={s.behavior}
            onSave={(behavior) => update({ behavior })}
          />
        </SettingsGroup>
      </SettingsSection>
      <SettingsSection
        title="Global instructions"
        description="Used in every meeting, before any project's own."
      >
        <SettingsGroup>
          <BlurField
            label="How should the copilot talk"
            rows={4}
            value={s.instructions}
            onSave={(instructions) => update({ instructions })}
          />
          <BlurField
            label="Standing notes: goals, prices, who is who"
            rows={4}
            value={s.plan}
            onSave={(plan) => update({ plan })}
          />
        </SettingsGroup>
      </SettingsSection>
      <SettingsSection title="Start and end cards">
        <SettingsGroup>
          <BlurField
            label="Start prompt"
            rows={3}
            value={s.startPrompt}
            onSave={(startPrompt) => update({ startPrompt })}
          />
          <BlurField
            label="End prompt"
            rows={3}
            value={s.endPrompt}
            onSave={(endPrompt) => update({ endPrompt })}
          />
          <SettingsRow label="End-of-meeting recap card">
            <Toggle checked={s.endRecap} onChange={(endRecap) => update({ endRecap })} />
          </SettingsRow>
          <BlurField
            label="Closing prompt"
            rows={3}
            value={s.closingPrompt}
            onSave={(closingPrompt) => update({ closingPrompt })}
          />
          <SettingsRow label="Closing card" description="Lines to say when the call is ending.">
            <Toggle checked={s.closingCard} onChange={(closingCard) => update({ closingCard })} />
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}

function Past() {
  const [open, setOpen] = useState<string | null>(null);
  const [key, setKey] = useState(0);
  // The past-meeting components are styled for the dark copilot window, so they sit on a dark panel here.
  return (
    <div className="overflow-hidden rounded-lg bg-slate-900 p-3">
      {open ? (
        <PastMeeting
          id={open}
          onBack={() => setOpen(null)}
          onDeleted={() => {
            setOpen(null);
            setKey((k) => k + 1);
          }}
        />
      ) : (
        <RecentsList refreshKey={key} onPick={setOpen} />
      )}
    </div>
  );
}

export default function CopilotPage() {
  if (!window.copilot)
    return <p className="p-6 text-sm text-muted-foreground">Copilot is not available.</p>;
  return (
    <div className="h-full overflow-y-auto">
      <div className={cn(PAGE_CONTENT_WIDTH_CLASS, "py-4")}>
        <Tabs defaultValue="projects">
          <TabsList>
            <TabsTrigger value="projects">Projects</TabsTrigger>
            <TabsTrigger value="prompts">Prompts</TabsTrigger>
            <TabsTrigger value="past">Past meetings</TabsTrigger>
          </TabsList>
          <TabsContent value="projects">
            <Projects />
          </TabsContent>
          <TabsContent value="prompts">
            <Prompts />
          </TabsContent>
          <TabsContent value="past">
            <Past />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
