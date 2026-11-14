# File profiles vs two-call D1: the arm experiment

Question: does the decider (D1) judge "does this moment need the project files?" better with a richer catalog,
and is a second D1 call for that judgement worth it? Three arms replay the same recorded meeting:

| Arm | Catalog D1 / answer / query writer sees | How the file search is triggered |
|---|---|---|
| A0 | today's summary (first sentence, 100 chars) | one D1 call, `needs_project` in it |
| P | file profiles (`src/copilot/rag/profile.js`), 4000 / 6000 / 1600 chars split by file size | one D1 call, `needs_project` in it |
| T | today's summary | D1 judges the card alone; when a card runs, a second D1 call asks `needs_project` while the query writer already writes; not needed → its queries go to the answer model |

Switches (default = A0 behaviour): `COPILOT_CATALOG=profile`, `COPILOT_RAG_TRIGGER=twoCall`.

## Steps

All commands run under Electron's Node (`ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe …`)
because they open `copilot.db`. `RAG` is a folder holding a copy of `copilot.db` with the project's files indexed.

1. **Profiles** (no file is read or embedded again; ~$0.12 for the CarZilla files):
   `scripts/copilot/profile-backfill.js $RAG/copilot.db --out $RAG/profiles`
   Read `$RAG/profiles/catalog-views.json` to see exactly what each reader gets in each mode.
2. **Meeting**: record it with `COPILOT_LOG=1`; the session trace in `<logDir>/sessions/session-*.jsonl` is the
   replay input (its `segment` rows). Segment ids are 1-based in that order, the same ids the engine uses.
3. **Labels** (strong model, reads the files' full text, never the profiles; ~$0.30):
   `scripts/copilot/label-moments.mjs --rag $RAG --out labels.json meeting.jsonl`
   Check them by hand: every later number is only as good as these.
4. **Runs**, 3 per arm (latency varies run to run):
   `scripts/copilot/arm-run.mjs --arm A0|P|T --rag $RAG --out runs/P-1.json meeting.jsonl`
5. **Report**: `node scripts/copilot/arm-report.mjs --labels labels.json --judge --out report.md runs/*.json`

## What the report measures

- **D1 asked: recall / false**: of the cards on moments the labels say need the files, how many D1 sent to the
  files; of the cards that don't, how many it sent anyway (over-triggering).
- **attached**: the same for passages actually reaching the card (includes the unasked look at 0.69 in A0/P).
- **right file**, **correct** (`--judge`: correct / partial / wrong / missing against the labelled answer).
- **searches (wasted)**: searches that attached nothing.
- **cost** per run and per meeting-hour, by model; **latency** real milliseconds: D1 call, gate call, and
  moment → card done (`e2eMs` = D1 call + decision → card).

Decision rule, fixed before the runs: best file-moment accuracy whose p95 card latency is at most baseline
+ 0.5 s and whose cost is at most 1.5× baseline; ties go to fewer calls.
