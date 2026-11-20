# Plan: about 1 second of latency for the live meeting copilot

Status: plan only. Nothing here is implemented yet, except the Soniox 4 s finalize already on this branch.
Sources:
- measured traces (`copilot-logs/sessions/*.jsonl`, 76 cards and 120 decisions)
- live Soniox timing runs (`docs/copilot/REALTIME_LATENCY_RESEARCH.md`)
- a code audit of the copilot path
- external research (citations at the end)

Local `main` = GitHub `origin/main`. The transcription path is identical to this branch; only the copilot differs.

## 1. Targets

| ID | What is measured | From → to | Target p50 | Target p90 |
| --- | --- | --- | --- | --- |
| T1 | Live text | a word is spoken → it shows as live (partial) text | ≤ 1.0 s | ≤ 1.5 s |
| T2 | Committed line | the speaker pauses → the line is committed in note and copilot | ≤ 0.6 s | ≤ 1.0 s |
| T3 | Card | a question ends → first words of the card visible | **≤ 1.0 s** | ≤ 1.8 s |

T3 is the headline "1 second". It is only reachable if the steps overlap. Run one after another, every stage below
is 0.3–0.7 s and the sum is over 2 s [R1].

## 2. Where the time goes today (measured)

| Stage | p50 | p90 | Source |
| --- | --- | --- | --- |
| Spoken word → Soniox partial | ~1.6 s (first) | | live run |
| Mid-sentence word → final (before the 4 s finalize) | ~5 s | 15 s cap | live run |
| Pause → final (endpoint) | ~0.3 s | | live run |
| Final → decision made (`reactionMs`) | **2.2 s** | 4.7 s | traces |
| ↳ scheduler waits (debounce, turn gap, gaps, cooldown) | ~1.4 s | up to 4.5 s | `scheduler.js:13-21`, `decision/config.js:14-16` |
| ↳ decider call (`pplx-decider-v1.2`, no streaming) | 0.73 s | 0.97 s | traces |
| Card job → card done (`sinceTriggerMs`) | 1.36 s | 3.0 s | traces |
| ↳ file search (query writer + embedding, one after another) | 0.62 s | 1.28 s | traces |
| ↳ answer model first token | 0.45 s | 2.04 s | traces |
| Proactive card hidden until it's finished | +0.1 s | +0.23 s | `answerRunner.js:63` |
| Orb/peek mode shows only finished cards | +resize | | `CopilotApp.tsx:135-154` |

**Today:** a question ends → the first card word appears ≈ 0.3 (endpoint) + 2.2 + 1.4 ≈ **3.9 s p50, 7–8 s p90**.

## 3. Target budget for T3

| Stage | Today p50 | Target | How |
| --- | --- | --- | --- |
| Endpoint → final | 300 ms | 200–300 ms | Soniox endpoint, plus finalize on a local VAD pause (Phase 3) |
| Scheduler wait | ~1400 ms | 0–150 ms | Questions and endpoints fire immediately (Phase 1) |
| Decider | 730 ms (serial) | 0 on the critical path | Runs **in parallel** with a speculative answer (Phase 2) |
| File search | 620 ms (serial) | 0–80 ms | Prefetched embedding, BM25 first, writer only when D1 asks, run in parallel (Phase 2) |
| Model first token | 450 ms | 300–450 ms | Latency-sorted provider, stable cached prefix, warm connection (Phase 4) |
| Hidden-until-done + peek | 100–230 ms | ~16 ms | Stream proactive cards after the SKIP check, peek on first token (Phase 1) |
| **Total** | **~3.9 s** | **~0.6–1.0 s** | |

## 4. Phases

Each phase ships behind a flag (`COPILOT_FAST=1`, then settings). Phase 0's report decides whether to go on.

### Phase 0 — Measure end to end (½ day)

Without this, "1 s" can't be checked.

- **One timeline per card.** Record:
  - `speechEndAt`: Soniox `end_ms` + `sessionStartedAt` (`sonioxStreaming.js` `emitSegment`)
  - `finalAt`, `triggerAt`, `d1StartAt` / `d1EndAt`
  - `prepareMs`, `requestAt`, `firstTokenAt`, `firstPaintAt`

  `firstPaintAt` is reported from the renderer with `requestAnimationFrame` after the first `card_update`, sent over
  a new IPC event `copilot:painted`. Write the timeline to the session trace as `latency`.
- **Latency mode for the desktop e2e** (`scripts/copilot/desktop-e2e.js --latency`). Play scripted Q&A audio (TTS or
  recordings, with known question-end times) through Soniox and the copilot. Report T1, T2 and T3 at p50 and p90.
  Fail the run when T3 p50 is over 1.0 s.
- **Report:** `npm run copilot:latency-report`, per-stage percentiles from the traces.

### Phase 1 — Remove waits (1 day; expected T3 −1.5 to −2 s)

| # | Change | File | Gain |
| --- | --- | --- | --- |
| 1.1 | A **question or endpoint final fires D1 at once**. Statements: `debounceMs` 1600→500, `turnGapMs` 1500→500. Partials from the *same* voice stop extending the wait once a final with an endpoint has arrived. | `core/trigger/scheduler.js:13-21,154-159` | ~1.0–1.4 s |
| 1.2 | Exempt questions and explicit asks from `minGapMs`/`cooldownMs` *before* D1, not only after. Cooldown 4000→2000. | `scheduler.js:16-17`, `decision/config.js:14`, `engine.js:842-853` | tail, p90 −2 s or more |
| 1.3 | D1 timeout 5000→1500 ms, with the existing fallback decision | `engine.js:308`, `interpret.js:186` | p90 tail |
| 1.4 | **Stream proactive cards.** Once the text clearly isn't `SKIP` (after `TITLE:` or about 6 characters), emit `card_start` and `card_update`. A late SKIP removes the card (`card_skip` already exists). | `answerRunner.js:31,58-66`, `copilotState.ts` | 0.1–0.25 s, and more for longer cards |
| 1.5 | Orb/peek pops on `card_start` / the first `card_update` and shows the streaming card | `CopilotApp.tsx:135-154` | perceived latency |
| 1.6 | Query writer only when D1 sets `needs_project` or the moment is a typed question. `queryWaitMs.fast` null→200 ms, falling back to the moment's own vector | `rag/config.js:9`, `retrieve.js:303-306` | 0.3–0.6 s whenever files are searched |
| 1.7 | Keep `twoCall` off. Make sure `COPILOT_RAG_TRIGGER` isn't set in releases | `engine.js:87` | avoids +0.7 s |

Risk: more decider calls, since there's less batching. Watch the D1 calls per minute in the stats, and keep the 2 s gap
for statements.

### Phase 2 — Overlap the work (2–3 days; expected T3 −0.7 to −1.2 s)

- **2.1 Speculative answer.**
  - When a final arrives that looks like a question (a `?`, a wh-word or an "ask" pattern, which the scheduler already
    tracks), start D1 and the answer model **at the same time**.
  - Buffer the answer's tokens. Release them on D1 `run`; abort (AbortController) on `wait` or `skip`.
  - Statements keep the D1-first path, so no tokens are spent speculating on chatter.
  - Files: `engine.js` `runDecision` (~834-980) and `startAnswer` (419), plus a `speculative` flag on the job in
    `answerRunner.js`.
  - Measure the hit rate (speculations that D1 confirmed) and the cost per meeting.
  - Research: classifier and generator split for low latency [R8]; early or anticipatory execution saved 505 ms for
    28% more compute [R10].
- **2.2 File search in parallel with D1.**
  - At `rag.prefetch` (`engine.js:881`), also start `writeQueries`, and keep the promise on the moment.
  - D1 `run` with `needs_project` → `retrieve` reuses both. Otherwise abort the writer.
- **2.3 Local steps in parallel.** The temporal router and ALS (`retrieve.js:121-201`) run alongside the embedding and
  writer instead of before them.
- **2.4 BM25 first.** If the keyword hits are strong (rank 1 is well ahead of rank 2), answer with them and don't wait
  for the vector. Otherwise wait at most `embedGraceMs`.

### Phase 3 — Speech-to-text (1–2 days; T1 and T2) — **includes a deadline**

What's already done on this branch: Soniox meeting streams finalize after words have been pending 4 s. Finals then
trail continuous speech by about 1–1.5 s.

- **3.0 Move to `stt-rt-v6` before Dec 15, 2026.** `stt-rt-v5`, the one the app uses
  (`SONIOX_MODEL` in `sonioxStreaming.js`), is deprecated and will be removed then [S1]. Without this, note recording
  stops working. Verified live: v6 accepts our meeting config.
  - The model id is part of the warm-socket signature, so update the tests in `test/helpers/sonioxStreaming.test.js`
    and `transcriptionRoute.ts` (`stt-rt-v5` defaults) too.
- **3.1 Finalize on pauses, not on a timer.** Soniox recommends `finalize` about 200 ms after speech ends, tuned with a
  VAD. Too early hurts accuracy, and too often can disconnect [S2]. Our fixed 4 s timer goes against this, which is why
  phrases get cut.
  - Run a local VAD on each stream in main: Silero on a 16 kHz copy [S9], or the existing RMS from `meetingMicGate.js`.
  - Send `finalize` at ≥250 ms of silence after ≥1 s of speech, at most once per ~2 s.
  - Keep the 4 s timer only as a fallback, raised to ~6 s of unbroken speech.
  - Files: `ipcHandlers.js` `dispatchMeetingAudioBuffer`, `sonioxStreaming.js`.
- **3.2 Separate settings per stream.**
  - **Mic** (one speaker): turn off diarization, since endpointing and finalize reduce diarization accuracy [S3]. Then
    endpoint aggressively.
  - **System** (needs diarization): moderate endpointing, and finalize only after ≥2–3 s of audio since the last one.
- **3.3 Endpoint settings (v6)** [S4]: `endpoint_latency_adjustment_level` 0–3, `endpoint_sensitivity` −1…1,
  `max_endpoint_delay_ms` 500–3000 (default 2000).
  - Tested live: level 3 with 500 ms is accepted, but chops phrases ("ask." "Not." "Do for your."). Start at level 1
    with 1000 ms on the system stream and level 2 with 700 ms on the mic, then tune with Phase 0's harness.
  - `max_non_final_tokens_duration_ms` is no longer documented [S5], and live tests showed no effect. Don't use it.
- **3.4 Commit stable partials for the copilot.** Treat non-final text that hasn't changed for ~700 ms (or across 2
  responses) as provisional input. A system partial ending in `?` starts Phase 2's speculative path before the final.
  Finals confirm or retract it, with the same reconciliation as the existing `retract` events. This is the only way
  under ~1 s during continuous speech, when no endpoint fires.
- **3.5 End-of-turn model (optional).** Smart Turn v3 (~12–36 ms CPU) [R17][S8] vetoes finalizing in the middle of a
  sentence, so the silence threshold can drop to ~200 ms.
- **3.6 Variable Soniox latency (measured).** The same script gave a first partial at 1.6 s in one run and 4.2 s a few
  hours later, with the network fine (~0.3 s TLS connect).
  - Log the time each chunk is sent against Soniox `total_audio_proc_ms`, to separate the server queue from the network.
  - Alert in the trace when the first partial takes more than 2.5 s.
  - Consider a nearer region project (EU/JP/IN) if the users are there [S6].
  - Keep a fallback provider ready (Deepgram/AssemblyAI expose ~300 ms immutable partials and explicit end-of-turn
    controls [S7]).

### Phase 4 — Model and provider (1 day of benchmarking)

- **4.1 TTFT matrix.**
  - Script `scripts/copilot/ttft-bench.mjs` measures first-token times from this region, through OpenRouter, with
    our real prompt (about 3–8k tokens).
  - Candidates: the current `qwen/qwen3.8-27b…:nitro`, Groq- and Cerebras-hosted Qwen3-32B and gpt-oss, Gemini Flash,
    Claude Haiku.
  - Pick by p90 TTFT, not throughput. `:nitro` sorts by **throughput**; use `provider.sort: "latency"` and
    `preferred_max_latency` [R12][R13].
- **4.2 Prompt caching.**
  - Keep the system prompt, behaviour guide, catalog and summary byte-identical at the front, with the moment last.
  - Use a fixed `session_id` per meeting and a fixed model slug.
  - Cerebras caches every model; Groq caches only some [R14][R15][R16].
- **4.3 Warm connection.**
  - One keep-alive HTTP agent for OpenRouter.
  - A cheap warm-up request at meeting start, for the decider and the answer model.
  - Keep the OpenRouter balance healthy (a low balance adds checks) [R7].
- **4.4 Trim the context pack** for fast cards (`budgets.js:3-15`): cap the catalog and reference at about 3k
  characters on the fast tier.

### Phase 5 — Cheaper decider (optional, after Phase 2 data)

- **5.1 Local pre-filter.** An embedding plus logistic-regression classifier, trained on the labelled moments in
  `copilot-logs`. Clear "no" moments never call D1; clear questions go straight to the answer.
- **5.2** Only borderline moments call `pplx-decider`.

## 5. Acceptance

- Run `desktop-e2e --latency` on 20 scripted questions, 3 times.
  - T3 p50 ≤ 1.0 s, p90 ≤ 1.8 s.
  - T2 p50 ≤ 0.6 s; T1 p50 ≤ 1.0 s.
- No more SKIP cards flashing: under 2% of streamed cards removed after appearing.
- Cost per hour of meeting at most 1.5× today; check the speculation hit rate.
- The existing suites stay green: `test/copilot/*`, the Soniox and meeting tests, `npm run typecheck`.

## 6. Risks

| Risk | Mitigation |
| --- | --- |
| Speculation cost | Questions only; abort on D1 `wait`/`skip`; report the hit rate |
| More decider calls from less batching | Keep the statement gaps; measure calls per minute |
| SKIP after the card has started streaming | Hold the first ~6 characters; remove with `card_skip`; target < 2% |
| Finalize on VAD pauses splits phrases | 250–300 ms threshold; never mid-word (3.4); A/B against the transcripts |
| Provider TTFT varies by region and time | Benchmark from here; use `preferred_max_latency`, not a hard pin |

## 7. Order and effort

| Phase | Effort | Expected T3 p50 after |
| --- | --- | --- |
| 0 Measure | ½ day | 3.9 s (baseline, now measured) |
| 1 Remove waits | 1 day | ~1.8–2.2 s |
| 2 Overlap | 2–3 days | ~1.0–1.3 s |
| 3 Speech-to-text (v6 by Dec 15) | 1–2 days | ~0.8–1.1 s, and lines no longer wait for pauses |
| 4 Model/provider | 1 day | ~0.7–1.0 s |
| 5 Decider | optional | cost, not latency |

## References

- [R1] Voice AI & Voice Agents primer: latency budgets, TTFT medians — https://voiceaiandvoiceagents.com/
- [R2] Latency engineering for voice agents (model endpointing 200–400 ms) — https://simbavoice.ai/resources/latency-engineering-for-real-time-voice-agents
- [R3] LiveKit turn detector — https://docs.livekit.io/agents/logic/turns/turn-detector.md
- [R7] OpenRouter latency and performance — https://openrouter.ai/docs/guides/best-practices/latency-and-performance
- [R8] DiscussLLM (classifier/generator split) — https://arxiv.org/abs/2508.18167
- [R10] Endpoint Anticipation (−505 ms, +28.4% compute) — https://arxiv.org/abs/2606.13450
- [R12] OpenRouter `:nitro` = throughput sort — https://openrouter.ai/docs/guides/routing/model-variants/nitro
- [R13] OpenRouter provider selection (`sort: latency`, `preferred_max_latency`) — https://openrouter.ai/docs/guides/routing/provider-selection
- [R14] Cerebras prompt caching — https://inference-docs.cerebras.ai/capabilities/prompt-caching
- [R15] Groq prompt caching — https://console.groq.com/docs/prompt-caching
- [R16] OpenRouter prompt caching — https://openrouter.ai/docs/guides/best-practices/prompt-caching
- [R17] Smart Turn v3.2 ONNX (~36 ms CPU) — https://huggingface.co/soniqo/Smart-Turn-v3.2-ONNX
- [R18] Pipecat turn strategies — https://docs.pipecat.ai/api-reference/server/utilities/turn-management/user-turn-strategies.md
- [S1] Soniox models (v5 deprecated, removed Dec 15, 2026; v6) — https://docs.soniox.com/stt/models
- [S2] Soniox manual finalization (≈200 ms after speech, not too often) — https://docs.soniox.com/stt/rt/manual-finalization
- [S3] Soniox speaker diarization (endpointing/finalize reduce accuracy) — https://docs.soniox.com/stt/concepts/speaker-diarization
- [S4] Soniox endpoint detection settings — https://docs.soniox.com/stt/rt/endpoint-detection
- [S5] Old `max_non_final_tokens_duration_ms` docs (archived 2025) — http://web.archive.org/web/20250714024541/https://soniox.com/docs/speech-to-text/core-concepts/real-time-latency
- [S6] Soniox data residency / regions — https://docs.soniox.com/data-residency.mdx
- [S7] Deepgram endpointing — https://developers.deepgram.com/docs/endpointing ; AssemblyAI latency modes — https://www.assemblyai.com/docs/streaming/getting-started/optimizing-accuracy-and-latency
- [S8] Smart Turn v3 (~12 ms CPU) — https://www.daily.co/blog/announcing-smart-turn-v3-with-cpu-inference-in-just-12ms/
- [S9] Silero VAD — https://github.com/snakers4/silero-vad
- [P1] FastEmit (−150–300 ms emission latency) — https://arxiv.org/abs/2010.11148
- [P2] Partial stability metrics (Shangguan 2020) — https://arxiv.org/abs/2006.01416
- [P3] Voice Activity Projection (2022) — https://arxiv.org/abs/2205.09812
