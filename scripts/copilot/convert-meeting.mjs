// Converts a saved meeting transcript (copilot-logs/older-meetings/*.json: {metadata, speakers, segments:
// [{speaker, timestamp(s), text}]}) into the replay trace format that replay-fast.mjs reads:
//   node scripts/copilot/convert-meeting.mjs [--minutes 20] <meeting.json>... > or --out-dir copilot-logs/converted
// "You" is the mic (the user); every other speaker is the system stream, "Speaker 3" -> speaker "system:3".
// File order is arrival order, but the clocks are mixed: "You" segments often carry a wall-clock epoch (ms) or
// another clock. So the other speakers' seconds are the meeting clock (kept while they only move forward), and a
// "You" line, or anything off that clock, sits just after the line before it. Files with no segments are skipped.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const arg = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const maxSeconds = arg("--minutes") ? Number(arg("--minutes")) * 60 : Infinity;
const outDir = arg("--out-dir") ?? "copilot-logs/converted";
const files = args.filter((a) => a.endsWith(".json"));
fs.mkdirSync(outDir, { recursive: true });

for (const file of files) {
  const meeting = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(meeting.segments)) continue;
  const base = Date.parse("2026-01-01T09:00:00Z");
  const rows = [];
  let last = 0;
  for (const seg of meeting.segments) {
    const text = String(seg.text ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    const you = seg.speaker === "You";
    const ts = typeof seg.timestamp === "number" ? seg.timestamp : NaN;
    // The meeting clock: another speaker's seconds, never going backwards or jumping past an hour.
    const onClock = !you && ts >= last - 1 && ts < last + 3600;
    last = onClock ? Math.max(last, ts) : last + 0.4;
    if (last > maxSeconds) break;
    const n = /(\d+)\s*$/.exec(seg.speaker ?? "")?.[1];
    rows.push({
      at: new Date(base + last * 1000).toISOString(),
      type: "segment",
      source: you ? "mic" : "system",
      speaker: you ? undefined : `system:${n ?? 1}`,
      text,
    });
  }
  const name = path
    .basename(file, ".json")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  fs.writeFileSync(
    path.join(outDir, `${name}.jsonl`),
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n"
  );
  console.log(name, rows.length, "segments", Math.round(last / 60), "min");
}
