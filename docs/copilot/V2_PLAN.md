# Copilot v2: post-meeting fixes and improvements

Source: first real meeting (2026-10-12/13). Evidence: `copilot.db` sessions `f27bdcd3` (257 segments, 32 cards) and `fb5eb1af` (143 segments, 24 cards).

Decisions made with the user: mic noise (RNNoise + VAD, AEC on), orb + hover-peek mini mode, project from calendar event + Meet URL, separate Copilot sidebar page + 3rd AI Models settings tab.

## What the logs show

| Observation | Where | Meaning |
|---|---|---|
| Both last sessions have `ended_at == started_at` | store.js:166 repairs unclosed sessions on launch | Session never ended cleanly: app died (likely RAM) or `endSession` never ran |
| All segments `source=system`, `speaker=null` | `copilot_segments` | No speaker identity reaches the engine; one blob of voices |
| Words cut mid-token across segments ("l" / "ike this", "exec" / "ute") | seq 5-6, 14-15 | Provider emits fixed-size slices; engine treats each as an utterance |
| 1-2 word segments ("Yeah.", "You.", "Uh-huh.") are ~40% of rows | seq 2,4,9,11,13... | Backchannel and noise count as transcript; cost tokens in every context |
| ~1 card per 8 segments, ~40% proactive | cards table | Too many calls |
| Window never closes on session end | window.js has no end hook; `endSession` only called from `resetMeetingStreamingState` | Bug 9 |

## RAM (hypotheses, measure first)

No single obvious leak in the engine: `transcript` capped at 300, renderer `segments` at 600. Suspects to confirm with measurement:

1. Unbounded per-session collections in engine: `s.cards`, `s.asked`, `s.specs`, `threads.answers`, `s.callMs`, `s.reactionMs`, `trace`/`log` records (engine.js:88,130).
2. Main process meeting pipeline: `meetingDiarizationSegments` (ipcHandlers.js:6835, only spliced on retract), `meetingPendingMicChunks`, echo-detector buffers.
3. Renderer: `backgroundThrottling:false` on a hidden/behind-call window keeps timers and React renders alive; card list + transcript re-render on every partial; two renderer processes (control panel + copilot).
4. Orphan: session that never ends keeps everything alive for hours.

**Phase 0 deliverable:** a memory probe (`process.memoryUsage`, `webContents.getProcessMemoryInfo`, collection sizes) logged every 30 s to `copilot-mem.log`, plus a replay of session `f27bdcd3` looped x20 (`scripts/copilot/replay-fast.mjs` exists) to find which structure grows. Fix only what the numbers show; likely caps: cards kept in memory = last 40, older come from SQLite on demand; `asked` = last 200; drop trace to disk.

## Phases (in order)

### Phase 0. Measure + stop the bleeding (RAM, auto-close)
- Memory probe as above; replay loop; fix top growers.
- Auto-end: when meeting transcription stops (`stopMeetingTranscription` / `resetMeetingStreamingState`), engine ends session, recap runs, window collapses to orb (or closes per setting `onMeetingEnd: close | orb`). Verify `endSession` fires on every stop path (user stop, owner-loss teardown, app quit).
- Window: throttle when hidden or orb (`backgroundThrottling` true while orb and no running job).

### Phase 1. Cost: fewer tokens
- Preprocess the transcript once: merge slices into utterances (join fragments that end mid-word, same source/speaker within ~1.5 s), drop backchannel ("yeah", "uh-huh", "right", "you") from LLM context but keep for display.
- Turn-based triggering (Phase 3) is the main call reducer.
- Context pack: send summary + last N utterances instead of raw 6000 chars every call; cache static prefix (instructions, project plan, summary) for provider prompt caching; D1 gets only new utterances + one-line state.
- Idea lane: stop firing on partials; run on turn end only; cap at 1 call/turn and 1 per 30 s.
- Add per-session token counter to LiveHeader and DB (`stats`) so cost is visible. Target: cut calls by >=50% on replay of `f27bdcd3` (baseline: 32 cards, record D1 + idea + answer calls first).

### Phase 2. Audio: noise and echo
- Mic path (renderer AudioWorklet, before the 24 kHz send): RNNoise (WASM, ~100 KB, 10 ms frames) then VAD gate (hangover 300 ms) so silence and non-speech are not sent. System channel: VAD gate only (call app already denoises).
- Turn AEC (`meetingAecEnabled`) default ON when output device is not headphones; keep toggle. Existing echo leak detector and mic gate stay.
- Success: replay of a noisy recording (fan, keyboard, TV): non-speech segments drop by >80%; no loss of the user's first word (hangover + 200 ms pre-roll).
- Risk: RNNoise can clip soft speech; ship behind a setting (`meetingDenoise`, default on) with an A/B in settings.

### Phase 3. Turn-based decisions
- New `core/trigger/turns.js` (pure): tracks per-source activity from partials/finals. A turn ends when the speaker is silent >= `turnGapMs` (default 1200 ms) or another speaker starts. D1 runs on turn end, not on each final.
- Speaker identity: use provider diarization if Soniox returns it for the system channel (verify; segments currently carry none); else source only (You vs Them). Interface stays `speaker?: string` so diarization drops in.
- Never interrupt: while the other party's turn is open, queue; flush at turn end. User's own turn end triggers only if it contained a question to the client.
- Tests: PCM-free, event-driven (like `trigger.test.js`).

### Phase 4. Card content and flow
- Replace the green idea box with **Skipped** box: questions D1/ideas judged "wait/skip" with the reason; each is tap-to-ask (runs through `engine.ask`). Source data: `s.decisions` `skip`/`wait` candidates (needs the decider to return the candidate line; `questions.js` already extracts them). No more auto-generated "ask them" chips; remove `ideas.js` ask kind and lane UI.
- Rename "Go deeper" to **Rerun with high effort**; keep as a generic "effort" action so tools (web, RAG) can attach later.
- Prompt change (`prompts/main.js`): bullets are things the user can say aloud, plain words, <= 12 words each, no source names inline (sources in footer), first-person phrasing ("We can...").
- Wrap-up detection: scheduler flags closing cues ("let's wrap up", "any other questions", "thanks", clock vs calendar end time). On cue, emit a **closing card**: summary of decisions + next steps phrased to say out loud. Reuse the recap path (`startRecap`) with a "closing" variant.

### Phase 5. Orb / mini mode / transparency
- `window.js`: states `full`, `peek`, `orb`. Orb: 56 px circle, `transparent: true`, `frame: false`, `hasShadow: false`, drag by pointer, `setIgnoreMouseEvents(true, {forward:true})` except over the orb. Pulse + count badge on new card; peek auto-opens newest card ~8 s then returns; hover/click expands to full; hotkey cycles.
- Transparent window: current window sets only `backgroundColor`; real transparency needs `transparent:true` and no `backgroundColor`. Linux caveat: app starts with `--disable-gpu-compositing` (main.js); verify transparency works there, else fall back to opacity-only (fade to ~15 %).
- Setting for idle opacity and peek duration.

### Phase 6. Settings page + Copilot sidebar page
- Settings > AI Models: add 3rd tab **Copilot**: API key (OpenRouter), quick/deep/summary models, pace, web search on quick, denoise/AEC, turn gap, end-of-meeting behavior, orb options, hotkey. Move what `SettingsView.tsx` has now (reuse the component, mount in both places).
- Sidebar: new **Copilot** page (route in ControlPanel): Projects (name, files, instructions, plan), Prompts (main, end, recap, closing), Past meetings (existing `PastMeetings.tsx`), per-project context. RAG hooks reserved (`copilot_project_files` already exists); no RAG in this iteration.
- Project link: schema `copilot_project_rules(project_id, kind: title|domain|meet_url, pattern)` and `copilot_sessions.project_id`; at `begin()` match the linked calendar event (`calendar_events` table) title / attendee domain / Meet URL; remember manual pick as a new rule. Live header gets a project switcher.
- i18n: the app requires keys in 9 languages for new UI strings; copilot UI is English-only today. Decision needed: keep English-only for now (consistent with CLAUDE.md note) or translate the new settings page.

## Verification (per phase)
- Unit tests in `test/copilot/` for turns, merge/backchannel filter, project matching, state reducer.
- Replay `f27bdcd3` and `fb5eb1af` (`scripts/copilot/replay-*.mjs`): record card count, calls, tokens before and after.
- Memory: 2 h synthetic run, RSS flat within ~10 %.
- Manual: real call checklist (end-of-meeting close, orb behavior, noisy room).

## Open items
- Does Soniox return per-speaker diarization on the system channel? (Phase 3, 30 min check.)
- Linux transparency under `--disable-gpu-compositing` (Phase 5 spike).
- Copilot UI i18n scope.

## Status (2026-10-13): all phases built

- **P0** per-meeting caps (specs, asked, thread answers, timings, history 1500 and no `card_update` replay), partial events throttled to 300 ms, finished side jobs pruned, `copilot-memory.log` probe (every 30 s while a meeting runs: RSS/heap + sizes of every engine collection + per-process working set). `stopMeetingTranscription` now ends the copilot in a `finally` (local mode and failed teardowns skipped it); finals in flight after a stop no longer open a new meeting. Window closes / shrinks / stays by setting `onEnd`.
- **P1** `core/transcript/utterances.js` (drop backchannel, glue cut-up segments) used by D1 state, answer context, verifier, summary; smaller budgets; summary at most every 30 s; token counters (`inputTokens` D1, `answerTokens` cards).
- **P2** `src/audio/meetingDenoise.ts`: GTCRN speech enhancement + noise gate at 48 kHz, +11 dB makeup, PCM worklet decimates to 24 kHz. Setting `meetingDenoiseEnabled` (default on, skipped while native AEC is on). Verified in Electron: loads under file://, runs in real time.
- **P3** scheduler waits for the speaker's turn to end (`turnGapMs` 1500, question 300, cap 20 s); another voice starting ends the turn.
- **P4** green box = **Skipped** (below-bar moments and model SKIPs, tap to ask); idea lane removed; "Rerun with high effort"; say-it-aloud prompt; closing card on closing phrases or calendar end.
- **P5** one frameless transparent window with orb / peek / full modes; fade is CSS opacity.
- **P6** Copilot sidebar page (Projects with files, instructions, plan, calendar rules; Prompts; Past meetings), Settings > AI Models > Copilot tab, project switcher on the live header, calendar-event matching.

Memory probe usage: after a meeting read `<userData>/copilot-memory.log` (or `copilot-logs/` in dev) and look at which `copilot.*` size or process `workingSetMB` keeps growing.
