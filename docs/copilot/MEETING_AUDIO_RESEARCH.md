# How meeting audio reaches the copilot (research, Linux focus)

Scope: the `main` branch's meeting audio pipeline, which this branch (`Rag_okf`) shares unchanged. Only the RAG and
OKF files differ from `main`. Tests were run on this machine on 2026-11-19: Kali Linux, PipeWire 1.6.9 behind the
PulseAudio API, with a Bluetooth headset as the default input and output.

## Short answer: why the meeting going on in the background wasn't read

1. **Nothing records until a meeting note records.** The copilot has no audio input of its own. It only receives
   transcript lines from the note recording (`ipcHandlers.js` → `copilot.onFinal` / `onPartial`).
2. **Starting a note recording needs a click, by design.** Meeting detection notices another app using the mic and
   shows a prompt. The recording starts only when you accept it, unless "Start recording automatically" is on
   (Settings → General → Notifications; off by default).
3. **Even after starting, transcription used OpenWhispr Cloud**, which fails here (`OpenWhispr API URL not
   configured`). Your sessions from Nov 18 and 19 have 0 transcript lines because of this. That's what the Overview
   warning "Cloud unavailable here" means. Your Soniox key is fine; it just isn't selected for Note Recording.

Fix: in Note Recording, set the mode to **Bring your own key** and the provider to **Soniox**. Optionally turn on
"Start recording automatically".

## The pipeline, file by file

| Stage | What happens | Where |
| --- | --- | --- |
| Detect | `pactl subscribe` watches for `source-output` (an app opening a mic). It lists the owning processes with `pactl --format=json`, and ignores OpenWhispr itself, OBS-style production captures and sink monitors. When a capture lasts 2 s, it emits `sustained-audio-detected`. Fallback: polling every 3 s, needing 2 consecutive hits. | `src/helpers/audioActivityDetector.js` |
| Context | On Linux, running Zoom, Teams or Webex corroborates the signal and lets auto-end fire when the app exits. Browsers aren't listed, since they're always running. | `src/helpers/meetingProcessDetector.js` |
| Decide | The detector runs only while `notificationsEnabled` and `notifyMeetingDetection` are on (both default on). It then shows the overlay prompt, or auto-starts (`autoStartOnDetection`) through `windowManager.startManualMeeting`, which refuses during push-to-talk or under a policy block. Nothing prompts while a recording runs. | `src/helpers/meetingDetectionEngine.js`, `meetingDetectionPreferencePolicy.js` |
| Note opens | A meeting note is created and the control panel navigates to it. The renderer's recording store starts capture. | `windowManager.queueMeetingNoteNavigation`, `src/stores/meetingRecordingStore.ts` |
| Your voice (mic) | Renderer `getUserMedia` on the chosen or default input. If the exact device fails, it falls back to the default. 24 kHz PCM goes to main. | `meetingRecordingStore.ts` |
| Call and background audio (system) | Linux: `linux-system-audio-helper start`, a PipeWire loopback of the output, 24 kHz mono s16le on stdout. Without the helper, it uses Chromium's display-media loopback or portal instead. | `src/helpers/linuxPortalAudioManager.js`, `resources/bin/linux-system-audio-helper` |
| Clean-up | An echo detector and a mic gate keep the remote voice, heard through your speakers, out of the mic channel. Optional AEC (off by default). | `meetingEchoLeakDetector.js`, `meetingMicGate.js`, `meetingAecManager.js` |
| Speech-to-text | Two streams, `mic` and `system`, each with its own connection to the provider picked in Note Recording: Soniox `stt-rt-v5` (key `SONIOX_API_KEY`), Deepgram, AssemblyAI, OpenAI realtime, a local model, or OpenWhispr Cloud. | `meetingTranscriptionRouting.js`, `meetingStreamingProviders.js`, `realtimeTokenProviders.js`, `sonioxStreaming.js` |
| Copilot | The copilot begins once the start succeeds (lifecycle `onStarted`). Every final segment and partial goes to the copilot engine (cards, search, summary). Stopping the recording ends the copilot's meeting. | `meetingTranscriptionLifecycle.js`, `src/copilot/main/service.js` |

## Live tests on this machine

| Test | Result |
| --- | --- |
| `linux-system-audio-helper probe` | `ok: true`, `supportsSystemAudio: true`, `source: pipewire-loopback` |
| 4 s capture with nothing playing | 3.97 s of 24 kHz PCM, silent (RMS 0). Correct. |
| 4 s capture while a quiet 660 Hz tone played on the default output (Bluetooth) | Tone captured (peak RMS 0.0071 per 100 ms). Call and background audio capture works. |
| `pactl --format=json list source-outputs` (mic detection) | Works |
| Soniox connect with `SONIOX_API_KEY` (meeting mode, `stt-rt-v5`) | Connects in about 1.1–1.5 s; key accepted |
| Copilot with the OpenRouter models, fed 30 lines of a saved meeting (`npm run test:e2e:desktop -- --transcript …`) | 30/30 lines saved, 5 proactive cards, typed answer in about 1–2 s, no errors |
| Soniox with real speech | **Not run yet**: there is no speech recording on the machine. Run `npm run test:e2e:desktop -- --record 30`, or try a real call. |

## Things to watch on this setup

- **The Bluetooth headset is both the default input and output.** When an app opens its mic, Bluetooth switches from
  the high-quality A2DP profile to the headset profile (HFP). The sound gets worse and some apps reroute audio. For
  testing, use the laptop's built-in mic as the meeting mic (`alsa_input.pci-0000_04_00.6.analog-stereo`), and keep
  the headset for listening.
- **With headphones, the mic never hears the other side.** That's good for echo, but their words then come only from
  the system channel. If system capture failed, you'd see only your own lines. The note warns after 45 s of a silent
  system channel.
- **Meet in a browser is detected by mic use, not by process.** The prompt appears about 2 s after the browser opens
  the mic. A dismissed prompt cools down for 5 minutes. An unanswered one doesn't prompt the same call again.
