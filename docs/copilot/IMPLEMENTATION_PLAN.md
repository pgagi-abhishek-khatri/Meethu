LIVE MEETING COPILOT - IMPLEMENTATION PLAN
==========================================

Status: REVISION 2, after your answers. Nothing in this plan has been built.
Revision 2 changes: your 13 answers applied (section 12), your approved improvements merged into phases (tagged [IMP-n], list in section 13) and a new Phase 15 added.
Written from: copilot_implementation_brief.md, CLAUDE.md, and a read of the code in this clone.
Repo base: OpenWhispr v1.10.2 (package.json). Your main is 5 commits behind origin/main.
Your local Soniox work is uncommitted (16 changed files plus sonioxStreaming.js, its test, soniox-realtime-test.html).

How to read this plan
- "Found" means I read it in code. "Needs a runtime test" means code cannot answer it. "Assumption" means I picked a default because you have not answered yet; you can change it.
- Where I am unsure I say so.
- Section 11 lists the changes I recommend to the brief. I have not applied any of them.

Change from the brief: Phase 0 is now two parts.
- Phase 0A (new): make Soniox work in MEETING mode. Per your instruction, this comes before anything copilot.
- Phase 0B: the brief's Phase 0 (latency prototype and window test).
Phases 1 to 14 keep the brief's numbers. Phase 1 shrinks, because Soniox review moves into 0A.
Later phases may change after 0B results. That is stated again at the end of Phase 0B.


-------------------------------------------------------------------------------
1. DECISIONS AND ASSUMPTIONS
-------------------------------------------------------------------------------
Your answers (section 12 has the full list):
D1. Machine (I checked, read-only): Ubuntu 26.04.1 LTS, GNOME Shell 50.1, session type Wayland (WAYLAND_DISPLAY=wayland-0), PipeWire 1.6.2, tools present: pactl, pw-record, parec, arecord. So GNOME Wayland rules apply: toggle-only global hotkeys, and the app forces XWayland (2.3). Phase 0B tests XWayland and native Wayland.
D2. Router: a small cloud model. Main and reasoning-tier models: you did not name them; defaults are chosen in Phase 0B from measured numbers and shown to you before they are fixed. No local router in v1 (local stays selectable).
D3. No OpenWhispr account features. Web search is the provider built-in search tool only (Anthropic or OpenAI). The OpenWhispr Cloud web_search is out. If the selected provider has no search tool, web search is off and settings say so.
D4. Model settings: "both" (see A1 below for how I read it).
D5. Soniox speakers: Soniox diarization on BOTH streams (mic and system), in addition to what OpenWhispr already does for other providers (see 2.4a).
D6. Soniox region: US only for now. The region option is still built (small), but not tested beyond US.
D7. Dependencies: reading only: a PDF reader and a DOCX reader. No DOCX writer. Documents the copilot creates are Markdown only.
D8. Translations are not a priority: English strings now. See A3.
D9. Past-meeting index: own chunked index, approved.
D10. Push-to-talk drops the meeting mic audio while held; you mute in the call app.
D11. The copilot window opens automatically when a meeting recording starts (and can be opened manually any time).
D12. Git: no branch, no rebase, no commit now. Your Soniox work stays as it is in the working tree (you will need it). Upstream stays 5 commits ahead for now.
D13. All 20 improvement ideas approved (section 13). Merged into phases, tagged [IMP-n].

Assumptions I made (change any of them):
A1. "Both" for model settings, read as: the three model roles (router, main, summary) are new SHARED scopes copilotRouter, copilotMain, copilotSummary in inferenceScopes.ts, as the brief says, so the existing model pickers and key handling work. Everything else (behaviour, prompts, window) lives in the copilot's own settings store. Cost: about 15 changed upstream files for the scopes (2.6, 7). If "both" meant something else, tell me.
A2. The router needs JSON. The provider layer has no JSON mode, so the copilot call wrapper uses the AI SDK (generateObject if the installed version supports it, otherwise prompt-enforced JSON plus validation) with the model resolved from the scope. Checked in Phase 2 step 1.
A3. Translations: the repo test (test/locales/translationCoverage.test.js) fails if a key is missing in any of the 11 locales. So each phase adds the English text to en AND copies the same English text into the other 10 locale files (marked in a list file docs/copilot/untranslated-keys.md). Real translation later, in one batch, when you ask.
A4. Soniox diarization labels are only as good as Soniox provides. If a label is missing for a token, the segment has no speaker and the existing logic applies.
A5. Fallback STT when Soniox fails (IMP-8): the existing "local" meeting mode (Parakeet or Whisper) if a local model is downloaded; otherwise a clear error. Confirm in Phase 15.
A6. Copilot data is scoped like notes (per OpenWhispr account_id where notes are); I confirm the exact column at Phase 3.
A7. Meeting start = recording start. The copilot answers in the meeting's language by default.
A8. Retention default (IMP-12): keep 90 days, setting to change, plus delete-per-meeting. Consent reminder (IMP-11) on by default. Redaction (IMP-14) off by default. Record-and-replay (IMP-3) off by default. Cost meter (IMP-9): counts only, optional daily cap off by default.
A9. The router reacts to both streams by default (setting: "react to: everyone | only other people").

-------------------------------------------------------------------------------
2. WHAT I FOUND IN THE CODE
-------------------------------------------------------------------------------

2.1 Version and git
- package.json version 1.10.2. HEAD 95fb3758. origin/main f770e921 (5 newer commits: GPU follow-ups, friendly provider errors #2510, keep local LLMs resident #2494, release page fix).
- No local commits. Local Node is v26; repo needs Node 24 (engines >=24, .nvmrc). Use "nvm exec 24" for any npm install, or the lockfile breaks CI.
- CLAUDE.md in your working tree has 6 added lines about Soniox. Upstream will not have them.

2.2 Your Soniox code (src/helpers/sonioxStreaming.js, 408 lines, test file 278 lines)
Covers: dictation only; key in main process via BYOK_API_KEYS; warm socket with TTL and keepalive; cold connect with up to 10 s buffered audio; partial/final token handling; finalize; end-of-stream; IPv4 only; stale-close guard; option validation (sampleRate 8000-48000, language, keyterms). 16 tests pass (node --test, local WebSocket server).
Misses for meeting mode (details and fixes in Phase 0A):
- Not in meetingStreamingProviders.js STREAMING_CLIENT_BY_PROVIDER, not in meetingTranscriptionRouting.js MEETING_STREAMING_PROVIDER_IDS, no entry in realtimeTokenProviders.js (fetchRealtimeToken throws for unknown providers by design).
- Final callback shape: meeting code calls streaming.onFinalTranscript(text, timestamp) and reads streaming.completedSegments (ipcHandlers.js about 7022-7025). Soniox passes one cumulative string and has no completedSegments or timestamp.
- Missing fields the meeting code uses: audioBytesSent, sessionStartedAt, onConnectionLost, onSessionExpired (ipcHandlers.js about 7130-7148, 7150+). Deepgram has all of these (deepgramStreaming.js lines 95-129, 739). I only skimmed Deepgram; Phase 0A step 1 is to read it fully.
- No speaker diarization, no endpoint detection, no region choice, no reconnect, no 300-minute stream rollover.
- Test coverage: dictation paths only.
Doc facts (soniox.com docs, fetched today):
- Regions: US stt-rt.soniox.com, EU stt-rt.eu.soniox.com, Japan stt-rt.jp.soniox.com, India stt-rt.in.soniox.com.
- API keys are per region (one project per region). Regional access must be requested from Soniox support. So testing several regions in 0B may need that approval first.
- Auth: key in the first config message OR in an Authorization header / protocol list. (A comment in your code says headers are not used; the docs allow them. Not important.)
- Keepalive needed at least every 40 s. Each stream is limited to 300 minutes.
- Tokens carry text, start_ms, end_ms, confidence, is_final, speaker (with diarization), language.
- enable_endpoint_detection adds an <end> token when the speaker stops. enable_speaker_diarization labels up to 15 speakers.
- A stream ends with an empty text frame; the server replies finished:true.
(Your code already skips <end> and <fin> tokens. It does not use them.)

2.3 Window and platform facts (read from code)
- main.js lines 1-13 relaunch the app with --ozone-platform=x11 whenever XDG_SESSION_TYPE is wayland (src/helpers/xwayland.js). The packaged launcher does the same (scripts/lib/linux-launcher.js). So the brief's Wayland section (17) describes native Wayland, but the app runs as an X11 client today.
- main.js lines 112-116: gtk-version=3, enable-transparent-visuals, disable-gpu-compositing on Linux (comment says they fix transparent-window flicker).
- Five BrowserWindows exist (windowManager.js 123, 1326, 1864, 2066; permissionGuideManager.js 244). None is reusable as the copilot window: the pill and meeting notification are non-focusable and click-through. Reusable helpers: WindowPositionUtil.setupAlwaysOnTop (windowConfig.js 345-376), resolveOverlayWindowType (windowManager.js 14-28), NOTIFICATION_WINDOW_CONFIG pattern.
- Window routing is by URL query in src/AppRouter.jsx (lines 30-42). A new window needs a query branch there.
- No window position is saved anywhere.
- setContentProtection is applied only to specific windows (windowManager.js 183, 1883, 2089), never globally. The copilot window gets none, as the brief requires.
- No screen-share detection code exists.

2.4 Meeting transcription pipeline (Section 14 items 1, 2, 15)
- Start: hotkey -> windowManager.startManualMeeting() -> meetingDetectionEngine.startManualMeeting() -> renderer meetingRecordingStore.startRecording() -> IPC meeting-transcription-prepare/start/send.
- Two streams, "mic" and "system", each with its own streaming client instance (ipcHandlers.js about 7469-7486).
- Event meeting-transcription-segment: { text, source, type: partial|final|retract, timestamp? }. No speaker in the payload. Sent only to the window that started the meeting. No event bus exists.
- Best attach point for a bus: sendMeetingFinalSegment (ipcHandlers.js 6837). Partials go through the closure at about 7002-7018; retracts at about 7059 and 8064. A bus needs 2-3 one-line hooks in ipcHandlers.js.
- Partials exist for streaming providers only. Local mode sends 5 s chunk finals only.
- Speakers: liveSpeakerIdentifier.js labels the SYSTEM stream only, after the audio (event meeting-speaker-identified). Mic is "you". The renderer adds provisional speaker_N labels (meetingRecordingStore.ts decorateFinal).
- Linux system audio: native PipeWire helper resources/linux-system-audio-helper.c (default sink capture, 24 kHz mono). No portal, no pactl. Pure-PulseAudio setups work only through pipewire-pulse. If the helper fails, the meeting records mic only. Needs a runtime test on your machine.
- Transcript stored in notes.transcript as a JSON array of segments (serializeTranscriptSegments, src/utils/transcriptSpeakerState.ts 193).
- Calendar end time: reachable in main (note -> calendar_event_id -> calendar_events.end_time). Manual meetings have none.

2.4a Speakers across providers (checked after your answers)
- deepgramStreaming.js and assemblyAiStreaming.js contain no diarization or speaker handling. So for every existing provider the live speaker labels come only from OpenWhispr's local identifier (system stream) and "you" (mic). "Like any other model" therefore means: Soniox must also work with that local identifier. It will, since the identifier reads the audio, not the provider.
- Soniox is the first provider that can ALSO label speakers itself. Plan: enable enable_speaker_diarization on both streams, keep the local identifier running, and let a Soniox label fill in when the local one has nothing. The meeting event has no speaker field today; adding an optional one touches the existing event path and renderer (Phase 0A step 9, clearly marked).
- Both streams count speakers from 1, so labels must be namespaced by stream (mic vs system) to avoid mixing two different people under one label.

2.5 Search, embeddings, documents (Section 14 item 6)
- Notes search does NOT chunk. One vector per note, text = title + (enhanced_content or content), cut at 1500 characters, then 256 tokens in the ONNX worker (localEmbeddings.js 113-115, onnxWorker.js 30-31). Transcripts are never embedded. A "conversation_chunks" collection with chunking already exists (vectorIndex.js, conversationChunker.js) and is the template for ours.
- The model name, 384 dimensions and 256 tokens are hardcoded in several places. Swapping the embedding model means editing several files; there is no config.
- RRF merge (K=60) is inline in ipcHandlers.js 2104-2116, not an exported function. We write our own small pure copy (src/copilot/core/rrf.js) instead of editing it.
- The Qdrant lifecycle (semanticSearchLifecycle.js) is note-specific. We reuse its running Qdrant (vectorIndex.client) but not its drain logic.
- FTS5 exists only for notes (notes_fts). For project chunks we create our own FTS5 table.
- No PDF, DOCX, or HTML-to-text libraries in package.json. No document ingest. No .docx writer.

2.6 Models and providers (Section 14 items 3, 4, 5)
- Adding a scope in the shared system touches about 15 source files plus 11 locale files (settingsStore.ts in about 10 places, InferenceConfigEditor, SettingsPage, SettingsModal, electron.ts, useSettings.ts, secretKeys.js, preload.js, enterpriseManagedConfig.mjs, reasoningRouting.js, localServerPolicy.js, and ReasoningService.ts line 766 which hardcodes "chatIntelligence"). This is why I recommend A3.
- InferenceProvider (src/services/ai/inferenceProviders/types.ts) is renderer-only, one call, returns a string. No streaming, no abort signal, no JSON mode.
- Streaming, tools and abort exist only in the AI-SDK path: ReasoningService.processTextStreamingAI (line 757) using getAIModel (src/services/ai/providers.ts) and streamText. This is what the copilot main model should reuse (via its own small wrapper, not by editing it).
- Anthropic calls go through IPC (process-anthropic-reasoning) in the older path; the AI-SDK path calls Anthropic directly from the renderer with the browser-access header.
- Existing web_search tool (src/services/tools/webSearchTool.ts) is an OpenWhispr Cloud service: needs sign-in, returns title, url, 500-char text. It is not a provider-built-in search tool. No citation UI exists.
- Local llama.cpp: one shared llama-server holds one model at a time (llamaServer.js); inference() does not stream; no grammar or JSON schema; idle timeout 5 min fixed (upstream #2494 adds keep-resident, not yet pulled). Smallest models in registry: lfm2.5-230m (0.25 GB), lfm2.5-350m (0.38 GB). Speed on your machine needs a runtime test.

2.7 Hotkeys, settings, i18n, database, tests
- Hotkey slots: dictation, voiceAgent, translation, meeting (hotkeyManager.js). A new slot touches about 10 files (hotkeyManager.js, gnomeShortcut.js SLOT_CONFIG and D-Bus methods, kdeShortcut.js, hyprlandShortcut.js, main.js 1225-1262, ipcHandlers.js 11473-11530, preload.js, electron.ts, SettingsPage.tsx, locales). GNOME named slots are toggle only.
- Settings: SettingsSectionType union (SettingsPage.tsx 162-171), sidebarItems (SettingsModal.tsx 64-131), a case in renderSectionContent.
- i18n: 11 locales (ar, de, en, es, fr, it, ja, pt, ru, zh-CN, zh-TW). CLAUDE.md says 9 or 10; it is out of date. test/locales/translationCoverage.test.js fails if any key is missing in any locale. npm run i18n:check also exists.
- Database: src/helpers/database.js, better-sqlite3, WAL. New tables use CREATE TABLE IF NOT EXISTS; new columns use try/ALTER ignoring "duplicate column"; one-time data migrations gated by PRAGMA user_version (currently up to 4). No migrations table.
- Tests: "node --import tsx --test test/**/*.test.js" (package.json line 78). Mock WebSocket pattern: test/helpers/parakeetOnlineStream.test.js (real ws server on port 0).

2.8 Not confirmable from code (runtime tests needed)
- Always-on-top over a video call under XWayland and under native Wayland.
- Transparency and click behaviour of a new window on your GNOME.
- Whether the desktop is GNOME at all.
- Local router speed.
- Screenshot via xdg portal without a prompt each time.
- Google Docs export-by-link behaviour (my probe was blocked by the permission check). Expected, not verified: export?format=txt works for "anyone with the link" docs; unshared docs return a login redirect.
- Screen-share detection on GNOME Wayland.
- PipeWire system audio capture on your machine.
- Soniox latency from your location; regional keys.


-------------------------------------------------------------------------------
3. ARCHITECTURE SUMMARY
-------------------------------------------------------------------------------

Folders (all new, so upstream merges stay easy):
  src/copilot/main/        main-process code: transcript bus, DB access, RAG/index, hotkeys glue, window manager, local file writer
  src/copilot/core/        pure logic with no Electron: trigger rules, router JSON validation, context builder, budgets, chunking, rrf, concurrency limiter, summary merge, commitments parsing
  src/copilot/prompts/     default prompts (locked parts and editable parts, presets)
  src/copilot/config/      budgets, defaults, timeouts (one file each)
  src/copilot/renderer/    orchestrator (router loop, main-model calls via AI SDK), copilot settings store, IPC client
  src/components/copilot/  React UI (window, cards, transcript, context, settings section)
  test/copilot/            unit tests, plus test/copilot/eval/ for the router evaluation set and script
  scripts/copilot/         phase 0B latency script
  docs/copilot/            this plan, phase 0B report

Data flow:
  Audio (mic + system) -> existing meeting pipeline -> selected STT provider (Soniox recommended)
  -> existing meeting-transcription-segment path
  -> NEW transcript bus in main (src/copilot/main/transcriptBus.js, fed by 2-3 one-line hooks in ipcHandlers.js)
  -> bus forwards to the copilot window over IPC (and later to the Transcript tab, summary service, router)
  -> orchestrator in the copilot window (renderer): trigger rules (core) -> router call (small model, JSON) -> validate
  -> if action != wait: context builder (core) collects transcript window, rolling summary, meeting plan, project chunks (IPC to main RAG), web results, past meeting notes (IPC to main), screenshot (IPC to main, in memory), thread history
  -> main model streams via AI SDK into a card in the right thread -> card saved to SQLite through IPC
  -> user replies / quick actions / parallel threads go straight to the context builder (skip router)
  -> background summary service updates the rolling summary on an interval
  -> at meeting end, threads and summary are written to the meeting note.

Why the orchestrator lives in the renderer: the provider and AI-SDK code is renderer-only (2.6). The copilot window must be created with backgroundThrottling:false and must never be hidden in a way that pauses timers (minimizing is the risk; tested in 0B).
Why the bus lives in main: that is where final segments exist and where RAG, DB and hotkeys live.

Reused existing code:
- Meeting pipeline, capture helpers, echo/AEC handling, speaker identification (unchanged)
- BYOK key storage (secretKeys.js manifest) and provider registry/AI-SDK model creation (getAIModel)
- hotkeyManager.js slots (new slots added the existing way)
- Qdrant sidecar and onnx embeddings (separate collection, own methods)
- database.js (new tables only, created in initDatabase)
- windowConfig.setupAlwaysOnTop, AppRouter query routing
- screenContextCapture.js (Phase 8, with portal work if needed)
- i18n system, shadcn/ui, existing test style


-------------------------------------------------------------------------------
4. PHASE 0A - SONIOX IN MEETING MODE (new, comes first)
-------------------------------------------------------------------------------

Goal
Meeting mode can use Soniox for the live transcript, on both streams, with nothing else in the app changed. Where Soniox cannot supply something the meeting code expects, we use a substitute or drop the feature, as you asked. Dictation with Soniox keeps working.

Depends on: nothing. Git step first (see step 0).

Rule for missing fields (your instruction): for each field the meeting code expects, we try (1) Soniox gives it directly, (2) we derive it, (3) we ignore it and the feature is simply absent. A table of this is in "Field mapping" below, so you can approve each choice.

Files to change (existing)
- src/helpers/meetingStreamingProviders.js (add "soniox-realtime")
- src/helpers/meetingTranscriptionRouting.js (add "soniox" to MEETING_STREAMING_PROVIDER_IDS; resolve provider id)
- src/helpers/realtimeTokenProviders.js (add "soniox-realtime" entry; BYOK returns the stored key; managed mode: not supported, clear error)
- src/helpers/sonioxStreaming.js (your file: meeting-contract fields, endpoint detection, region, reconnect support)
- src/helpers/ipcHandlers.js: the optional speaker field in the final-segment send (step 9), plus any tweak step 4 shows is needed (connection key, sampleRate). Keep it to a few lines.
- src/stores/meetingSegmentReducer.ts, src/stores/meetingRecordingStore.ts, src/types/electron.ts (step 9, speaker field)
- src/models/modelRegistryData.json (a "streaming" flag if the meeting UI needs it; check first)
- Meeting provider picker UI: location not yet found. Step 6 finds it (search for "deepgram-realtime" in src/components and src/stores).
- Tests: test/helpers/sonioxStreaming.test.js (extend), test/helpers/meetingStreamingProviders.test.js, test/helpers/meetingTranscriptionRouting.test.js, test/helpers/realtimeTokenProviders.test.js
New files: none required. If sonioxStreaming.js becomes too large, split segment-building into src/helpers/sonioxSegments.js (pure, unit-tested).

Field mapping (what the meeting code needs vs what Soniox gives)
1. completedSegments (array of final text, last item read by the meeting code)
   - Source: Soniox has no "segment". Derive: enable_endpoint_detection:true makes Soniox emit an <end> token after a pause. Close a segment at each <end>; push its text into completedSegments.
   - If no <end> arrives for a long time (continuous speech): close a segment on our own after N seconds or M characters of final text (default 15 s / 300 chars, tunable). Also close on finalize().
   - Risk: segments cut mid-sentence. Acceptable for transcript and router; fine.
2. onFinalTranscript(text, timestamp)
   - text: the closed segment's text (not the cumulative text). Dictation keeps its cumulative behaviour through a constructor flag (mode: "dictation" | "meeting"), so existing dictation tests stay valid.
   - timestamp: sessionStartedAt + first token start_ms of the segment. If start_ms is missing: Date.now() at close. (Deepgram does the same with message.start, deepgramStreaming.js 776.)
3. Partials: unchanged (non-final tokens replaced wholesale). In meeting mode the partial is the text since the last closed segment.
4. audioBytesSent: counter in sendAudio. Trivial.
5. sessionStartedAt: set when the config message is sent (cold) or when a warm socket is adopted. Trivial.
6. onConnectionLost(error): call on unexpected close or error after the session was active. Replaces today's onError for that case (in meeting mode only). The meeting code then runs its own reconnect and replays buffered audio (recoverConnection, ipcHandlers.js about 7108-7150). So we do not write our own reconnect logic. 
7. onSessionExpired({proactive}): Soniox streams end at 300 minutes. Fire it proactively at about 290 minutes so the meeting code renews the session. Needs a runtime-free unit test with a fake clock. If the meeting code's expectations for "proactive" differ, read it first (step 1).
8. sampleRate: meeting audio is 24 kHz (system helper output). Our option validation already allows 8000-48000; must pass through from the meeting options. Check in step 4.
9. streamLabel (mic vs system label used in logs): store and log it; no effect on protocol.
10. Two instances at once (mic + system): sonioxStreaming holds a warm socket per instance. Meeting uses new instances, so this is fine in theory. The idle-warm-socket logic must not be used in meeting mode (no warm socket needed; session starts at once). Make warmup() a no-op in meeting mode.
11. Language: pass language hint; "auto" means no hint plus enable_language_identification (already there). Multilingual meetings are a Soniox strength; keep language switching unconstrained (language_hints_strict only when the user pins a language).
12. Key terms (custom dictionary): already supported (context.terms).
13. Speaker labels (your answer D5: both streams). Soniox labels each token with a speaker when enable_speaker_diarization is on. Derive a segment speaker as the most common token speaker in the segment (a segment can hold two speakers; if a speaker changes inside a segment, close the segment at the change). Namespace by stream ("mic:1", "system:2"). The label is stored on the instance next to completedSegments (completedSpeakers) and passed through the existing event as an optional "speaker" field (step 9). The local identifier keeps running; a Soniox label is used only when the local one has none. If Soniox gives no speaker, the segment has no speaker (ignored, as you asked).
14. Region: add an optional option "region" (us|eu|jp|in) mapped to the four WS URLs; default us. US only is tested (your answer D6). No settings UI in 0A.
15. Retract events and echo handling: handled upstream of the provider, not provider-specific. Unchanged.
16. Cloud "managed" mode (OpenWhispr's own token server): not available for Soniox. BYOK only (fits your no-OpenWhispr-account rule). Say so in the UI error.
17. Cumulative text prefix stability (dictation relies on it): keep for dictation mode, untouched.

Steps (each small and testable)
0. No git work (your answer D12). Re-run the 16 Soniox tests to confirm the starting point. Take a plain file backup of the 16 modified files plus the 3 new ones into the scratchpad (outside the repo) so nothing is lost while we build on uncommitted work. Done = 16/16 pass, backup exists.
1. Read in full: deepgramStreaming.js (the meeting-contract template), ipcHandlers.js lines 6990-7160 and attachMeetingStreamingHandlers and where sendMeetingStreamingAudio, reconnectMeetingStreams, getMeetingConnectionKey are used. Write down the exact list of members the meeting code reads. Done = list matches the field mapping above; add anything missed to this plan.
2. Add a mode option ("dictation" | "meeting") to the SonioxStreaming constructor or connect options. Default dictation. Done = existing 16 tests pass unchanged.
3. Meeting mode: turn on enable_endpoint_detection; build segments from tokens and <end>; add completedSegments, timestamps, audioBytesSent, sessionStartedAt, streamLabel. Put the pure token-to-segment logic in a function and unit test it with scripted token streams (long speech with no <end>, <end> in the middle of a message, finalize, empty final).
4. Add onConnectionLost and the 290-minute onSessionExpired. Add region option. Unit test with the local WebSocket server: close mid-session fires onConnectionLost once; fake timers fire onSessionExpired.
5. Register the provider: meetingStreamingProviders.js, meetingTranscriptionRouting.js, realtimeTokenProviders.js. Extend those three test files. Done = npm test for those files passes.
6. Find and update the meeting provider picker (UI + settings) so "Soniox" can be chosen for meetings and is marked recommended. Add i18n strings in all 11 locales; run npm run i18n:check. The "recommended" mark is a small label only.
7. Mock-server integration test: simulate two Soniox instances (mic and system), feed a scripted conversation, assert the sequence of meeting events (partial, final with timestamps, no duplicates). Reuse the style of test/helpers/parakeetOnlineStream.test.js.
8. Soniox diarization in the client: enable it for meeting mode, derive the segment speaker, namespace by stream, close the segment on a speaker change. Unit tests with scripted tokens (two speakers alternating, one speaker, missing speaker field).
9. Carry the speaker to OpenWhispr's own meeting transcript (your answer D5). FIRST read decorateFinal and assignProvisionalSpeaker (src/stores/meetingRecordingStore.ts about 613 and 1080) and sendMeetingFinalSegment (ipcHandlers.js 6837). Then: (a) pass an optional speaker field in the meeting-transcription-segment payload; (b) in decorateFinal use it only if no local identification exists. Existing files touched: ipcHandlers.js (the final-segment send), meetingSegmentReducer.ts and/or meetingRecordingStore.ts, electron.ts types. If this grows beyond about 40 changed lines, I stop and report. Add reducer unit tests (test/stores/meetingSegmentReducer.test.js exists; extend it).
10. Manual test on your machine (checklist in "How to test"). Record results in docs/copilot/phase0a-report.md (created at that time, not now).

How to test / what "done" means
- Unit: node --import tsx --test on the five test files above all pass; dictation tests unchanged and passing.
- Manual (needs your Soniox key): start a meeting note with Soniox selected, speak, play a YouTube video through speakers (system stream). Expect: live partials, finals in order on both streams, no crash at stop, transcript saved in the note, Soniox dictation still works afterwards.
- Manual: kill the network for 10 s mid-meeting. Expect the meeting code's reconnect to recover or show its normal error. (This tests the onConnectionLost path.)
- Manual: compare transcript quality against a provider you already use (Deepgram or Parakeet) on the same audio.
- Manual (speakers): two people (or two voices from a video) on the system stream, you on the mic. Expect Soniox labels per stream, no mixing between mic and system labels, and the local identifier still working.
- Done = the above pass, the field mapping choices approved by you, changes in ipcHandlers.js and the stores limited to the speaker field.

Risks
- The meeting code may read more members than I listed (I did not read all of it). Step 1 exists to catch this; if the list grows a lot, I report back before step 3.
- Segment boundaries from <end> may be too fine or too coarse; the thresholds are tunable constants. If transcript quality is poor, fall back to cutting segments on finalize only, or shorter timers.
- Mic echo suppression and holdback logic work on segments (ipcHandlers.js about 7040-7100). Different segment sizes from Soniox could change how often segments are held back. Test with speakers on (echo case).
- Regional keys may not be available; then region stays US and the region option stays untested (say so in the report).
- If a required behaviour cannot be matched, we ignore it, as you asked, and list it in the report so the copilot design does not rely on it.


-------------------------------------------------------------------------------
5. PHASE 0B - LATENCY PROTOTYPE AND WINDOW TEST (the brief's phase 0)
-------------------------------------------------------------------------------

Goal
Measure real speech-to-first-answer time, and find out what a floating window can do on your desktop. Everything after this may change based on the results.

Depends on: 0A for the meeting-mode Soniox path (the script itself does not need it; it talks to Soniox directly).

Files and folders to create (all new)
- scripts/copilot/latency-prototype.mjs (standalone: mic -> Soniox WebSocket -> router model -> main model with web search; prints timings)
- scripts/copilot/window-test/ (a tiny Electron test app: main.js, index.html; run with the repo's Electron; not part of the app build)
- docs/copilot/phase0b-report.md (results, created at the end of 0B)
No existing files are changed.

Steps
1. Latency script, part 1: mic capture to Soniox only. Use a Node audio capture tool available without installing new packages if possible (arecord / parec / pw-record via child_process). If none works, ask before installing anything. Print: time from end of speech (our own energy-based marker, plus Soniox <end> token) to final token.
2. Part 2: add a router call (small model) with the locked JSON format from the brief. Print router latency and the JSON.
3. Part 3: add the main model call with streaming and web search. Print time to first token and total. Web search: provider built-in only (Anthropic web search tool and OpenAI web search tool; you chose no OpenWhispr Cloud). Check the provider docs for the current tool names, limits and costs before coding (the brief requires this).
4. Run from your location with the regions you have keys for (US, then EU/JP/IN if available). Run at least 20 utterances per setup. Report median and 90th percentile, not just the best run.
5. Window test app: one window with a visible clock (so freezing is visible). Test each, under XWayland (current default) and then native Wayland (launch with --ozone-platform=wayland):
   (your machine: Ubuntu 26.04.1, GNOME 50.1, Wayland, PipeWire; the app is forced to XWayland by default, so test that first)
   a. always on top over a browser video call (Meet or similar) and over a fullscreen video
   b. transparency and opacity changes
   c. dragging, and whether position is remembered after restart
   d. minimize and restore by code (and whether timers keep running while minimized, this matters for the renderer-side orchestrator)
   e. global hotkey (toggle) via the app's existing GNOME path
   f. focus behaviour: can typing into the input work without disturbing the call
   g. screenshot via xdg-desktop-portal (Screenshot interface): does it prompt every time? (use gdbus or a small script; read-only test)
   h. screen sharing: does anything observable change while you share (for Phase 14)
6. Router model comparison: 2-3 small cloud models (for example Claude Haiku 4.5 and a small OpenAI and a small Gemini model from the registry) on the same 20 router prompts: report latency (median/p90), JSON validity rate and obvious quality. Use the result to pick the default router, main and reasoning models (you did not name them; I will propose them with the numbers). A local model test is optional, only if you ask.
7. Write the report, with a short go / no-go list for each later phase.

How to test / what "done" means
- Done = the report has numbers (median/p90) for each step, and a yes/no for each window item (a-h) under both XWayland and native Wayland.
- If router + main-model first token is much slower than the brief's targets (router about 1 s, first token about 2 s), STOP and discuss before Phase 1.
- If always-on-top does not work in either mode: STOP and discuss (the brief says not to build the window around an unusable feature).

Risks
- Microphone capture from a Node script may need a tool you have not installed. Mitigation: use whatever of arecord/parec/pw-record exists; otherwise ask.
- Web-search cost during 20+ runs. Mitigation: print token and search counts; ask before running more than a small batch.
- The test measures your network on one day. Note it in the report.

Effect on later phases (decision table, filled in at the end of 0B)
- Window result decides Phase 6 (XWayland or native, stay on top, fade behaviour) and Phase 14 (screen-share handling).
- Latency result decides whether the router must be local, the default model tiers, and the trigger interval.
- Screenshot portal result decides whether Phase 8 is built as planned.


-------------------------------------------------------------------------------
6. PHASES 1 TO 14
-------------------------------------------------------------------------------
Each phase lists: goal, files, steps, test and done, depends on, risks.
Paths marked NEW are new files. Everything else is an existing file that will change.

PHASE 1 - TRANSCRIPT BUS
Goal: one internal bus that every meeting provider feeds, and a live Transcript tab fed from it. (Soniox review is already done in 0A.)
Depends on: 0A.
Files:
- NEW src/copilot/main/transcriptBus.js (small EventEmitter wrapper: publish(event), subscribe(fn))
- NEW src/copilot/core/transcriptStore.js (pure: ordered segments with partial slots, in-memory window index of 30-60 s windows with overlap, per brief section 11)
- src/helpers/ipcHandlers.js: 3 one-line hooks: sendMeetingFinalSegment (about 6837), the partial closure (about 7002-7018), the two retract sites (about 7059, 8064). Each is a call like copilotBus.publish(...). Merge risk: small but in a large, busy file.
- NEW src/copilot/main/index.js (registers bus + IPC; called once from main.js)
- main.js: one require + one init call.
- preload.js and src/types/electron.ts: channels copilot-transcript-event (main to renderer) and copilot-get-transcript-snapshot.
Steps:
0. [IMP-16] Create ONE adapter file src/copilot/main/appAdapter.js: the only place copilot code reaches into app internals (bus attach, DB handle, window creation, IPC registration, existing events). Every later phase imports from it. Reason: upstream changes then touch one file.
1. Define the event shape: { id, source, type, text, timestamp, speaker? }. Speaker is optional because main does not know it at segment time (2.4).
2. Write transcriptBus + transcriptStore with unit tests (ordering, retract by id, partial replacement, window slicing by seconds).
3. Add the hooks in ipcHandlers.js. Add a unit test that fails if a hook is removed (a simple "publish called on final" test through a fake).
4. Add speaker updates: subscribe to meeting-speaker-identified (existing event) so late speaker labels update stored segments by time range. If this is awkward, ship without speakers on the Transcript tab and note it.
5. IPC: send events to the copilot window once it exists (Phase 3 creates the basic window; here use a debug window or the control panel for a text dump).
Test / done: unit tests pass; manual: with Soniox and with one existing provider, a live meeting shows the same segments on the bus (debug log). Transcript text is not logged unless debug logging is on.
Risks: hooks in ipcHandlers.js conflict on upstream merges. Mitigation: keep each hook to one line and use a single required helper.

PHASE 2 - ROUTER
Goal: trigger logic, router call with strict JSON validation, decision log, settings for the router model, a test box, and the evaluation script.
Depends on: 1, and 0B results (model choice, interval).
Files:
- NEW src/copilot/core/triggerRules.js (new final text, speaker pause or end-of-utterance, minimum N seconds (default 4), skip if running, cheap rules only raise priority, quiet level)
- NEW src/copilot/core/routerSchema.js (validator for the locked JSON in brief section 5; returns {ok, value} or {ok:false}; invalid = wait)
- NEW src/copilot/prompts/router.js (locked part + editable default + presets General, Client call, Sales call, Standup)
- NEW src/copilot/renderer/routerLoop.ts (calls the model through the AI SDK, with abort, timeout, one-call-at-a-time)
- NEW src/copilot/renderer/llmCall.ts (thin wrapper: provider+model from copilot settings -> getAIModel -> generateObject/generateText with JSON; abort signal; timing marks). First step: check if the installed AI SDK version offers generateObject and which providers honour JSON schema; if not, use prompt-enforced JSON plus validation.
- NEW src/copilot/renderer/copilotSettingsStore.ts (own zustand store, own localStorage keys prefixed "copilot", provider+model for router/main/summary; keys reuse the existing provider keys, no new key storage)
- NEW src/copilot/main/decisionLog.js (SQLite insert/update through database.js; see section 8)
- src/helpers/database.js: create copilot_decisions table in initDatabase.
- preload.js, src/types/electron.ts, src/helpers/ipcHandlers.js: channels for decision log insert/update. To keep ipcHandlers.js changes small, register these handlers from NEW src/copilot/main/ipc.js (called from index.js) instead of editing ipcHandlers.js.
- NEW test/copilot/triggerRules.test.js, routerSchema.test.js
- NEW test/copilot/eval/ (folder of transcripts with marked "help wanted" moments, JSON or markdown) and scripts/copilot/run-router-eval.mjs (runs the router over each transcript in simulated time; reports misses and false alarms; false alarms weighted more)
Steps:
1. Schema + validator + tests (including: unknown action, missing fields, confidence out of range, wrong thread format, extra text around JSON).
2. Trigger rules + tests (new text only; at most once per N s; skip when running; question-mark rule only raises priority).
3. Router prompt (locked + editable) and llmCall wrapper; unit test with a fake model.
4. Router loop wired to the bus (Phase 1) and a minimal debug panel that prints decisions and timings.
5. Decision log table and writes (time, window used, JSON, valid, latency, led-to-card, feedback). Transcript text stored only if debug logging is on.
6. Evaluation set: 8-10 transcripts to start (written by us together; you supply realistic ones). Script and a short report format.
7. Settings: router model picker (reuse existing model picker components if easy). Test box: paste transcript, see JSON and ms.
Added from your approved ideas:
- [IMP-4] Cheap pre-filter in triggerRules.js: skip the router for filler or very short text (under about 8 words and no question) unless a time limit has passed. Question phrases are overrides. Tested.
- [IMP-2] A small "decision log" view (in the debug panel first, in settings in Phase 6): recent router decisions including waits, with reason, confidence and latency.
- [IMP-3] Record-and-replay: a debug switch (off by default, with a warning) saves the live transcript stream (text, no audio) plus your "I wanted help here" mark button into test/copilot/eval/recorded/ in the eval format. Local only. NEW src/copilot/main/recorder.js.
- [IMP-17] The eval script can run two models or two prompts and print a side-by-side table (misses, false alarms, latency, invalid JSON rate).
- [IMP-10] Dismiss/thumbs-down feedback makes the router quieter for a few minutes (short cooldown, undo). Logic in triggerRules.js, fed from card feedback (Phase 3 stores it).
- Model roles: add scopes copilotRouter, copilotMain, copilotSummary to src/config/inferenceScopes.ts and every place listed in 2.6 (about 15 files; one commit-sized step per file group). cloudPurpose is a closed union in src/types/electron.ts; use "assistant" for these scopes (no OpenWhispr cloud features are used anyway). Router default model: set after 0B.
Test / done: unit tests pass; on the eval set the router is mostly quiet (target set after 0B, for example false alarms under 1 per 10 minutes of meeting; this is a guess to be tuned); every call logged with timing.
Risks: small models may break JSON often. Mitigation: validation + treat as wait; log invalid rate; allow retry-once only if latency allows; try a stronger small model. Local router may kick other local models out (one llama-server). Mitigation: allow a cloud router first.

PHASE 3 - MAIN MODEL AND CARDS
Goal: context builder with token budgets, streamed main-model call, card storage, and a basic card window.
Depends on: 1, 2.
Files:
- NEW src/copilot/core/contextBuilder.js (ordered pack from brief section 6, per-part budgets)
- NEW src/copilot/config/budgets.js (one config file for all budgets)
- NEW src/copilot/core/tokenEstimate.js (character-based estimate with a safety factor; reuse llamaContextPolicy estimateTokens only if importable without Electron, otherwise copy the 5-line heuristic)
- NEW src/copilot/prompts/main.js
- NEW src/copilot/renderer/mainCall.ts (streamText via AI SDK, abort, first-token timing)
- NEW src/copilot/main/windowManager.js (copilot BrowserWindow, always on top via setupAlwaysOnTop, loads ?copilot=true; basic size only; no content protection)
- src/AppRouter.jsx: one branch for ?copilot=true.
- src/helpers/windowManager.js: none, if the copilot window manager is independent (preferred). main.js: init call.
- NEW src/components/copilot/CopilotApp.tsx, CardFeed.tsx, Card.tsx, StatusLine.tsx, CopilotInput.tsx (basic)
- database.js: copilot_threads, copilot_cards tables.
- NEW test/copilot/contextBuilder.test.js (budget cuts, ordering, missing parts)
Steps:
1. Context builder + budget tests (each part capped; total capped; transcript window honours router seconds).
2. Main call wrapper and a card state machine (status: thinking, streaming, done, error; user-triggered errors visible, proactive errors silent).
3. Card storage (insert on create, update on finish) through IPC.
4. Basic window and card UI with streaming text; typed question goes straight to context builder (skips router).
5. Router decision -> card in Main thread.
6. Confidence label and sources fields on the card (filled by later phases; for now the model reports confidence, and says so when unsure; sources empty).
7. Timing: all marks in section 9.
Added from your approved ideas:
- [IMP-1] Prompt caching: keep the start of the pack (system prompt, meeting info, summary) byte-identical between calls and add the provider's cache markers through the AI SDK where supported (Anthropic; I have not verified the exact option names; check docs first). Measure time to first token with and without.
- [IMP-9] Cost meter: counts of router calls, main calls, tokens (as reported by the provider) and web searches per meeting, shown in the window footer; optional daily cap (off by default). NEW src/copilot/core/usageMeter.js.
- [IMP-10] Card feedback (dismiss, thumbs) is stored and passed to the router cooldown.
- [IMP-15] Crash recovery basics: the orchestrator state needed to resume (current thread, running summary version, last processed segment id) is saved after each step so a reloaded window can resume.
- Window: opens automatically when a meeting recording starts (your answer D11): subscribe through the adapter to the meeting start (record start) event; setting to turn this off.
Test / done: a typed question or router decision produces a streamed card in Main; budget tests pass; timing visible in debug logs.
Risks: prompt makes the model overconfident. Mitigation: the locked part forces a confidence label and "say you are not sure"; evaluate in Phase 2 style with a few trap questions.

PHASE 4 - WEB SEARCH AND ROLLING SUMMARY
Goal: web search with sources on cards; incremental rolling summary with pinned corrections.
Depends on: 3, 0B (web search choice).
Files:
- NEW src/copilot/renderer/webSearch.ts (one function: search(query, tier) -> {text, sources[]}); provider built-in search through the AI SDK (Anthropic or OpenAI tool); off with a clear message for providers without it. (You chose no OpenWhispr Cloud search.)
- NEW src/copilot/renderer/summaryService.ts, src/copilot/core/summaryMerge.js (previous summary + new transcript -> structured summary; pinned corrections always passed)
- NEW src/copilot/prompts/summary.js
- database.js: copilot_summaries table.
- NEW src/components/copilot/ContextView.tsx (summary view with edit and pinned corrections), SourceList.tsx
- Copilot settings store: web search on/off, summary interval (default 3 min), summary model.
Steps:
1. Pick the tool for the chosen main provider using the 0B numbers. Check the provider's current docs for tool name, limits and price before coding (brief requirement).
2. Web search function + tests with a fake; sources appear on the card.
3. Run web search and project search in parallel in the context builder (brief section 4).
4. Summary service: interval timer, only if new transcript, never blocks, keeps old summary on failure. Tests for the merge input building (previous + delta only, corrections included).
5. Context tab UI: show summary, edit, pin corrections; edits stored as pinned corrections (never overwritten by the model).
6. "summarize_now" router action wired.
Test / done: a web question shows a card within about 3 s first content (target to be tuned), with sources; summary updates every interval and keeps corrections; failure keeps the old summary.
Added: [IMP-7] tapping a source on a card shows the exact snippet used (web snippet or chunk), not only the title.
Risks: provider search tools differ in format and cost. Mitigation: a single adapter function; fall back to "web search unavailable" shown clearly.

PHASE 5 - PROJECT CONTEXT (RAG)
Goal: projects of files, chunked and indexed, searched by meaning plus keyword, plus past meetings, with sources on cards.
Depends on: 3. (Google Docs link import is moved entirely to Phase 12; Phase 5 covers .docx and PDF only. See section 11.)
Files:
- NEW src/copilot/core/chunker.js (200-300 tokens, overlap, keeps file name and position; unit tested)
- NEW src/copilot/core/rrf.js (small pure copy of the merge; unit tested)
- NEW src/copilot/main/projectIndex.js (own Qdrant collection "copilot_chunks" via vectorIndex.client when Qdrant is running; own FTS5 table copilot_chunks_fts; embedding through localEmbeddings.embedTexts)
- NEW src/copilot/main/fileIngest.js (read .docx and PDF to text)
- NEW src/copilot/main/pastMeetingIndex.js (chunk note content and transcript into the same index with kind="meeting", title and date as source)
- package.json: PDF reader (candidate: unpdf or pdfjs-dist) and DOCX reader (candidate: mammoth). Reading only, approved (D7). Check licence, size, and that they work in the Electron main process. Install with Node 24 only.
- database.js: copilot_projects, copilot_project_files, copilot_chunks_fts.
- src/helpers/vectorIndex.js: probably a small addition (generic upsert/search for an arbitrary collection) OR none if we use vectorIndex.client directly from our own code (preferred; no change). Decide in step 1.
- NEW src/components/copilot/ProjectsPanel.tsx (create project, add files/folder, remove, status ready/indexing/failed, checkbox per meeting)
Steps:
1. Read vectorIndex.js, semanticSearchLifecycle.js again at implementation time. Decide how to get a live Qdrant client without touching the lifecycle: ensure the lifecycle is awake with a harmless call, or start Qdrant through qdrantManager directly. Check that our collection survives the lifecycle's idle shutdown and restarts. Do not edit those files unless unavoidable.
2. Chunker + tests.
3. Embedding limit check: model takes 256 tokens max, so chunks must stay under about 200 tokens in practice. This conflicts with the brief's 200-300 range. Set the chunk target to about 150-200 tokens, verified by a test using the worker's tokenizer. (See section 11.) If quality is poor, make the embedding model swappable in our own code (own subdirectory, own dim constant), without changing the notes pipeline.
4. File ingest for .docx and PDF; errors shown per file.
5. Indexer with status, resumable, runs in the background, never blocks the UI.
6. Hybrid search (FTS5 + vector) + RRF; return top few chunks with file name and position.
7. Past meetings: index notes and transcripts at idle time and on note save; search with title and date as source.
8. Warm-up when a meeting starts: wake Qdrant and the embedding model (about 22 MB model; downloaded on first use).
9. Context builder takes project chunks and past-meeting results with budgets; card sources show them (with the snippet, [IMP-7]).
10. [IMP-19] Hot words: collect names and terms from checked projects (capitalised words, repeated rare words; capped at 100) and pass them as Soniox context terms at meeting start. Measure on a known document in 0A-style test; keep it only if the transcript improves.
Test / done: unit tests for chunker/rrf; a 50-page PDF and a .docx are indexed and a question about the last page finds it; first search after idle is not slow after warm-up (measure; report); cold-start fallback to FTS5 only is shown clearly.
Risks: embedding model too weak (MiniLM, 256 tokens). Mitigation: keyword search covers exact terms; swappable embedder in our code; measure recall on a small test set. Qdrant lifecycle idle shutdown could break our collection. Mitigation: step 1 check; fallback is FTS5 only.

PHASE 6 - FULL WINDOW AND SETTINGS
Goal: compact and expanded views, transparency, presenting mode, hotkeys, and the Copilot settings section with prompts, presets, reset and the router test box.
Depends on: 2, 3, 0B (window decisions).
Files:
- NEW src/components/copilot/ (CompactView.tsx, ExpandedView.tsx, TranscriptView.tsx with auto-scroll/jump-to-latest/select lines/bookmark, header, tooltips on every icon button)
- NEW src/copilot/main/windowManager.js (extended: sizes, opacity, fade-when-idle driven by a "new card" IPC, solid on hover, minimum opacity, presenting mode minimize/restore, position handling per 0B)
- NEW src/components/copilot/settings/CopilotSettings.tsx (models, speech provider, prompts, behaviour, projects, hotkeys)
- src/components/SettingsPage.tsx (add "copilot" to SettingsSectionType and a case), src/components/SettingsModal.tsx (sidebar item): small edits.
- Hotkeys (3 new slots: copilotToggle, answerNow, presentingToggle): hotkeyManager.js, gnomeShortcut.js, kdeShortcut.js, hyprlandShortcut.js, main.js, ipcHandlers.js (or NEW src/copilot/main/hotkeys.js where possible), preload.js, electron.ts, SettingsPage.tsx validators, locales. About 10 files; this is the largest merge-risk item in the plan. Alternative to reduce risk: a single slot "copilot" that toggles the window, and other actions as in-window keys (see section 11, item 5). Decision for you.
- All strings: English in en, same English copied to the other 10 locales (A3); run npm run i18n:check and the translation coverage test.
Added from your approved ideas:
- [IMP-13] In settings, next to each feature a line saying what leaves the machine and to which provider (transcript window to the router provider, chunks and transcript to the main provider, screenshot to the main provider, search query to the web search).
- [IMP-18] Meeting-type suggestion: guess the preset from the calendar title and attendees; shown as a suggestion, never applied silently.
- [IMP-2] Decision log view in settings (from Phase 2).
- [IMP-8] A single status dot with one line (listening, transcript provider down, router down, search off, index not ready), the visible half of Phase 15.
- Window opens automatically on recording start (D11) with a setting to turn it off.
- Strings: English only, copied to the other 10 locales (A3); keys listed in docs/copilot/untranslated-keys.md.
Steps:
1. Compact view first (feed + input + header), then Transcript view, then Context view hookup.
2. Expanded four-pane view (state kept when expanding; running requests unaffected).
3. Opacity slider, fade-when-idle, solid on new card and hover, minimum opacity. Behaviour per 0B.
4. Presenting mode: manual toggle + hotkey (always works); window becomes a small icon.
5. Settings section: models (with reset), STT provider mark "recommended" on Soniox, behaviour, projects, hotkeys.
6. Prompts UI: locked part read-only, editable part, presets, reset, router test box (reuses Phase 2).
7. Push-to-talk mic in the input: works only while the window is focused (hold a key or the button); its audio goes to a separate capture path, is never sent to the meeting transcript, and (assumption A8) the meeting mic stream is dropped while held. Implementation detail needs a read of how the meeting mic worklet can be gated; if a gate does not exist, adding one touches meetingRecordingStore.ts (existing file). Decide at that step.
8. Manual test checklist on your Ubuntu (XWayland and, if used, native Wayland).
Test / done: window behaviour matches the 0B report; i18n tests pass; prompts reset works; hotkeys toggle from another app.
Risks: 11-locale cost; hotkey slot merge conflicts; transparency/always-on-top not as hoped (then follow the 0B decision). Mitigation: scope hotkeys down; translation in batches.

PHASE 7 - THREADS
Goal: custom threads, parallel requests, Recents, concurrency limit, cancel.
Depends on: 3, 6.
Files:
- NEW src/copilot/core/requestQueue.js (limit default 3; Main has priority; cancel; pure and unit tested)
- src/copilot/renderer/ (orchestrator uses the queue; one AbortController per request)
- NEW src/components/copilot/ThreadTabs.tsx, RecentsList.tsx; plus button; "Sending to: <thread>" selector in the input
- database.js: copilot_threads fields for title, meeting link, timestamps.
Steps: queue + tests (limit, priority, cancel, a thread request never blocks router or transcript); thread storage; UI; Recents across meetings; [IMP-15] on window reload, rebuild threads, cards and the router loop from SQLite and resume (test by reloading the window mid-meeting).
Test / done: three parallel threads run, the fourth waits; Main preempts waiting ones; cancel stops streaming; router never delayed (measure router latency while 3 threads stream).
Risks: renderer main-thread jank with many streams. Mitigation: batch UI updates (for example every 50 ms) per card.

PHASE 8 - SCREENSHOT
Goal: screenshot on demand (router asks or button), memory only, with a visible indicator every time one is sent.
Depends on: 3, 0B screenshot result.
Files:
- src/helpers/screenContextCapture.js: add a portal-based path for Wayland sessions OR NEW src/copilot/main/screenshot.js that wraps it (preferred, no edit).
- NEW indicator component in the card UI.
- The model must accept images. The AI-SDK path supports images for providers marked supportsImages (anthropic confirmed; others not checked). Check the chosen main model.
Steps: portal call (gdbus org.freedesktop.portal.Screenshot) or XWayland desktopCapturer according to 0B; Soniox-independent; in-memory buffer, never written to disk or DB (brief rule; add a test that asserts no fs write in the module); size budget (reuse encodeWithinBudget ladder); indicator "screenshot sent" on the card; setting off by default except on demand.
Test / done: button and router-triggered screenshot reach the model; indicator always shows; nothing on disk.
Risks: portal prompts every time on GNOME. Mitigation: report after 0B; if unacceptable, button-only, or drop the feature. Also note the existing code treats XWayland as Wayland (isWaylandSession) and skips capture. Our wrapper needs its own check.

PHASE 9 - START AND END OF MEETING, POST MEETING
Goal: opening suggestion card from the meeting plan, closing recap card, save threads and summary into the note, click-to-confirm action buttons (for example draft follow-up text shown in the app).
Depends on: 3, 4, 7.
Files:
- NEW src/copilot/core/meetingLifecycle.js (start/end hooks; end time from calendar event if present, else user timer)
- NEW src/copilot/main/noteLink.js (writes threads + final summary into the note; format decided: a "Copilot" section appended to note content in Markdown; or copilot tables referenced by note id. Recommendation: both; tables hold the data, a short Markdown section holds the summary and links.)
- src/helpers/database.js: copilot tables linked by note_id (no change to the notes table).
- Possibly NEW getCalendarEndTime IPC in src/copilot/main/ipc.js using existing databaseManager.getCalendarEventById.
Added: [IMP-11] consent reminder card at meeting start (one line: recording and AI help may need other people's consent; link to a short editable text for your own wording; can be turned off). Not legal advice.
Steps: detect meeting start from the bus (first segment or meeting-start event; read how meeting start/stop events reach main); plan-based opening card; end-time timer; recap card; save into note on stop (the renderer persists the note at stop; avoid racing it by writing after note save, or writing to our tables and reading them in the note view); action buttons produce a preview; nothing is sent anywhere (brief rule).
Test / done: a test meeting produces start and recap cards; note contains the copilot section; copilot tables link to the note.
Risks: the renderer overwrites the note content at stop. Mitigation: write our section after, or keep it only in our tables and show it in a copilot tab on the note.

PHASE 10 - TALKING POINTS CHECKLIST
Goal: the meeting plan holds a checklist; points are ticked from the transcript; manual choice always wins; end-of-meeting nudge.
Depends on: 4, 6, 9.
Files: NEW src/copilot/core/talkingPoints.js (parse plan into points, merge manual and model ticks); NEW src/copilot/prompts/talkingPoints.js (cheap structured call); NEW src/components/copilot/Checklist.tsx; progress count in compact header; database copilot_talking_points (or JSON in the meeting record).
Steps: parser + tests; model check on summary interval and on router runs (can share a call, to save cost); manual overrides stored and never overwritten; nudge near end.
Test / done: in a test meeting, points tick with few wrong ticks (measure wrong ticks on the eval transcripts). Risks: false ticks. Mitigation: require evidence quote from the transcript in the structured output, show it on hover.

PHASE 11 - COMMITMENT CAPTURE
Goal: detect "I will send this by Friday"; list with who/what/when; edit, delete, approve; copy list or save into the note on click.
Depends on: 1, 9.
Files: NEW src/copilot/core/commitments.js; NEW src/copilot/prompts/commitments.js; NEW src/components/copilot/Commitments.tsx; database copilot_commitments.
Steps: structured extraction on final segments in batches (not every segment; piggyback on the summary or router call to save cost); who = speaker (mic = "you", system = identified name or "other"; speaker accuracy is limited, see 2.4); relative dates like "Friday" resolved against the meeting date and shown with the original words; UI; copy to clipboard and save to note.
Test / done: eval transcripts with marked commitments: report false and missed items. Risks: wrong attribution of speaker; wrong due date. Mitigation: show the original sentence and time; never auto-approve.

PHASE 12 - GOOGLE DOCS AND LOCAL DOCUMENTS
Goal: Google Docs by shared link (fetch, convert, index, refresh, paste into input) and local document creation (Markdown only) after Save.
Depends on: 5, 3.
Files: NEW src/copilot/main/googleDoc.js (parse doc id from the link, fetch export, convert); NEW src/copilot/main/docWriter.js (Markdown write only; no .docx, per D7); NEW src/components/copilot/ActionCard.tsx; settings: output folder (folder picker; existing dialog IPC for directories exists); ProjectsPanel refresh button; refresh at meeting start.
Steps:
1. Runtime test first: fetch export?format=txt (and html/md) for a link-shared doc and for an unshared doc. Report format and the unshared behaviour. This item could not be checked in the planning phase.
2. Fetch with main-process network code (check docs/network-allowlist.md; this repo has an allowlist document, so a new host such as docs.google.com may need to be listed there. Read it first.)
3. Convert, index as a project file of kind "gdoc", refresh button and refresh on meeting start. Clear error when not shared.
4. Paste link in the input = use now, with "add to project" choice.
5. Doc creation: the copilot writes a document, shows an Action card with a preview; Save writes to the chosen folder; link added to the note. Markdown only. Nothing is uploaded.
Test / done: answer from a shared doc; create a local file only after Save; file link in the note. Risks: Google changes the export format or rate-limits. Mitigation: show clear error; keep file import as the fallback.

PHASE 13 - AUTOMATIC THREAD ROUTING
Goal: turn on the router's thread field; unsure means Main; move-card-to-thread in UI.
Depends on: 2, 7.
Files: router prompt and validator (field already in the locked JSON from Phase 2; here the loop acts on it); ThreadTabs card "move" action; decision log field thread_chosen and thread_corrected.
Steps: act on "main | new:title | id" with validation (unknown id = main); show thread on each card; log choices; extend eval set with thread labels; tune.
Test / done: on eval transcripts, cards land in sensible threads and wrong routing is rare (target set from the first eval run). Risks: too many new threads. Mitigation: cap new threads per 10 minutes; prefer Main.

PHASE 14 - AUTOMATIC SCREEN SHARE DETECTION
Goal: research first, then minimize while sharing if it is reliable.
Depends on: 6, 0B item h.
Files: NEW docs/copilot/phase14-report.md; if feasible NEW src/copilot/main/screenShareWatcher.js.
Steps: research (read-only) what GNOME exposes: PipeWire video streams with the "screen cast" role (for example via pw-dump), the org.gnome.Mutter.ScreenCast session list over D-Bus, the GNOME screen-sharing indicator. Test with Meet, Zoom, Teams and Discord on your machine, in browser and native app. Report reliability per app.
If reliable: watcher with settings switch; if not: keep manual toggle and say so in the UI and in the report.
Test / done: report with a per-app table. Risks: works only for some apps. Mitigation: ship only if reliable; otherwise do not ship it silently.


-------------------------------------------------------------------------------
7. EXISTING FILES THAT WILL CHANGE (merge-risk list)
-------------------------------------------------------------------------------
Risk: H = high chance of upstream conflict, M = medium, L = low.

Phase 0A
- src/helpers/sonioxStreaming.js (yours; no upstream conflict) - L
- src/helpers/meetingStreamingProviders.js - L (small file, 2 lines)
- src/helpers/meetingTranscriptionRouting.js - L
- src/helpers/realtimeTokenProviders.js - L
- src/helpers/ipcHandlers.js - target zero; if needed, a few lines - M
- src/models/modelRegistryData.json (maybe) - M (large, edited often upstream)
- meeting provider picker component (to be found) - M
- 11 locale translation.json files - M (every upstream UI change touches them)
- tests listed above - L
Phase 1-2
- src/helpers/ipcHandlers.js: 3 one-line hooks - M (file is huge and busy)
- main.js: init call - L
- preload.js, src/types/electron.ts: new channels - M (both busy; appended blocks keep conflicts easy to resolve)
- src/helpers/database.js: new tables in initDatabase - M
Phase 3
- src/AppRouter.jsx: one branch - L
Phase 6
- src/components/SettingsPage.tsx, SettingsModal.tsx - M
- hotkeyManager.js, gnomeShortcut.js, kdeShortcut.js, hyprlandShortcut.js, SettingsPage.tsx validators - M to H (see Phase 6 option to use one slot)
Phase 5, 8, 9 (conditional)
- src/helpers/vectorIndex.js, screenContextCapture.js, meetingRecordingStore.ts (push-to-talk gate) - only if the preferred no-edit route fails
Always
- package.json and package-lock.json (new dependencies; lockfile must be built with Node 24)
- CLAUDE.md: add a short copilot section at the end (and note the Soniox lines already added)
Added by your answers (A1, D5):
- Scopes (Phase 2), about 15 files: src/config/inferenceScopes.ts, src/stores/settingsStore.ts (about 10 places), src/hooks/useSettings.ts, src/types/electron.ts, src/helpers/localServerPolicy.js (only if a scope can run locally; it can, so yes), src/helpers/enterpriseManagedConfig.mjs, src/helpers/reasoningRouting.js, src/components/settings/InferenceConfigEditor.tsx, src/components/SettingsPage.tsx, src/components/SettingsModal.tsx, 11 locale files. Merge risk H for settingsStore.ts and SettingsPage.tsx (upstream edits them often). secretKeys.js and preload.js are NOT needed: the scopes reuse existing provider keys; only a per-scope custom-endpoint key would need them, and I skip that (custom endpoint for copilot scopes unsupported in v1, to save files).
- Speaker field (Phase 0A step 9): ipcHandlers.js, meetingSegmentReducer.ts, meetingRecordingStore.ts, electron.ts: M.
Still not changed on purpose: ReasoningService.ts, semanticSearchLifecycle.js, localEmbeddings.js, onnxWorker.js.


-------------------------------------------------------------------------------
8. DATABASE CHANGES
-------------------------------------------------------------------------------
Pattern (from database.js): CREATE TABLE IF NOT EXISTS inside initDatabase(); new columns via try/ALTER ignoring duplicate; data migrations gated by PRAGMA user_version (do not use unless needed). The notes table is not changed.
All tables carry account_id only if notes do (check database.js 1408 pattern at implementation; multi-account scoping is an open detail).

copilot_decisions (Phase 2): id, meeting_note_id, created_at, window_start_ms, window_end_ms, transcript_text (NULL unless debug logging), decision_json, valid (0/1), router_model, router_ms, led_to_card_id, thread_chosen, feedback.
copilot_threads (Phase 3, 7): id, meeting_note_id, title, kind (main|custom), created_at, closed_at.
copilot_cards (Phase 3): id, thread_id, kind (answer|suggestion|question|search|action), title, body, sources_json, confidence, status, feedback, pinned, intent, model, tier, created_at, finished_at, timing_json.
copilot_summaries (Phase 4): id, meeting_note_id, version, content, pinned_corrections_json, created_at.
copilot_projects (Phase 5): id, name, created_at.
copilot_project_files (Phase 5, 12): id, project_id, kind (file|gdoc), path_or_url, name, status, error, indexed_at, content_hash.
copilot_chunks_fts (Phase 5): FTS5 virtual table of chunk text with chunk id, source kind (file|meeting), source id, position.
copilot_meeting_projects (Phase 6): meeting_note_id, project_id (checked projects per meeting).
copilot_talking_points (Phase 10), copilot_commitments (Phase 11): small tables keyed by meeting_note_id.
Qdrant: new collection "copilot_chunks" (384 dims, cosine, payload kind/source/position). Not a SQLite change; created by our code.
Index of old meetings (Phase 5) records what was indexed (note id, updated_at) in a small table copilot_indexed_notes to avoid re-embedding.


-------------------------------------------------------------------------------
9. SETTINGS, SCOPES AND TIMING
-------------------------------------------------------------------------------
Settings (own store, localStorage keys "copilot.*" for behaviour; secrets reuse existing provider keys, nothing new except the Soniox key you already added):
- models: live in the three shared scopes (below); the copilot store keeps only a per-role "enabled" flag
- stt: meeting provider (existing setting; Soniox marked recommended), fallback STT (A5)
- prompts: router/main/summary editable text, preset id, reset
- behaviour: routerIntervalSeconds (default 4), quietLevel (low|normal|high), reactTo (everyone|other people), allowWebSearch, allowScreenshots, fadeWhenIdle, opacity, summaryIntervalMinutes (default 3), maxParallelRequests (default 3), end-of-meeting timer minutes, output folder, autoOpenOnMeeting (default on), consentReminder (default on), retentionDays (default 90), redactForCloud (default off), recordForEval (default off), dailyCallCap (default off)
- hotkeys: copilotToggle, answerNow, presentingToggle (or one slot, see Phase 6)
- window: size, compact/expanded (position only if 0B shows it can be restored)
Inference scopes (A1): copilotRouter, copilotMain, copilotSummary are added to src/config/inferenceScopes.ts with storeKeys for mode, provider, model (no custom key, no cloudBaseUrl in v1), fallbackScope (copilotSummary falls back to copilotRouter; copilotMain has none; the reasoning tier is a second model field on the copilotMain scope's own copilot-store setting, or a fourth scope copilotReasoning if the picker needs it; decide in Phase 2). cloudPurpose "assistant". Router default: a small cloud model chosen in 0B. The copilot reads them with selectResolvedLLMConfig and builds the model with getAIModel. Settings sync across devices: the app syncs only dictionary and snippets, so copilot settings stay local.

Timing from the first version (starting in Phase 2):
- NEW src/copilot/core/timing.js: createTrace(flow) with mark(name) using performance.now() (monotonic) and wall time at the start; summary() returns a table.
- Marks per flow: transcript_final (time the final segment arrived at the bus, plus the provider's own timestamp when available), trigger_fired, router_start, router_end, context_start, context_end, request_sent, first_token, done.
- Derived: router_ms, context_ms, ttft_ms (request_sent to first_token), total_ms, and end_to_first_token from transcript_final.
- Stored: router_ms in copilot_decisions; the full trace in copilot_cards.timing_json.
- Shown: debug logs (existing debugLogger) and a small developer readout in the window when debug logging is on.
- Phase 0B uses the same names in the script, so numbers compare directly.
- Clock note: time from "end of speech" to "final text" includes Soniox's own delay and cannot be seen from our marks alone; the 0B script reports it separately.


-------------------------------------------------------------------------------
10. WHAT STAYS TRUE THROUGH ALL PHASES
-------------------------------------------------------------------------------
- No outward actions. No sending, uploading, sharing, task tools, Slack, Drive, Google sign-in. Local files only after Save.
- No transcript text in logs unless debug logging is on. No keys in logs.
- Screenshots in memory only.
- All UI strings through i18n (11 locales).
- Node 24 for installs.
- Each phase works and is tested before the next.
- Phase 0B can change later phases (window, models, web search, screenshots, hotkeys, router local or cloud).


-------------------------------------------------------------------------------
11. RECOMMENDED CHANGES TO THE BRIEF (NOT APPLIED)
-------------------------------------------------------------------------------
1. Section 17 / Phase 0: the app already runs through XWayland. Test XWayland first, native Wayland second.
2. Section 9 (scopes): I recommended own settings only. You chose "both" (A1), so the plan follows the brief for model roles (shared scopes) and keeps everything else in the copilot's own store. Kept here so the reasoning stays visible.
3. Section 6 (web search): provider built-in only (D3). It is new code, not a small change.
4. Section 11 (chunk size 200-300 tokens): the embedding model reads 256 tokens at most, with the first token slots used by markers. Use about 150-200 tokens per chunk, or change the embedder.
5. Section 9 (hotkeys): three new hotkey slots cost about 10 files each time upstream changes slot code. Consider one global toggle hotkey and in-window shortcuts for the rest (GNOME only supports toggles anyway).
6. Speaker labels: done by your answer D5 (Phase 0A steps 8-9), on both streams, namespaced by stream.
7. Phase 5 vs Phase 12: Google Docs appears in both. Keep it only in Phase 12.
8. Phase order: a basic window (Phase 3) before Phase 6 is fine. Consider moving "Phase 7 threads" after "Phase 9" if you want end-to-end value sooner. Not needed; only if the schedule is tight.
9. Add Soniox India region (stt-rt.in.soniox.com) next to US/EU/JP in Phase 0B.
10. Add "Phase 0A" as written here. It was not in the brief.
11. CLAUDE.md language count (9/10) is wrong; the repo has 11 locales. Brief section 15 says "all language files"; this plan follows the repo.
12. The meeting-mic problem (A8): push-to-talk and the live meeting share one microphone. The brief says the copilot mic must not enter the transcript; the plan drops meeting mic audio while held. People on the call will still hear you unless you mute.


-------------------------------------------------------------------------------
12. YOUR ANSWERS (applied above)
-------------------------------------------------------------------------------
1. Desktop: checked by me: Ubuntu 26.04.1, GNOME 50.1, Wayland, PipeWire.
2. XWayland: I check at 0B; the app forces it today.
3. Router: small cloud model. Main and reasoning models: chosen with 0B numbers (still open for you to confirm then).
4. Web search: provider built-in only. No OpenWhispr account features.
5. Model settings: "both" (read as A1; tell me if wrong).
6. Soniox diarization on both streams (D5).
7. Soniox region: US only.
8. Dependencies: PDF and DOCX reading only.
9. Translations: English now (A3).
10. Own chunked past-meeting index: yes.
11. Push-to-talk drops meeting mic: yes.
12. Window opens automatically on recording start: yes.
13. Git: leave Soniox work as is, no commit or rebase.
Still open (not blocking Phase 0A): main and reasoning default models; fallback STT (A5); retention days (A8); account scoping (A6).


-------------------------------------------------------------------------------
13. POSSIBLE IMPROVEMENTS AND ADDITIONAL CHANGES
-------------------------------------------------------------------------------
STATUS: you approved all of them. They are now merged into the phases, tagged [IMP-n] with n = the number below. Those that did not fit a single phase are in Phase 15. The text below is kept as the reference (reason, impact, risk).
Original note: ordered by value (impact against effort), best first.
Not included on purpose: task tools, Slack, Drive, sign-in/OAuth, anything that sends or uploads, and anything the brief already covers.

1. Prompt caching for the main model
   - What: keep the stable start of the context pack (system prompt, meeting info, summary) identical between calls so the provider can cache it.
   - Why: lower cost and lower time to first token on every card.
   - Impact: high. Effort: low. Risk: low; provider-specific (Anthropic needs cache markers through the AI SDK; I have not verified the exact option names).
   - Phase: 3 (context builder ordering, which the brief already puts stable parts first).
   - Decision needed: no.

2. "Why this card" and "why not" in the decision log view
   - What: a small debug view listing recent router decisions (including waits) with the reason and confidence.
   - Why: tuning the router is much faster when you can see misses and false alarms in a real meeting. The brief logs this but gives no way to look at it.
   - Impact: high. Effort: low. Risk: none. Phase: 2 or 6. Decision: no.

3. Record-and-replay of real meetings for the evaluation set
   - What: a debug switch that saves the transcript stream (not audio) of a real meeting, with your own "I wanted help here" marks, into the eval folder format.
   - Why: invented transcripts do not match real meetings; replay gives honest false-alarm numbers.
   - Impact: high. Effort: medium. Risk: stores transcript text on disk; local only, off by default, clear warning. Phase: 2. Decision: yes (privacy: you decide when it may be on).

4. Cheap pre-filter before the router
   - What: skip the router call when the new text is only filler or very short (for example under 8 words with no question) unless a time limit passed.
   - Why: many router calls would be "wait". Fewer calls means lower cost and less noise. The brief's rules only raise the chance of a call; this lowers it.
   - Impact: high. Effort: low. Risk: missing a short but important question ("Can you share the price?"). Mitigation: keep the question rules as overrides. Phase: 2. Decision: no.

5. Answer-first "draft" card for obvious questions
   - What: when the router is confident and the question is simple, start the main call at once, in parallel with context building, using only transcript and summary; add project or web facts as a second update.
   - Why: lowers perceived delay; the brief already says to run work in parallel, this goes one step further.
   - Impact: medium to high. Effort: medium. Risk: a draft answer that later changes can confuse. Mitigation: label "updating" until sources are in. Phase: 3-5. Decision: yes (UX).

6. Grounding check for answers that cite sources
   - What: after a card finishes, a cheap check that numbers and names in the answer actually appear in the sources shown; if not, lower the confidence label or add a "not found in sources" note.
   - Why: the brief makes wrong confident answers the worst outcome; the model's own confidence label is not reliable.
   - Impact: high. Effort: medium. Risk: extra cost; false flags. I am not sure how well a cheap model does this; test on the eval set first. Phase: 3-5. Decision: no.

7. Show the source passage, not only the file name
   - What: tapping a source on a card shows the exact chunk or web snippet used.
   - Why: lets you verify an answer in a few seconds without leaving the meeting.
   - Impact: medium. Effort: low. Risk: none. Phase: 4-5. Decision: no.

8. Degraded modes when things fail
   - What: a visible state per dependency: transcript provider down (switch to a second provider or local), router model down (manual-only mode), web search down (turn off with notice), embeddings not ready (keyword only). One status dot, one line.
   - Why: in a live meeting you must know at once what the copilot cannot do. The brief says to fail quietly for proactive calls, but a silent copilot looks like "nothing to say".
   - Impact: high. Effort: medium. Risk: none. Phase: 2, 4, 5, 6. Decision: yes (what should the fallback STT be?).

9. Time and cost meter
   - What: per meeting count of router calls, main calls, tokens and web searches, shown in settings or the window footer, with an optional daily cap.
   - Why: a router that runs every 4 seconds for an hour can cost real money; the first long meeting should not be a surprise.
   - Impact: medium to high. Effort: low. Risk: price tables go out of date; show counts, not currency, unless you want prices. Phase: 3. Decision: yes (counts only, or money too).

10. Router "cooldown after a dismiss"
   - What: if you dismiss or thumbs-down a card, the router goes quieter for a few minutes on that topic.
   - Why: direct use of feedback to reduce annoyance; the brief logs feedback but does not use it live.
   - Impact: medium. Effort: low. Risk: too quiet after one accident. Mitigation: short cooldown, undo. Phase: 2, 3. Decision: no.

11. Consent and disclosure helper
   - What: a one-line reminder at meeting start that recording and AI assistance may need the other people's consent, with a link to a short text for your own wording. Setting to turn the reminder off.
   - Why: the tool records other people; laws differ by country and company rules. The brief says the tool is visible and not hidden, but has no consent step.
   - Impact: medium. Effort: low. Risk: none, but it is not legal advice. Phase: 9. Decision: yes.

12. Retention settings for stored transcripts and cards
   - What: auto-delete copilot data (cards, decision logs with text, project chunks of past meetings) after N days; one button to delete everything for a meeting.
   - Why: transcripts and client data accumulate in SQLite and in Qdrant; and the past-meeting index (Phase 5) makes old content searchable.
   - Impact: medium. Effort: medium. Risk: deleting data you wanted. Phase: 5, 9. Decision: yes (default retention).

13. Tell the user what leaves the machine, per feature
   - What: in settings, next to each feature, a line saying which provider receives what (transcript window to the router provider, chunks to the main provider, screenshot to the main provider, query to web search).
   - Why: cloud models receive meeting content, including other people's words. The brief covers screenshots but not transcript and file chunks going to cloud models.
   - Impact: medium. Effort: low. Risk: none. Phase: 6. Decision: no.

14. Redact before sending to cloud models (optional)
   - What: an optional setting to mask emails, phone numbers and card-like numbers in text sent to the router and summary models.
   - Why: smaller leak surface for sensitive meetings.
   - Impact: medium. Effort: medium. Risk: masking can hurt answer quality; regex redaction misses names. Uncertain it is worth it for you; only if client work is sensitive. Phase: 3. Decision: yes.

15. Keep window and orchestrator state in main for crash recovery
   - What: if the copilot window crashes or reloads, restore threads, cards and running summary from SQLite (already stored) and resume the router loop.
   - Why: renderer-side orchestration (2.6) means a window reload resets the live state mid-meeting.
   - Impact: medium. Effort: medium. Risk: low. Phase: 3, 7. Decision: no.

16. A small shared "copilot SDK" boundary
   - What: all copilot code talks to the app only through one adapter file (bus subscribe, DB, window, IPC register, settings).
   - Why: simpler upstream merges and easier tests; if upstream changes, one file changes.
   - Impact: medium. Effort: low. Risk: none. Phase: 1. Decision: no. (The plan mostly does this already: src/copilot/main/index.js and ipc.js.)

17. Router A/B and model comparison in the eval script
   - What: run the same eval set against two router models or prompts and print a side-by-side table (misses, false alarms, latency, invalid JSON rate).
   - Why: picking the router model on numbers instead of feel.
   - Impact: medium. Effort: low. Risk: none. Phase: 2. Decision: no.

18. Meeting-type detection to pick the preset
   - What: guess "client call, sales, standup" from the calendar title and attendees and pre-select the preset.
   - Why: saves one click per meeting.
   - Impact: low to medium. Effort: low. Risk: wrong guesses; keep it a suggestion. Phase: 6. Decision: no.

19. Hot-word list for speech recognition from the project files
   - What: feed names and terms found in checked projects to Soniox as context terms (Soniox supports context terms; your code already passes keyterms).
   - Why: better transcript of client names and product terms, so better router and answers.
   - Impact: medium. Effort: medium. Risk: too many terms (code caps at 100); needs term extraction. Not sure of the quality gain; test in 0A with a known document. Phase: 5. Decision: no.

20. Gaps in the brief worth settling
   - Account scoping: notes have account_id; the brief does not say whether copilot data is per OpenWhispr account. Decide before Phase 3 tables.
   - Meeting start detection: the brief says "meeting starts" for warm-up and start card, but not which event (record start, calendar join). Plan uses record start.
   - Window behaviour when no meeting is running: closed, or usable for ad-hoc questions with no transcript? The plan assumes it can open anytime.
   - Language: the router and cards answer in the meeting language or the UI language? Not stated.
   - Echo and headphones: the router can see the user's own mic speech as "mic" and the remote side as "system". Whether router help should treat the two differently (for example only react to what the OTHER side asked) is not stated. I think it should be configurable; not sure of the best default.
   - Offline: no stated behaviour when there is no network (cloud STT and cloud models both fail).
   - Cost ceiling: no budget limit stated (see idea 9).


-------------------------------------------------------------------------------
14. PHASE 15 - TRUST AND RELIABILITY HARDENING (new; cross-cutting ideas)
-------------------------------------------------------------------------------
Goal: the ideas that touch many phases and are best done once the core works.
Depends on: 3, 4, 5, 6, 9 (does not block them).
Items and where they live:
1. [IMP-5] Draft card: for simple questions start the main call in parallel with context building using only transcript and summary, mark the card "updating", then add sources. Files: contextBuilder.js, mainCall.ts, Card.tsx. Test: measured time to first token before/after on the eval set; wrong-answer rate not worse.
2. [IMP-6] Grounding check: after a card finishes, a cheap check that numbers and names in the answer appear in the shown sources; if not, lower the confidence label and add "not found in sources". NEW src/copilot/core/groundingCheck.js (pure parts: extract numbers/names, match) plus a cheap model call only when the pure check is unsure. Test on the eval set including trap questions; measure false flags. I am not sure how well a cheap model does this; keep it only if the numbers are good.
3. [IMP-8] Degraded modes: finish the per-dependency states (transcript provider down: switch to the fallback STT (A5); router model down: manual-only mode with a notice; web search down: off with notice; embeddings not ready: keyword only). NEW src/copilot/core/health.js (state machine, unit tested) and the status dot from Phase 6.
4. [IMP-12] Retention: auto-delete cards, decision-log text, project chunks of past meetings after N days (default 90); delete-everything-for-this-meeting button. NEW src/copilot/main/retention.js; Qdrant point deletes by payload filter; SQLite deletes. Test: deletion removes rows and vectors; nothing else.
5. [IMP-14] Optional redaction before cloud calls: mask emails, phone numbers and card-like numbers in text sent to router and summary models (off by default). NEW src/copilot/core/redact.js with unit tests. Names are not caught; say so in settings.
6. Offline behaviour (gap in the brief): no network means cloud STT and cloud models fail; the status dot says so, the transcript falls back (A5) if possible, proactive calls stay silent, user questions show a clear error.
7. Final review pass: run the full eval set, the full test suite, i18n check, a manual 45-minute meeting on your machine, and write docs/copilot/final-report.md with timings and open issues.
Steps in order: 7 health states, 3 retention, 5 redaction, 1 draft card, 2 grounding check, 6 offline, 7 final pass. Each is separate and testable on its own.
Test / done: unit tests pass for health, redact, retention; the eval set shows no worse false alarms with draft card on; grounding check kept or dropped based on numbers; the 45-minute meeting completes without a crash.
Risks: the grounding check adds cost and false flags (drop it if numbers are bad); the draft card may confuse (label it clearly).


-------------------------------------------------------------------------------
END OF PLAN (revision 2). Waiting for your review.
-------------------------------------------------------------------------------


-------------------------------------------------------------------------------
REVISION 3 NOTE (2026-10-07): DECISION MODEL
-------------------------------------------------------------------------------
The router (Jev) is now Liquid D1 (OpenRouter model liquid/d1, same OPENROUTER_API_KEY), a classifier that returns probabilities, not text. Measured live: about 0.7 s per call. The input/output design, the policy code and its tests are in docs/copilot/DECISION_MODEL_DESIGN.md and src/copilot/core/decision/. This replaces the router JSON in the brief (section 5) and the router-model comparison in Phase 0B step 6 (the LLM numbers stay in phase0b-report.md as the fallback option). Phase 1 only has to feed buildDecisionState and act on the returned decision object.
