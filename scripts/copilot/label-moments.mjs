// Ground truth for the arm experiment: a strong model reads the whole meeting and the full text of the
// project's files (the stored chunks, never the profiles, so no arm is favoured) and labels every moment worth
// a card: does it need the files, which file and page answer it, and what the answer is.
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/copilot/label-moments.mjs --rag <dir> --out labels.json <meeting.jsonl>
// LABEL_MODEL picks the model (default anthropic/claude-opus-5.5). Review the labels by hand before trusting them.
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
require("dotenv").config({ path: path.join(root, ".env"), quiet: true });
const { openStore } = require(path.join(root, "src/copilot/main/store"));
const { postJson } = require(path.join(root, "src/copilot/rag/openrouter"));

const args = process.argv.slice(2);
const arg = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const ragDir = arg("--rag");
const outFile = arg("--out");
const meetingFile = args.find((a) => a.endsWith(".jsonl"));
const model = process.env.LABEL_MODEL || "anthropic/claude-opus-5.5";
if (!ragDir || !outFile || !meetingFile)
  throw new Error("usage: label-moments.mjs --rag <dir> --out <labels.json> <meeting.jsonl>");

// Segment ids are the engine's: 1-based, in order, empty lines left out.
const segs = fs
  .readFileSync(meetingFile, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l))
  .filter((r) => r.type === "segment" && String(r.text ?? "").trim())
  .map((r, i) => ({
    id: i + 1,
    who: r.source === "mic" ? "USER" : `OTHER-${String(r.speaker ?? "1").replace(/\D/g, "") || 1}`,
    text: r.text.replace(/\s+/g, " ").trim(),
  }));

const store = openStore({ dbPath: path.join(ragDir, "copilot.db") });
const files = store.projects
  .list()
  .flatMap((p) => p.files.filter((f) => f.status === "ready"))
  .map((f) => {
    const chunks = store.rag.fileChunks(f.id);
    let page = null;
    const text = chunks
      .map((c) => {
        const marker =
          c.meta.page != null && c.meta.page !== page ? `[[page ${(page = c.meta.page)}]]\n` : "";
        return marker + c.text;
      })
      .join("\n");
    return { name: f.name, text };
  });
store.close();

const system = `You label a recorded meeting for an experiment on a meeting assistant. The assistant listens and shows short help cards to the USER. It can look things up in the USER's project files (given below in full).

For every moment in the transcript that deserves a card (a question, a fact, number, rule, plan, feature, decision or claim about the subject; NOT small talk, acknowledgements, audio checks or running the meeting), output one entry:
- segIds: the segment ids the moment spans (usually 1-3 consecutive ids)
- needsFiles: true when the project files hold facts that answer, confirm or correct what is said there; false when general knowledge is enough or the files say nothing about it
- file: the file name that holds the answer (exact name), or null
- pages: the page numbers holding it, [] if none
- answer: when needsFiles, the fact from the files in at most 30 words with its exact numbers; else null
- strength: "must" when a card would be clearly wrong or useless without the files, "helps" when the files only add detail
- note: at most 12 words on why

Be strict: needsFiles only when you found the fact in the file text. Moments not listed are treated as not worth a card.
Return one JSON object: { "moments": [ ... ] } and nothing else.`;

const user = `PROJECT FILES\n\n${files.map((f) => `===== FILE: ${f.name}\n${f.text}`).join("\n\n")}\n\nMEETING TRANSCRIPT (id | speaker | text)\n${segs.map((s) => `${s.id} | ${s.who} | ${s.text}`).join("\n")}`;

const t = Date.now();
const res = await postJson(
  "/chat/completions",
  {
    model,
    max_tokens: 16000,
    temperature: 0,
    usage: { include: true },
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  },
  { apiKey: process.env.OPENROUTER_API_KEY, timeoutMs: 600000, retries: 1 }
);
const text = String(res.choices?.[0]?.message?.content ?? "");
const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
const valid = new Set(files.map((f) => f.name));
const moments = (json.moments ?? []).map((m) => ({
  segIds: (m.segIds ?? []).map(Number).filter((n) => n >= 1 && n <= segs.length),
  needsFiles: !!m.needsFiles,
  file: valid.has(m.file) ? m.file : null,
  pages: (m.pages ?? []).map(Number).filter(Number.isFinite),
  answer: m.answer ?? null,
  strength: m.strength ?? null,
  note: m.note ?? null,
  text: (m.segIds ?? [])
    .map((id) => segs[id - 1]?.text)
    .filter(Boolean)
    .join(" ")
    .slice(0, 300),
}));
fs.writeFileSync(
  outFile,
  JSON.stringify(
    {
      meeting: path.basename(meetingFile),
      model,
      segments: segs.length,
      ms: Date.now() - t,
      usage: res.usage,
      moments,
    },
    null,
    1
  )
);
console.log(
  `${moments.length} moments (${moments.filter((m) => m.needsFiles).length} need files) from ${segs.length} segments, $${Number(res.usage?.cost ?? 0).toFixed(3)}, ${Math.round((Date.now() - t) / 1000)} s -> ${outFile}`
);
process.exit(0);
