# Why the meeting transcript seems to arrive only after a pause or the end

Measured on 2026-11-19 on this machine (Linux, PipeWire), with Soniox `stt-rt-v5` in meeting mode, streaming at real
time. The speech was whisper.cpp's public 11 s `jfk.wav`, followed by 4 s of silence.

## Why `main` felt real-time

The transcription code on this branch is identical to `main`: no diff in `sonioxStreaming.js`, `sonioxSegments.js`,
the meeting handlers in `ipcHandlers.js`, `meetingRecordingStore.ts` or `NoteEditor.tsx`. The difference was the
**provider**.

- Your earlier real-time meetings (traces from Nov 4–5 in `copilot-logs/sessions/`) have no speaker labels, lines
  about 6 s apart and about 10 words each. That is **Local (Whisper)** mode, which transcribes every 5 s chunk
  (`LOCAL_MEETING_CHUNK_INTERVAL_MS = 5000`), pause or no pause. No OpenWhispr API was ever configured on this
  machine, so it wasn't the Cloud.
- Today's meeting used **Soniox** (numbered speakers), which commits at pauses. See below.

The branch's copilot additions (OKF and temporal routing) were also ruled out. Replaying 60 lines with your real
project gave 188 ms of total main-process stall over 57 s (worst 118 ms).

## Findings

### 1. Soniox holds words non-final for about 5 s while someone is still talking

| Words | Spoken by | Final at | Lag |
| --- | --- | --- | --- |
| "And so, my fellow" | 1.6 s | 6.5 s | 4.9 s |
| "Americans," | 2.3 s | 8.6 s | 6.3 s |
| "ask not what" | 5.5 s | 10.5 s | 5.0 s |
| rest of the sentence | 10.4 s | 11.3 s (pause) | 0.8 s |

Partials (live, changing text) start at about 1.6 s and update about 3 times a second. A **segment**, meaning a
committed line, only closes:
- at Soniox's endpoint (`<end>`), a pause after speech, about 0.3 s after it;
- when the speaker changes; or
- at the app's 15 s / 300-character cap.

Code: `sonioxStreaming.js` (`enable_endpoint_detection`), `sonioxSegments.js`.

A long sentence or run-on talk therefore commits nothing until the speaker pauses: 11 s in this sample, up to 15 s.
**That is "it only starts after the meeting pauses."**

`max_non_final_tokens_duration_ms` (700 or 1500) was accepted by Soniox but changed nothing.

### 2. The copilot and the note's committed lines wait for those finals

- Main forwards every partial and final to the note at once (`ipcHandlers.js` `attachMeetingStreamingHandlers`).
  The longest deliberate hold is 3 s, for a mic line that may be an echo of the call.
- Copilot cards are decided on **finals** only (`engine.onFinal` → decider). So cards follow pauses too.
- Partials do show live, as the grey moving line in the note's Transcript tab and the copilot window's Transcript tab.

### 3. The note doesn't show the live transcript where you're looking

While recording, a meeting note opens on **"Your notes"**. The live transcript is only on the **Transcript** tab
(`NoteEditor.tsx`: `viewMode === "transcript" && isRecording`). Unless you click that tab, the text appears only after
the stop, when the transcript is saved and the AI summary is written.

### 4. What is *not* the cause (measured)

| Suspect | Result |
| --- | --- |
| Linux system-audio helper buffering | First audio after 52 ms, then a chunk every ~21 ms, ~1 KB each |
| Mic alignment queue (`flushPendingMeetingMicChunks`) | Holds at most 100 ms with the PipeWire loopback |
| Soniox connect | About 1–1.5 s, once per recording |
| Renderer store (`meetingSegmentReducer`) | Applies each event as it arrives |

## Options

| Option | Effect | Cost |
| --- | --- | --- |
| A. Open the Transcript tab when a meeting starts recording | Live text is visible immediately | None; UI only |
| B. Force Soniox finals every ~4 s during continuous speech (`finalize` when words have been pending ≥ 4 s) | Lines and cards follow ~1–1.5 s behind speech instead of up to 11–15 s | A stray full stop at the cut ("my fellow.") and phrases split mid-sentence. Words stayed correct at 4 s. |
| B′. Same at 2.5 s | Finals ~0.8 s behind | Accuracy drops: "Americans," → "American.", "ask not what" → "Ask." "Not." Not recommended. |
| C. Let the copilot also look at partial text | Cards can start during long monologues | Bigger engine change, more model calls |

Measured with `finalize` at a 4 s cadence:
- "And so, my fellow." final at 2.2 s (spoken 1.3 s)
- "Americans, ask not what." final at 6.8 s (spoken 5.3 s)
- "Your country can do for you; ask what you can do." final at 10.1 s (spoken 9.3 s)
- "For your country." final at 11.5 s

Recommended: A, plus B at about 4 s for meeting streams only (dictation unchanged).

## Implemented: B (4 s), meeting streams only

`sonioxStreaming.js`: `MEETING_FINALIZE_AFTER_MS = 4000` (constructor option `meetingFinalizeAfterMs`, 0 = off).
While words have been pending that long, it sends `finalize`, at most once per interval. Dictation never does.
Tests are in `test/helpers/sonioxStreaming.test.js`.

Measured live through the app's client:

| Audio | Before | After |
| --- | --- | --- |
| One 11 s sentence | One line at 11.2 s | Lines at 6.1 s and 11.1 s, each ~0.9 s after the words |
| Two sentences, no pause (22 s) | Lines at 11.2 s and 22.2 s | Lines at 6.6, 11.3, 16.9 and 22.1 s |

Words stayed intact. The only artifact is a full stop at the cut ("ask not what.").
