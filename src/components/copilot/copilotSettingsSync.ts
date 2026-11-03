// The copilot settings shared by every component on the page. Updates apply optimistically; only the
// answer to the newest update is published, and a load that started before an update never undoes it.
import type { CopilotSettings } from "./copilotApi";

export type SettingsPatch = Partial<CopilotSettings> & { apiKey?: string };

interface SettingsApi {
  getSettings(): Promise<CopilotSettings>;
  updateSettings(patch: SettingsPatch): Promise<CopilotSettings>;
}

export function createSettingsSync(api: () => SettingsApi | undefined) {
  let shared: CopilotSettings | null = null;
  let seq = 0; // bumped by every update; an answer from before the newest update is stale
  const listeners = new Set<(s: CopilotSettings | null) => void>();
  const publish = (s: CopilotSettings | null) => {
    shared = s;
    listeners.forEach((l) => l(s));
  };
  const accept = (at: number) => (s: CopilotSettings) => {
    if (at === seq) publish(s);
  };
  return {
    get: () => shared,
    subscribe(l: (s: CopilotSettings | null) => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    load() {
      return api()
        ?.getSettings()
        .then(accept(seq), () => {});
    },
    update(patch: SettingsPatch) {
      const at = ++seq;
      const { apiKey: _key, ...rest } = patch;
      if (shared) publish({ ...shared, ...rest });
      return api()
        ?.updateSettings(patch)
        .then(accept(at), () => {
          // the update failed: show what main really holds
          if (at === seq) void this.load();
        });
    },
  };
}
