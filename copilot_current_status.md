# Live Meeting Copilot: current status

As of 2026-10-14. Companion to `copilot_implementation_brief.md` (the plan). This file says what exists in the code today, where it differs from the plan, and what is left. Detail docs are in `docs/copilot/`.

## 1. Summary

- The copilot is built and runs inside OpenWhispr as its own window, its own sidebar page and its own settings tab.
- Everything is **uncommitted** on `main` (about 49 changed or new paths). New code lives in `src/copilot/`, `src/components/copilot/`, `test/copilot/`, `scripts/copilot/`, `docs/copilot/`.
- Core loop works: live transcript → decider → answer card → project-file search (RAG) → recap.
- Brief phases 10 to 14 are not built (talking-points checklist, commitments list, Google Docs, auto thread routing, screen-share detection).
- Main deviations from the brief: all models go through **OpenRouter**, the router is a probability-based "decider" and not a JSON router, and RAG uses its own SQLite index and not Qdrant.

## 2. Architecture

```
meeting audio (mic + system) → STT provider (Soniox) → OpenWhispr meeting pipeline
        │ final / partial segments (copilot.onFinal / onPartial hooks in ipcHandlers.js)
        ▼
utterance preprocessing (merge cut-up slices, drop backchannel)   core/transcript/utterances.js
        ▼
scheduler: wait for the speaker's turn to end                    core/trigger/scheduler.js
        ▼
D1 decider (small, fast model) → act / chatter / help / needs_*  core/decision/
        │ also: prefetch the project-search query embedding while D1 runs
        ▼
context pack (budgeted) → answer model → streamed card          core/answer/, main/answerRunner.js
        ▲  summary • notes/plan • project catalog + passages (RAG) • thread history
        ▼
verifier → card (or silent skip) → UI feed / "Skipped" box
```

| Folder | Role |
|---|---|
| `src/copilot/core/` | Pure logic, no Electron: decision, trigger, answer, summary, transcript |
| `src/copilot/main/` | `engine.js` (orchestrator), `service.js` (wiring, IPC), `store.js` (own `copilot.db`), `settings.js`, `window.js`, `answerRunner.js`, `mainCall.js`, `behavior.js`, `memProbe.js` |
| `src/copilot/rag/` | Project-file search (section 4) |
| `src/copilot/prompts/main.js` | Answer prompt (locked format plus user instructions) |
| `src/components/copilot/` | React UI: orb, cards, transcript, context, settings, page |
| `scripts/copilot/` | Benchmarks and replay tools (decision, card quality, RAG, latency) |

Engine hooks into OpenWhispr are small: `this.copilot?.onFinal / onPartial / begin / endSession`, the `copilot` hotkey slot (default `Ctrl+Alt+C`), and the `?copilot=true` route.

### Models (all via OpenRouter, one key in Copilot settings, encrypted with safeStorage)

| Role | Default |
|---|---|
| Decider (D1) | Liquid-style "System One" endpoint: returns probabilities for several yes/no questions |
| Answer, fast tier | `qwen/qwen3.8-27b-20260814:nitro`, reasoning off, 320 tokens max |
| "Rerun with high effort" | `anthropic/claude-sonnet-5.5`, web search on, 5 to 8 bullets, 1200 tokens |
| Summary | cheap model, runs every ~15 new messages, at most every 30 s |
| RAG reader / embedder | `google/gemini-3.8-flash` / `google/gemini-embedding-2` |

Each model can be overridden in settings or with env vars (`COPILOT_AI_MODEL`, `COPILOT_DEEP_MODEL`, `COPILOT_SUMMARY_MODEL`).

## 3. What is built

| Area | State |
|---|---|
| Soniox meeting STT (phase 0a/1) | Done in code. Token stream → segments, region option, reconnect, 290 min session limit, keepalive, optional `providerSpeaker` label. Tested against a mock server. **Not yet tested with a real Soniox key.** |
| Decider (phase 2) | Done. Score is `act × (1 − chatter) × help`, normal bar 0.5, separate bars for web, project, past meetings and screenshot. Offline bench: recall about 93%, precision about 95%. The label noise ceiling is about 93 to 95%. |
| Turn-based triggering | Done. D1 runs at turn end (gap 1.5 s, 0.3 s for a question, 20 s cap), skips while another call runs, and spaces calls wider after 6 empty decisions. Replay: 170 → 114 decider calls on a 25 min meeting. |
| Answer cards (phase 3) | Done. Streamed, 2 to 4 first-person bullets, up to 2 follow-up chips, confidence gate (low-confidence proactive cards dropped), SKIP reply, verifier. Typed questions run in parallel (`maxParallel` 2). |
| Rolling summary (phase 4) | Done, incremental, shown in the Context view. Web search is only in the high-effort rerun by default (quick-answer web is a setting, off). |
| Project RAG (phase 5) | Done, see section 4. |
| Window (phase 6) | Done: one frameless transparent window with orb / peek / full modes, opacity and fade, click-through outside the orb, equalizer driven by the meeting audio level. |
| Settings | Done: Settings → AI Models → Copilot tab, plus the Copilot sidebar page (Projects, Prompts, Past meetings). |
| Projects from the calendar | Done: project picked from the linked calendar event (title, organizer domain, Meet URL), manual picks remembered as rules. |
| Start / end of meeting (phase 9, partly) | Start card from the notes/plan, end recap card, closing card on closing phrases or the calendar end time. Window closes, shrinks or stays on meeting end (`onEnd`). |
| Learned behaviour | One short global guide rewritten by a cheap model from "Not helpful" taps and tapped Skipped items (≥5 signals and ≥12 h, or ≥12 signals). |
| Audio cleanup | GTCRN denoise worklet (`meetingDenoiseEnabled`, default on, skipped when native AEC is on). |
| Memory safety | Per-meeting collection caps, partial events throttled to 300 ms, `copilot-memory.log` probe every 30 s. Whether this fixed the real RAM growth has **not been confirmed on a long live meeting**. |
| Tests | `test/copilot/` (engine, decision, answer, summary, trigger, RAG, state reducer, store, service). The store, RAG store and service tests need Electron's better-sqlite3: `ELECTRON_RUN_AS_NODE=1 npx electron --test` (see `docs/copilot/DEV_HARNESS.md`). |

## 4. RAG (project files)

Own SQLite index in `copilot.db`: no Qdrant, no extra process. About 1,600 lines in `src/copilot/rag/`.

**Ingest** (per file, background, 4 files at once):
- Text, docx/pptx/xlsx: read locally (`adm-zip`).
- PDF: split into 12-page parts, read by Gemini in parallel (also OCR).
- Image: Gemini description plus every label and number.
- Audio/video: ffmpeg → Gemini transcript with timestamps in 10 min parts.
- Chunking: about 900 chars with 120 overlap, heading and page kept, junk chunks dropped. Audio uses 60 s windows and video 30 s windows.
- Embedding: 768 dims (Matryoshka cut), batches of 100. Audio and video are embedded natively for the first 5 min per file and from their transcript after that.
- Each file also gets a summary of 80 words or fewer. A chunk-hash cache means an edited file re-embeds only what changed.
- Limits per project: 1 GB and 20k chunks. A file over a limit stays listed with the reason.

**Retrieval:**
- Vectors are held in memory per project and searched by brute-force cosine.
- FTS5 keyword hits are merged with the vector hits by RRF (k=60, keyword weight 0.8).
- A chunk is kept if cosine ≥ 0.58 and within 0.05 of the best, or if it's a strong keyword hit with cosine ≥ 0.5.
- Fast tier returns 5 passages (2,800 chars). High effort returns 10 (7,000 chars) after a cheap model writes up to 3 extra phrasings of the question.
- A catalog of up to 12 files is always in the prompt, and the decider also sees a one-line catalog.
- The query embedding is prefetched while D1 runs, so the search takes 2 to 3 ms when warmed, and waits at most 2.5 s before falling back to keyword-only.
- Retrieval runs when D1 sets `needs_project`, when the user types a question, or on a high-effort rerun. It also runs unasked when the best cosine is ≥ 0.69.

**Measured (OYaara set: 16 real files, 4 old meetings replayed):**
- Indexing took 83 to 107 s and cost about $0.22 to $0.28.
- 20 of 20 cards on the team meeting searched the files.
- Spot checks against the source documents were correct.
- The fast card took about 0.6 s. The high-effort card took 6 to 9 s.

**Not done in RAG:** speech audio tested only on tones and test video, docx images, very long PDFs beyond 12-page parts, and Google Docs links. Floors were tuned on one project set.

## 5. Differences from the brief

| Brief | Code |
|---|---|
| Router outputs a locked JSON decision | D1 decider returns probabilities. The policy in `core/decision/` turns them into run / skip, tier, and needs web / project / past meetings / screenshot. |
| New inference scopes `copilotRouter/Main/Summary` in `inferenceScopes.ts` | Not used. The copilot has its own settings file and OpenRouter client. Local llama.cpp models cannot be picked for the copilot. |
| Project RAG on Qdrant + MiniLM, chunk 200 to 300 tokens | Own SQLite + Gemini embeddings and chunk ~900 chars. Past-meeting notes use their own path in the decider, and a separate chunked index of old notes was not verified. |
| Supported files: docx, PDF, Google Docs | Many more types, but **no Google Docs by link**. |
| Threads: parallel, router-chosen thread, move card | Main thread plus typed-question threads with `maxParallel` 2. The decider's `thread` choice is not auto-routed, and there is no "move card". |
| Idea suggestions lane | Replaced by a **Skipped** box (moments the model passed on, tap to send). |
| i18n for all UI strings | The copilot UI is English-only for now. This is a deliberate, noted exception in `CLAUDE.md`. |
| Compact vs expanded four-pane window | Replaced by orb / peek / full modes. |

## 6. Not built yet

- **Screenshot (phase 8):** only the decision side exists (`screenshotCheck.js`, bar 0.95). Capture is not wired for the copilot and Wayland capture is unsupported by the app.
- **Talking-points checklist (phase 10)**, **commitment capture (phase 11):** the summary and the prompt mention them, but there is no UI or tracking.
- **Google Docs by link, and local document creation with Save (phase 12).**
- **Automatic thread routing and "move card" (phase 13).**
- **Screen-share detection (phase 14):** `window.js` and `questions.js` mention it, but no research has been reported.
- Save threads and the final summary into the meeting note, and post-meeting action buttons (phase 9, remainder).
- Push-to-talk mic and an attach button in the composer.
- Router test box in settings. The offline bench scripts exist, but the in-app test box does not.

## 7. Open items and risks

- Soniox has only been tested against a mock. The real segment sizes, `<end>` timing and speaker labels are unknown, and system-channel diarization was never confirmed.
- Wayland window tests (always on top, transparency under `--disable-gpu-compositing`, XWayland) were scripted in `scripts/copilot/window-test/` but the results are not recorded in the docs.
- Spoken latency (Soniox end-of-speech to first token) was never measured. Text-only numbers are in `docs/copilot/phase0b-report.md`: fast first token about 1.1 to 1.5 s, web answers about 5.5 s.
- Card quality: on old noisy Hinglish meetings, graded acceptable cards were about 26% before the verifier and about 65 to 80% with SKIP and the proactive rules. The standard is strict by choice.
- Cost control: the OpenRouter key has a $3/day cap. Large replays are expensive (15 meetings ≈ 6.8M decider tokens), so ask before running them.
- RAG floors (0.58, 0.69) rest on a small sample. `RAG_PLAN.md` says margin 0.08 but `config.js` uses 0.05, and `AUTO_SCORE` is duplicated in `engine.js:56`.
- Nothing is committed yet. Upstream sync and rebase were not checked.

## 8. Where to read more

| File | Content |
|---|---|
| `copilot_implementation_brief.md` | The full plan |
| `docs/copilot/IMPLEMENTATION_PLAN.md` | Detailed phase plan (revision 2) |
| `docs/copilot/V2_PLAN.md` | Post-first-meeting fixes (RAM, cost, audio, turns, orb), all built |
| `docs/copilot/RAG_PLAN.md` | RAG decisions, measured API limits, OYaara test |
| `docs/copilot/DECISION_MODEL_DESIGN.md` | Decider design |
| `docs/copilot/phase0a-report.md`, `phase0b-report.md` | Soniox and latency reports |
| `docs/copilot/DEV_HARNESS.md` | How to run the Electron-bound tests |
| `scripts/copilot/` | Replay, bench and RAG tools (`replay-e2e.mjs`, `card-bench.mjs`, `rag-live.js`, …) |
