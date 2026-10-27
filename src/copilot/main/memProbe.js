// Memory log: while a meeting runs, every `intervalMs` a short readable entry in `copilot-memory.log` shows how much RAM
// the app and each of its windows use and how big everything the copilot keeps has grown, so a meeting that eats RAM shows
// WHICH thing grows. Electron-free (process figures come in through `metrics`). The file is cut when it passes MAX_BYTES.
const fs = require("fs");
const path = require("path");

const MAX_BYTES = 1024 * 1024;
const PROCESS_NAMES = {
  Tab: "window",
  Browser: "app shell",
  GPU: "graphics",
  Utility: "helper",
  Zygote: "helper",
};
const COPILOT_NAMES = {
  transcript: "transcript lines",
  cards: "recent cards",
  jobs: "running answers",
  side: "side answers",
  queue: "queued answers",
  specs: "re-askable cards",
  asked: "remembered questions",
  skipped: "skipped box",
  callMs: "timing samples",
  jobThread: "answers in threads",
};
const mb = (bytes) => Math.round(bytes / 1048576);
const clock = (t) => new Date(t).toTimeString().slice(0, 8);

// first = the first reading of this meeting; shows what grew since.
function describe({ at, started, rss, heap, external, copilot, processes, first }) {
  const lines = [
    `${clock(at)}  meeting running ${Math.max(0, Math.round((at - started) / 60000))} min`,
  ];
  const growth = first ? rss - first.rss : 0;
  lines.push(
    `  memory   app ${mb(rss)} MB${first ? ` (${growth >= 0 ? "+" : ""}${mb(growth)} MB since the start)` : ""} · code ${mb(heap)} MB · buffers ${mb(external)} MB`
  );
  if (processes?.length)
    lines.push(
      `  windows  ${processes
        .slice()
        .sort((a, b) => b.workingSetMB - a.workingSetMB)
        .slice(0, 4)
        .map((p) => `${PROCESS_NAMES[p.type] ?? p.type} ${p.workingSetMB} MB`)
        .join(" · ")}`
    );
  const keep = Object.entries(copilot)
    .filter(([k, v]) => COPILOT_NAMES[k] && v > 0) // what is empty is not worth a word
    .map(([k, v]) => `${COPILOT_NAMES[k]} ${v}`)
    .join(" · ");
  lines.push(`  copilot  ${keep}`);
  if (first) {
    const grew = Object.entries(copilot)
      .filter(
        ([k, v]) =>
          COPILOT_NAMES[k] && v > (first.copilot[k] ?? 0) * 1.5 && v - (first.copilot[k] ?? 0) >= 20
      )
      .map(([k, v]) => `${COPILOT_NAMES[k]} ${first.copilot[k] ?? 0} → ${v}`);
    if (grew.length) lines.push(`  growing  ${grew.join(" · ")}`);
  }
  return lines.join("\n");
}

function startMemProbe({ dir, engine, metrics = () => null, intervalMs = 30000, now = Date.now }) {
  if (!dir) return { stop() {}, sample: () => null };
  const file = path.join(dir, "copilot-memory.log");
  let first = null;
  let started = null;
  const sample = () => {
    const copilot = engine.memory();
    if (!copilot) return (first = started = null); // no meeting: nothing worth a line
    const m = process.memoryUsage();
    const at = now();
    started ??= at;
    const reading = {
      at,
      started,
      rss: m.rss,
      heap: m.heapUsed,
      external: m.external,
      copilot,
      processes: metrics(),
    };
    const text = describe({ ...reading, first });
    first ??= reading;
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) fs.rmSync(file);
      fs.appendFileSync(file, `${text}\n\n`);
    } catch {}
    return text;
  };
  const timer = setInterval(sample, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer), sample };
}

module.exports = { startMemProbe, describe };
