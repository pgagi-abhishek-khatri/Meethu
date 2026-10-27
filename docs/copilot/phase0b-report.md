PHASE 0B REPORT (interim) - latency and window test
Status: steps 2, 3 and 6 measured with TEXT input (no speech). Step 1 (mic -> Soniox timing), step 4 (20+ spoken runs) and step 5 (window tests a-h) need you at the machine. Not finished.

Measured on 2026-10-07, one machine, one network, via OpenRouter. Small samples (3-6 runs per cell), so treat as rough. Bare HTTPS round trip to OpenRouter: about 130 ms, so the network is not the cause.

1. Main model (anthropic/claude-sonnet-5.5:nitro, streaming, no web search)
- Default settings: first token median 4.8 s. Cause: this model has MANDATORY reasoning ("Reasoning is mandatory for this endpoint and cannot be disabled").
- With reasoning effort "low": first token about 1.5 s. With "minimal": about 1.4 s, total about 1.9 s. This meets the 2 s target.
- Decision needed: the main call must send reasoning effort low/minimal for the "fast" tier. Keep default effort for the "reasoning" tier.

2. Main model with web search (OpenRouter tool {type:"openrouter:web_search"}, Anthropic native search, effort low)
- First token median 5.5 s, p90 7.4 s (n=4). Target in the brief was about 3 s.
- Text only starts after the search finishes, so streaming does not help here. The card must appear at once with a "searching" status (as the brief says); the answer then arrives after about 5-7 s.
- Cost: not measured per search (OpenRouter bills native search separately; check the dashboard).

3. Router (locked JSON format, 6 runs each, same prompt)
  model                          median   p90     JSON invalid
  openai/gpt-4.1-nano            1.15 s   1.62 s  0/6
  google/gemini-3.5-flash-lite   1.24 s   1.48 s  0/6
  openai/gpt-4.1-mini            1.50 s   1.69 s  0/6
  anthropic/claude-haiku-4.5     2.11 s   2.33 s  0/6   (":nitro" suffix was slower: 2.45 s)
  openai/gpt-5-mini              4.71 s   6.86 s  6/6   (unusable: reasoning model)
- Target was about 1 s. Nothing reaches it; nano and flash-lite are close.
- NOT measured: routing quality (does it stay quiet when it should and speak when it should). The 20 router prompts are not written yet.
- Possible speed-up not tried: a shorter JSON output (fewer fields) cuts output time.

4. Provisional picks (change after quality tests and the spoken runs)
- Router: openai/gpt-4.1-nano or google/gemini-3.5-flash-lite. Set via COPILOT_ROUTER_MODEL.
- Main fast tier: anthropic/claude-sonnet-5.5 with effort low.
- The earlier default "claude-sonnet-5.5:nitro" without an effort setting is too slow for the fast tier.

5. Window test (step 5): app built, launches without errors. Results: NOT DONE.
How to run (from the repo root):
  env -u ELECTRON_RUN_AS_NODE npx electron scripts/copilot/window-test/main.js --ozone-platform=x11
  env -u ELECTRON_RUN_AS_NODE npx electron scripts/copilot/window-test/main.js --ozone-platform=wayland
  (add --transparent to test a transparent window)
Checklist a-h is in the plan; each has a button or a log line in the window. Fill in yes/no for X11 and Wayland.

6. Not done yet
- Spoken latency (Soniox end lag, speech-to-first-token): run
  node scripts/copilot/latency-prototype.mjs --mic --runs 20 --router-model openai/gpt-4.1-nano --effort low
- Regions other than US (no keys).
- Router quality comparison.

Stop rule from the plan: router + first token well over target -> discuss before Phase 1. Current state: first token OK with low effort, router about 1.2 s, web answers about 5.5 s. That is a "close, not met" result; see the questions in the chat.
