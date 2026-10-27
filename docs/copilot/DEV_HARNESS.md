COPILOT: HOW TO RUN AND CHECK IT

Run: npm run dev (Node 24), start a meeting note recording with Soniox. The copilot window opens by itself
(Settings -> "Open this window when a meeting starts"). Hotkey to show/hide it: CommandOrControl+Alt+C (changeable in
the window's Settings). The copilot needs one OpenRouter key: type it in the window's Settings, or keep OPENROUTER_API_KEY in .env.
Without a key it only shows the transcript.

Window: tabs Copilot / Transcript / Context, gear = settings. Wider than 900 px = expanded layout (summary, main thread,
recents, custom threads). Click transcript lines then "Ask about this" to talk about them. Settings -> Debug lists D1's decisions.

Data: userData/copilot.db (meetings, transcript, cards, projects) and copilot-settings.json. Forget-after default 90 days.

Dev logs (they contain the transcript): COPILOT_DEV=1 or COPILOT_LOG=1 in .env writes copilot-logs/ in the repo
(copilot-decisions.jsonl; per-meeting traces in sessions/ with COPILOT_LOG=1). Optional env: COPILOT_QUIET, COPILOT_AI_MODEL,
COPILOT_SUMMARY_MODEL, COPILOT_DECISION_MODEL, COPILOT_MAIN=0 (simulated jobs).

Headless checks:
  node --test test/copilot/                       (engine, decision, answer, UI state; no database)
  node --import tsx --test test/copilot/copilotState.test.js
  ELECTRON_RUN_AS_NODE=1 npx electron --test test/copilot/store.test.js test/copilot/service.test.js   (needs the Electron-built better-sqlite3)
  node scripts/copilot/decision-eval.mjs --repeat 2 ; node scripts/copilot/dev-simulate.mjs --speed 1.5
  node scripts/copilot/answer-eval.mjs            (live main-model check, costs a few cents)
End-to-end replay of saved meetings (real D1 + main model, virtual clock, costs tokens): node scripts/copilot/replay-e2e.mjs <out.json> seg1.jsonl seg2.jsonl
UI screenshots with a fake engine: npm run build:renderer, then env -u ELECTRON_RUN_AS_NODE npx electron scripts/copilot/ui-smoke.js <outDir>
