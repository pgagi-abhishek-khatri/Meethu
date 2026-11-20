# Testing the copilot in a live meeting

Two levels: an automated end-to-end run (`npm run test:e2e:desktop`), then a real call in the app.

## Before either: keys and the meeting audio route

`.env` needs both keys:

```
SONIOX_API_KEY=...       # speech-to-text for the meeting (both mic and call audio)
OPENROUTER_API_KEY=...   # the copilot's models (cards, search, summary)
```

In the app: **Settings → Speech-to-Text → Note Recording**. Set the mode to **Providers** and the provider to **Soniox**.
The default, OpenWhispr Cloud, needs the OpenWhispr API and fails with `OpenWhispr API URL not configured`. When
it fails, no transcript ever reaches the copilot. The Copilot page's Overview turns **Meeting audio** green only
when the route can actually start.

## 1. Automated desktop e2e

This runs the real chain: audio → Soniox realtime (the app's client) → copilot engine with the OpenRouter models →
saved meeting, cards, a typed question and the summary. It uses a throwaway profile, so your real copilot data is
never touched.

```bash
npm run test:e2e:desktop -- --record 30                  # talk, or play a call aloud, for 30 s
npm run test:e2e:desktop -- --audio call.mp3 --speed 2   # any recording ffmpeg can read
npm run test:e2e:desktop -- --audio call.mp3 --project "Car Zilla Proposal.pdf" --ui
npm run test:e2e:desktop -- --transcript copilot-logs/sessions/<session>.jsonl --ui   # no speech-to-text
```

`--ui` opens the real copilot window and saves screenshots. Run `npm run build:renderer` first. Each run writes
`report.md`, `transcript.txt`, `typed-answer.md`, `session.json` and the screenshots to `./copilot-e2e-<time>/`
(or `--out`). The exit code is non-zero when a required check fails. "Proactive cards" and "summary" only warn,
since they depend on what was said.

## 2. A real call in the app

1. Start the app with logs: `COPILOT_LOG=1 OPENWHISPR_LOG_LEVEL=debug npm run dev`.
2. Check Copilot → Overview: OpenRouter key ✓, Meeting audio "Soniox" ✓, Projects (optional, e.g. Carzilla ticked).
3. Join a call: Google Meet in the browser, Zoom or Teams. With no second person, play a meeting or interview video
   in the browser. It reaches the transcript as call (system) audio.
4. Start recording: **New note → record**, or the meeting hotkey. Opening the copilot window does **not** record by
   itself. Meeting detection only prompts by default; "Start recording automatically" in Settings → General →
   Notifications skips the prompt.
5. Check in order:
   - the note's transcript fills with both **You** (mic) and the other side (system)
   - the copilot window opens, says Listening, and the orb bars move with the audio
   - when someone asks a question or raises an objection, a card appears (or a "Skipped for now" item; tap it to ask)
   - a typed question in "Ask the copilot…" answers, and "Rerun with high effort" gives a longer answer
   - a question about the project file cites it
   - stop the recording: the window closes or shrinks (per settings), and Copilot → Meetings lists the meeting with
     its transcript, cards and summary
6. If something is missing:
   - **Nothing transcribed**: the note shows the start error. Check the Soniox key and the Note Recording provider.
     The debug log has `Meeting transcription start error`.
   - **Only your voice, never the call**: system audio capture is unavailable. On Linux it needs PipeWire (the
     settings show a system-audio warning). Play the call through speakers so the mic hears it, as a stopgap.
   - **Transcript but no cards**: a red banner names the cause (no key, key refused, no credits).
     `copilot-logs/copilot-decisions.jsonl` shows each decision and why it waited.
   - Replay that meeting afterwards: `npm run test:e2e:desktop -- --transcript copilot-logs/sessions/<file>.jsonl`.
