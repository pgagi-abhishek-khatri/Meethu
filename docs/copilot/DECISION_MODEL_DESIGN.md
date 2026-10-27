> **Superseded in part (2026-10-08).** The decider is now ONE call per decision with a few questions
> (`act`, `asked_of_assistant`, `complete`, `relation`, `kind`, `needs_*`), the last ~20 lines of transcript plus
> the whole rolling summary as context, and no moment labels, gate/full split, threads or depth. See
> `src/copilot/core/decision/questions.js` and `interpret.js`. Tune with `scripts/copilot/replay-fast.mjs`.

DECISION MODEL (JEV) DESIGN - Liquid D1
Status: implemented (pure code, 31 unit tests) and run LIVE against liquid/d1 on OpenRouter with the 12-scenario probe. Thresholds are first-pass tuned only.
Code: src/copilot/core/decision/   Tests: test/copilot/decision.test.js   Live probe: scripts/copilot/decision-probe.mjs

-------------------------------------------------------------------------------
1. WHAT D1 ACTUALLY IS (from Liquid's docs)
-------------------------------------------------------------------------------
- Not a chat model. It generates no text (output_tokens is always 0). You send a STATE (text or JSON) plus named QUESTIONS and get back probabilities.
- Three question types:
  noul    yes/no, returns a probability 0..1
  choice  pick one of named options, returns probabilities + confidence. Options are given per call (criteria = name -> description).
  score   ordered rubric, returns a continuous score 0..N-1 + probabilities + confidence.
- All questions in one call are evaluated against the same state, in parallel; extra questions add little latency. BUT each question is billed the full state tokens again, so cost = state tokens x number of questions.
- Where we call it: OpenRouter, model liquid/d1 (resolves to liquid/d1-20260930), POST https://openrouter.ai/api/v1/systemone with the normal OPENROUTER_API_KEY. (OpenRouter also exposes /api/alpha/decisions; same answers.) Liquid's own API is the alternative: https://api.liquid.ai/decisions/v1/systemone, key LIQUID_API_KEY, model "d1"; set COPILOT_DECISION_URL / COPILOT_DECISION_MODEL / COPILOT_DECISION_KEY to use it.
- OpenRouter lists it as modality text->decisions, text input only, context 65,536, price $0.04 per million input tokens, nothing for output. It only appears in the model list with output_modalities=all, which is why a plain list missed it.
- Images: Liquid's docs say the paid d1 accepts images (up to 8, base64, under 4.5 MB, 1.5 tokens per 32x32 patch per question); OpenRouter lists text only. NOT tested; the screenshot check (section 7) is written but unverified until we try an image.
- Not documented anywhere I read: rate limits, max questions, max state size.
- Liquid's own guidance: use probabilities with thresholds; they are examples only; tune on representative data.

Consequences for our design
1. The brief's router JSON cannot be produced as written. Fields that are free text (intent, web_query, project_query, reason, thread title) cannot come from D1.
2. A classifier cannot be prompt-injected into writing text. The worst a hostile sentence in the transcript can do is shift a probability. This is a real safety gain over an LLM router.
3. Probabilities are calibrated to Liquid's training data, not to meetings. Every threshold in config.js is an unvalidated default.
4. Our code owns the policy. D1 supplies signals; deterministic code turns them into a decision (and writes the "reason" line from the signals).

-------------------------------------------------------------------------------
2. WHAT WE DO NOT ASK THE MODEL (code knows it exactly)
-------------------------------------------------------------------------------
- Whether web / projects / past meetings / screenshot / diagrams / documents are allowed: a disabled capability drops its question (saves tokens too).
- Cooldown since the last card, whether the user is speaking, the quiet level.
- Whether the Soniox endpoint (<end>) arrived.
- Which jobs are running and their ids.
- The wake word ("Jev"): code sees it; the model's asked_of_assistant is a second opinion. If D1 is down, a wake-word request still runs with plain defaults.
- Web / project search QUERIES: the main model writes its own web query (OpenRouter's search tool does that); project search uses the new text as the query.
- New thread titles: made by the main call, not the decision.

-------------------------------------------------------------------------------
3. THE TWO STAGES
-------------------------------------------------------------------------------
Code prefilter (not the model): needs a new FINAL segment since the last decision; skip pure filler. (Phase 1 work.)

GATE - runs on every candidate segment, small state (4 recent context turns), 4-5 questions:
  worth_acting        noul  anything here a silent assistant would help with?
  asked_of_user       noul  did someone ask the user something unanswered?
  asked_of_assistant  noul  did the user ask the assistant outright?
  sentence_complete   noul  is the last utterance a finished thought?
  already_handled     noul  (only if jobs/cards exist) covered by a recent card or a running job?
  Outcomes: wait | skip | recheck (in 800 ms, max 2.5 s of waiting) | proceed.

FULL - only when the gate says proceed, full state, up to 10 questions:
  timing        choice  now | wait_for_more | replace_<job> (per running job) | covered_by_<job> (per running job)
  deliverable   choice  none | quick_answer | talking_points | explanation | summary | diagram* | document*    (*only if enabled)
  depth         score   0 quick lookup, 1 moderate, 2 deep    -> fast vs reasoning tier
  urgency       score   0 background, 1 soon, 2 immediate
  needs_web / needs_project / needs_past_meetings / needs_screenshot   noul each, only if the capability is on
  thread        choice  main | new | t_<id> (one option per open thread, described by title + gist)
  context_span  choice  just_now 30 s | recent 2 min | long 5 min | whole meeting

Why two stages: most segments are small talk. The gate costs about 5 questions on a tiny state; the full set (about 10 questions on a bigger state) runs on a minority of segments.

-------------------------------------------------------------------------------
4. THE INPUT (state sent to D1)
-------------------------------------------------------------------------------
One JSON object, empty keys removed, fixed character budgets (config.budget):
- about: one sentence telling the model who USER and OTHER-n are, and that new_text is what to judge.
- meeting: title, type, plan points.
- summary: rolling summary (short).
- context: older turns, "[-40s] OTHER-2: ...", newest kept when over budget.
- new_text: turns since the last decision (up to 8). This is the thing being judged.
- unfinished_now: the current partial, if any (helps judge completeness).
- running_analyses: id, topic, status, seconds_running (so it can say "this replaces job j1").
- active_threads: id, title, gist.
- recent_cards: kind, gist, seconds_ago, user_reaction (dismissed/pinned/none). A dismissed card is a signal to stay quiet on that topic.
- signals: user_is_speaking, sentence_boundary_detected, seconds_since_last_card.
Speaker labels: mic = USER, system = OTHER, "system:2" = OTHER-2 (Soniox diarization from Phase 0A).

-------------------------------------------------------------------------------
5. THE OUTPUT (what the code returns)
-------------------------------------------------------------------------------
kind: wait | skip | recheck | run, always with reasons[] (for the decision log) and raw signals.
For run:
  trigger         explicit | proactive
  timing          now | supersede (+ cancelJobId)
  deliverable     quick_answer | talking_points | explanation | summary | diagram | document
  offers[]        a diagram/document that was plausible but not sure enough: show a button, do not spend the call
  tier            fast | reasoning
  needs           {web, project, pastMeetings, screenshot}
  thread          main | existing(id) | new
  contextSeconds  30 | 120 | 300 | 0 (whole)
  urgency         0..2
  confidence      explicit = 1, else min(gate trigger, deliverable probability)  (heuristic)
Safe defaults when the model is unsure: low-confidence choice -> main thread, quick_answer, "now", 2 minutes. A diagram/document is produced unasked only above 90%; 50-90% becomes an offer button. A new thread needs 60%. Screenshot needs 85% (it costs more and is more private). Any malformed or unexpected answer -> wait (fail quiet). An option the model was never offered is rejected.

-------------------------------------------------------------------------------
6. THE SITUATIONS WE CONSIDERED AND HOW THEY ARE HANDLED
-------------------------------------------------------------------------------
 1 Factual question to the user          gate passes; web on; quick_answer, fast.
 2 Small talk / greetings                gate: worth_acting low -> wait (1 cheap call).
 3 Sentence cut off                      recheck every 0.8 s up to 2.5 s, then go anyway. A Soniox <end> overrides the model's doubt.
 4 User asks the assistant               explicit: ignores quiet level, cooldown, user speaking, already-handled.
 5 Unfamiliar term                       explanation.
 6 Someone asks the user for input       talking_points (what the user could say).
 7 New text narrows a running analysis   timing = replace_<job>: cancel and redo with the new text.
 8 New text only repeats what runs       timing = covered_by_<job>: skip.
 9 A card already answered it            gate already_handled -> skip. A dismissed card lowers appetite.
10 "As you can see on this slide"        needs_screenshot (85% bar). Then the image check (below).
11 A process / flow explained aloud      diagram: offered as a button unless 90%+ sure.
12 User asks for a write-up              document, explicit, reasoning tier.
13 Topic change                          thread = new (needs 60%); otherwise the matching thread; unsure -> main.
14 Two questions in quick succession     second one sees the first as a running job -> replace or covered_by.
15 User is mid-sentence themselves       proactive waits (user_speaking); explicit still runs.
16 D1 down / slow (2.5 s timeout)        proactive: stay quiet. Wake-word request: run with plain defaults.
17 Quiet level                           moves the gate bar: quiet 85%, normal 70%, chatty 50%.
18 Question already answered in the room  asked_of_user is meant to be false when answered later in new_text.
Not handled yet (needs real data): sarcasm, several people talking over each other, non-English mixed speech, very short interjections ("really?") that depend on context.

-------------------------------------------------------------------------------
7. SCREENSHOT PRIVACY CHECK (uses D1's image input)
-------------------------------------------------------------------------------
After needs_screenshot fires and a screenshot is taken, one more D1 call looks at the picture BEFORE it goes to the main model: image_relevant (>= 60%) and image_sensitive (<= 40%, passwords, banking, private messages, medical). Fails closed. Cost: 2 questions x about 1.5k tokens for a 1024 px image. Open: the docs say images work on the paid d1 only and OpenRouter says text only; unverified until we have a key.

-------------------------------------------------------------------------------
8. COST AND LATENCY (estimates, not measurements)
-------------------------------------------------------------------------------
MEASURED on 2026-10-07 via OpenRouter, 12 scenarios, from your machine (one network, one day):
- One call: 0.64-1.2 s, typically 0.7-0.8 s. This meets the brief's "router about 1 s" target, which none of the LLM routers did (best was 1.15 s with gpt-4.1-nano, and that is with no thinking).
- Gate call: about 1,060-1,650 input tokens. Full call: about 2,700-3,700. A full decision is about 3.8k tokens = about $0.00015.
- speculativeFull (default on) starts both stages together, so a "go" costs one round trip (about 0.8-1.0 s) instead of two (about 1.5-1.8 s). Cost: the full call is paid even when the gate says wait: about 3.8k tokens per candidate segment, so 600 segments an hour is about $0.09. Turn it off in config if rate limits or cost matter.
- Answers vary a little between runs near a threshold (scenario 11's diagram offer appeared in one run and not another). Do not expect determinism; keep a margin around thresholds.

-------------------------------------------------------------------------------
9. RISKS AND OPEN POINTS
-------------------------------------------------------------------------------
- Calibration: thresholds were adjusted once against the 12-scenario probe (small talk, unfinished sentences, corrections of a running job, screenshot bar 0.95). Real tuning is replaying recorded meetings (Phase 15).
- Known weak spot: "explanation" vs "quick_answer". A jargon sentence with no question (scenario 5) still comes back as quick_answer. The main model still gets the new text, so the card is fine; the label is only a hint.
- Instruction wording matters a lot for a classifier (e.g. "social pleasantries are NO" fixed small talk). Expect more rounds.
- Deliverable "summary" overlaps the separate summary job; may be removed.
- Dynamic option names (replace_j1, t_<id>): WORKED in the live probe (new thread picked in scenario 12, covered_by/replace chosen in 7). A second signal (changes_running in the gate) backs the timing answer because the timing answer alone was unreliable for corrections.
- Vendor risk: a single external service for every decision. A fallback LLM router (the latency prototype's) can be added behind the same interface. Also: OpenRouter lists this as an alpha/community-style endpoint; watch for changes.
- Brief change (recommended): section 5's locked JSON becomes a decision object produced by code; fields intent/queries/titles move to the main model. The decision log still gets one row per decision (reasons + raw signals).

-------------------------------------------------------------------------------
10. WHEN D1 IS CALLED (trigger policy, src/copilot/core/trigger/scheduler.js)
-------------------------------------------------------------------------------
Never per word or per partial. Soniox already closes a segment at a pause, so the unit is a FINAL segment, and then:
- Skipped before D1 (counted, shown in the panel): filler ("yeah", "okay", "right"), and utterances under 4 words without a question mark.
- Debounce: 0.9 s after the last triggering segment (0.4 s with a question mark, 0.15 s with a wake word), so consecutive pieces of one thought become one call. The first pending segment is never held longer than 3 s.
- At least 2.5 s between call starts (a wake word ignores it). Never two calls at once: segments that arrive during a call only mark it dirty, giving one follow-up call, not a queue.
- Defer, do not judge: during the card cooldown (8 s after a card) and while the user is speaking, nothing is sent to D1 and the text stays pending, then is judged as a batch. (The first version asked D1 and then threw the answer away, losing good moments; found in simulation.)
- Recheck: an unfinished sentence is looked at again after 0.8 s, for at most 2.5 s. Rechecks and deferrals bypass the minimum gap.
- "Explicit" (bypasses every quiet rule) needs a USER utterance in the new text or a wake word seen by code; D1's own "asked the assistant" answer is not enough (it was fooled by an earlier request in the context).

-------------------------------------------------------------------------------
11. ROLLING SUMMARY (src/copilot/core/summary/rollingSummary.js)
-------------------------------------------------------------------------------
D1 never reads the old transcript. A background call to a small model (default google/gemini-3.5-flash-lite on OpenRouter, COPILOT_SUMMARY_MODEL to change) folds segments that have aged out of the raw window into a summary of at most 45 words. The newest 5 segments are never summarized. It starts when 5 aged segments (or 600 characters) are waiting and 20 s have passed, never overlaps, never blocks a decision, and backs off 30 s after a failure. D1's state = summary (about 300 characters) + 2 context lines + up to 3 new lines.

-------------------------------------------------------------------------------
12. DEV HARNESS (COPILOT_DEV=1) AND MEASURED RESULTS
-------------------------------------------------------------------------------
What it is: src/copilot/main/devService.js, hooked into ipcHandlers.js with three one-line calls (final segment, partial, session reset). Only active with COPILOT_DEV=1 in .env. It calls D1 and SHOWS the result: no main LLM call, nothing sent anywhere else.
- Panel: a small always-on-top window opens when the first meeting segment arrives (src/copilot/dev/). Counters (D1 calls, decisions, partials ignored, segments skipped, tokens, latency, reaction time), the rolling summary, the live segment feed with the reason each segment did or did not trigger, and one card per decision with D1's own numbers.
- Log: every decision, summary and session is appended to <userData>/copilot-decisions.jsonl (on this machine ~/.config/OpenWhispr-development/copilot-decisions.jsonl).
Checks:
- node --test test/copilot/        56 unit tests (state, questions, interpretation, scheduler with a fake clock, summary, dev service)
- node scripts/copilot/decision-eval.mjs --repeat 2     23 scenarios (11 should-act, 10 should-stay-quiet, unfinished, handled) on the live model: 46/46 after the changes below
- node scripts/copilot/dev-simulate.mjs --speed 1.5     a scripted 26-segment meeting through the real pipeline (real D1, real summary model, real timing)
Measured 2026-10-07 (one machine, OpenRouter, small samples):
- Input tokens per decision: first design 3.8k for a full decision. Now about 1.3-1.7k on average (quiet gate about 650-800; a full "run" about 1.9-3k). Levers: tiny state with a rolling summary, no urgency/context-span questions, timing/thread questions only when there is a running job or an open thread, shorter question text. Cost about $0.0005 per 26-segment minute at $0.04 per million tokens.
- Calls: in the simulation 26 segments gave 8-9 decisions (13-15 D1 calls) instead of 18 (23 calls) before the defer/batch fixes, and 5-6 real cards instead of 3. 52 partials never reached D1. 8 own-speech segments skipped.
- Gate-stage accuracy changed by replacing the yes/no "worth acting" with a pick-one "moment" question (small talk / logistics / acknowledgement / narration vs question / claim / term / request to user / screen / process / decision): from 41/46 to 46/46.
- Latency of a D1 call varied from 0.65 s to 2.7 s during the session (a 1-question call took 1.3-2.7 s late in the session). Treat 0.7 s as the best case, not the typical case, until a real meeting is logged.
- Reaction after the end of speech (debounce + D1): median 1.0-1.7 s in simulation.
Known weak spots:
- Statement-style opportunities near the threshold (a jargon sentence, "as you can see...") are flaky: they pass in some runs and not others. A lower gate bar for "normal" or a better bias for these classes is the next tuning step.
- The model sometimes labels a whole batch by its first sentence; the moment question now says to judge the last utterance, but batching of chatter plus a question is still a risk.
- No main model yet: depth/tier, needs and deliverable are D1's judgments only; whether the cards they would produce are good is untested.

-------------------------------------------------------------------------------
13. JEV (TypeSafe) vs D1 (Liquid), AND DIRECT ACCESS - measured 2026-10-07
-------------------------------------------------------------------------------
Both are the same kind of model (System One: typed questions in, probabilities out) and both are served on OpenRouter directly by their makers (OpenRouter provider "TypeSafe" / "Liquid"), so OpenRouter is only a proxy hop in front of each.

                         typesafe/jev-1.13                  liquid/d1
Price (input / M tokens) $0.042                             $0.04
Context                  32k state + longest question,      64k
                         64k total
Images                   no (text only)                     paid d1: yes on Liquid's own API (not tested);
                                                            OpenRouter lists text only
Direct API               https://api.typesafe.ai/v1/systemone   https://api.liquid.ai/decisions/v1/systemone
                         (TypeSafe key; 80 req/s, 100K tok/s,   (Liquid key; limits not documented)
                         "adjusting dynamically")
Known weak spots         literal reading, numbers, counting,     none published
                         long irrelevant state (TypeSafe doc)

Measured through OpenRouter, calls interleaved (12 rounds; same payloads; your machine/network):
  payload               Jev median / p90        D1 median / p90
  tiny (1 question)     480 / 556 ms            1277 / 1440 ms
  gate (5 questions)    492 / 527 ms            1368 / 1529 ms
  full (5 questions)    492 / 633 ms            1351 / 1439 ms
End to end (scripted 26-segment meeting, real pipeline): D1 call median 548 ms (p90 996) for Jev vs 1778 ms (p90 3564) for D1; reaction after the end of speech median 0.92 s vs 1.93 s. Tokens and cost equal (about $0.0005 per simulated meeting minute).
Accuracy: 69/69 on the 23-scenario eval for both. Gate margin (lowest "should act" vs highest "should stay quiet"): D1 87 points, Jev 69 points; both nearly deterministic across repeats. The one weak case for Jev: a correction to a running analysis scored 70% (D1 94%). Full-stage choices were identical in 7 of 12 act scenarios; the 5 differences were judgment calls, where Jev was arguably closer to intent (talking points when asked to present; a new thread for a topic switch; a diagram when the content is a process).
Conclusion: Jev is about 2.7x faster at the same price and equal accuracy on our set. Use it as the default decision model; D1 stays as the alternative (and the only one that may take screenshots, via Liquid's own API).
Switch: COPILOT_DECISION_MODEL=typesafe/jev-1.13 in .env (model "~typesafe/jev-latest" follows new releases but can change behaviour; pin a version once thresholds are tuned).

Direct access (skipping OpenRouter): NOT measured, because it needs a TypeSafe/Liquid key. What is known: OpenRouter's own edge answers in about 30-70 ms; Jev through OpenRouter already totals about 0.49 s, so the hop cannot be more than a modest part of it. D1's 1.3 s looks provider-side (queue/model time), which direct access would not obviously fix. To measure: set TYPESAFE_API_KEY / LIQUID_API_KEY and run
  node scripts/copilot/decision-bench.mjs --models "typesafe/jev-1.13,jev-latest@https://api.typesafe.ai/v1/systemone#TYPESAFE_API_KEY"
(the same command takes liquid via d1@https://api.liquid.ai/decisions/v1/systemone#LIQUID_API_KEY). Tradeoffs of going direct: a second account and key to manage, separate billing, separate rate limits; OpenRouter gives one key, one bill and a single fallback point.

-------------------------------------------------------------------------------
14. SUMMARY MODEL AND CATCH-UP (updated)
-------------------------------------------------------------------------------
Default summary model: deepseek/deepseek-v4.1-flash:nitro (COPILOT_SUMMARY_MODEL to change). It is a REASONING model: with a small output cap it spends every token thinking and returns an EMPTY summary unless reasoning is disabled; the client sends reasoning:{enabled:false} for DeepSeek models (measured 0.5-1.1 s, 43 output tokens, a denser summary than gemini-3.5-flash-lite, which took about 1.0-1.2 s).
Catch-up when the transcript grows faster than the summary: backlog is folded in chunks of at most 24 lines / 3000 characters, oldest first, chained immediately (up to 4 calls) instead of waiting 20 s. If the backlog exceeds 60 segments, the oldest are SKIPPED (a recorded gap: stats.gaps / segmentsSkipped), only the newest chunk is summarized and the model is told lines were skipped, so it does not invent them.
