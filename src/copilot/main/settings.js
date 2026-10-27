// Copilot settings: a small JSON file in userData. The API key is kept apart and encrypted with the
// OS keychain (Electron safeStorage) when there is one; the renderer never receives it, only `hasKey`.
const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  enabled: true, // the copilot listens to meetings and may show cards (needs a key)
  autoOpen: true, // open the window when a meeting recording starts
  idleMode: "orb", // how it opens: "orb" (a small button that peeks when something is ready) or "full" (the whole panel)
  peekSeconds: 8, // how long a new card stays up beside the orb
  onEnd: "close", // when the meeting stops: "close" the window, shrink it to the "orb", or "keep" it as it is
  mainModel: "", // "" = built-in default
  deepModel: "", // the "Rerun with high effort" model ("" = built-in)
  summaryModel: "",
  web: false, // search the web in the quick answers (slower); "Go deeper" always does
  quiet: "normal", // quiet | normal | chatty: how readily the copilot speaks up unasked
  behavior: "", // learned, global: what to make cards about and how (rewritten rarely from the user's feedback; editable)
  instructions: "", // standing instructions: how to analyse meetings, tone, language ...
  plan: "", // notes for the coming meeting (agenda, to-dos); a plan makes a "before the meeting" card
  startPrompt: "", // what to suggest at the start ("" = built-in)
  endPrompt: "", // what to suggest at the end ("" = built-in)
  endRecap: true,
  closingCard: true, // when the call is ending, a card with lines to say to close it
  closingPrompt: "", // what the closing card should do ("" = built-in)
  autoProject: true, // pick the project from the calendar event (title, organizer domain, Meet link)
  ragEnabled: true, // index project files and search them during meetings
  embedModel: "", // "" = google/gemini-embedding-2
  analysisModel: "", // "" = google/gemini-3.8-flash (reads PDFs, images, audio, video; writes the file summaries)
  mediaEmbedMinutes: 5, // per audio/video file: how long it is embedded as sound/picture (costly); after that, from its transcript
  maxParallel: 2,
  hotkey: "CommandOrControl+Alt+C", // shows / hides the window ("" = none)
  opacity: 1,
  fadeWhenIdle: false, // the full panel is translucent until the mouse is over it or a card arrives
  retentionDays: 90, // 0 = keep forever
  window: { expanded: false, compact: null, expandedBounds: null, orb: null },
};

const LIMITS = {
  quiet: ["quiet", "normal", "chatty"],
  idleMode: ["orb", "full"],
  onEnd: ["close", "orb", "keep"],
};

function sanitize(patch, current) {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (!(key in patch)) continue;
    const v = patch[key];
    const d = DEFAULTS[key];
    if (typeof d === "boolean") out[key] = !!v;
    else if (key === "quiet") out[key] = LIMITS.quiet.includes(v) ? v : current.quiet;
    else if (key === "idleMode" || key === "onEnd")
      out[key] = LIMITS[key].includes(v) ? v : current[key];
    else if (key === "peekSeconds")
      out[key] = Math.min(60, Math.max(3, Math.round(Number(v)) || d));
    else if (key === "mediaEmbedMinutes")
      out[key] = Math.min(240, Math.max(0, Math.round(Number(v)) || 0));
    else if (key === "maxParallel") out[key] = Math.min(6, Math.max(1, Math.round(Number(v)) || d));
    else if (key === "opacity") out[key] = Math.min(1, Math.max(0.3, Number(v) || 1));
    else if (key === "retentionDays") out[key] = Math.max(0, Math.round(Number(v)) || 0);
    else if (key === "window")
      out[key] = { ...current.window, ...(v && typeof v === "object" ? v : {}) };
    else if (typeof d === "string") out[key] = String(v ?? "").slice(0, 8000);
  }
  return out;
}

function createSettings({ dir, safeStorage = null, env = process.env }) {
  const file = path.join(dir, "copilot-settings.json");
  const keyFile = path.join(dir, "copilot-key.bin");
  const read = () => {
    try {
      return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, "utf8")) };
    } catch {
      return { ...DEFAULTS };
    }
  };
  let values = read();

  const readKey = () => {
    try {
      const raw = fs.readFileSync(keyFile);
      if (safeStorage?.isEncryptionAvailable?.()) return safeStorage.decryptString(raw);
      return raw.toString("utf8");
    } catch {
      return "";
    }
  };
  const writeKey = (key) => {
    fs.mkdirSync(dir, { recursive: true });
    if (!key) return fs.rmSync(keyFile, { force: true });
    const data = safeStorage?.isEncryptionAvailable?.()
      ? safeStorage.encryptString(key)
      : Buffer.from(key, "utf8");
    fs.writeFileSync(keyFile, data, { mode: 0o600 });
  };
  let apiKey = readKey();

  const save = () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(values, null, 2));
  };

  return {
    // What the engine reads: the saved key wins over the .env one (development).
    engine: () => ({ ...values, apiKey: apiKey || (env.OPENROUTER_API_KEY ?? "").trim() }),
    // What the window reads: never the key itself.
    view: () => ({
      ...values,
      hasKey: !!(apiKey || (env.OPENROUTER_API_KEY ?? "").trim()),
      keyFromEnv: !apiKey && !!env.OPENROUTER_API_KEY,
    }),
    update(patch = {}) {
      values = { ...values, ...sanitize(patch, values) };
      if (typeof patch.apiKey === "string") {
        apiKey = patch.apiKey.trim();
        writeKey(apiKey);
      }
      save();
      return this.view();
    },
  };
}

module.exports = { createSettings, DEFAULTS };
