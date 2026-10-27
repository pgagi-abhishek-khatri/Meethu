PHASE 0A REPORT - Soniox in meeting mode (code side)
Status: steps 0-9 done in code and unit tests. Step 10 (manual test with a real Soniox key) is not done.

What changed
- src/helpers/sonioxSegments.js (new): token stream -> closed segments. Closes on <end>/<fin>, speaker change, 300 chars or 15 s.
- src/helpers/sonioxStreaming.js: meeting mode, region option, onConnectionLost, 290-minute onSessionExpired, keepalive, completedSegments, completedSpeakers, audioBytesSent, sessionStartedAt. Dictation path unchanged.
- meetingStreamingProviders.js, meetingTranscriptionRouting.js, realtimeTokenProviders.js: "soniox" registered (BYOK only).
- ipcHandlers.js: about 8 lines. Final-segment event carries an optional providerSpeaker.
- Tests: 5 files extended or added; 62 pass in those files.

Differences from the plan (decided while reading the code)
1. Meeting mode switch: the plan said a "mode" option. Meeting already passes mode:"byok", so the switch is streamLabel being "mic" or "system" (only meeting sets it).
2. Speakers (step 9): NOT written into the note's own speaker field. That field uses speaker_N ids with placeholders, locks and merges; a Soniox label there would collide with the local identifier. Instead the label goes in a separate event field "providerSpeaker" (for example "system:2"), set in main only. The note UI ignores it. The Phase 1 bus reads it at the same place. Showing Soniox labels in the note UI is not done; say if you want it.
3. "Recommended" badge in the picker: skipped (needs 11 locale strings for a cosmetic label). Soniox already appears in the meeting picker through the registry, with its key field.
4. Custom dictionary terms are not passed in meetings (meeting code only passes keyterms for Corti). Ignored, as allowed.

Not verified
- Real Soniox behaviour (segment sizes, speaker labels, <end> timing). Only a mock server was used.
- Echo/holdback behaviour with Soniox segment sizes.
- EU/JP/IN regions (no keys).
