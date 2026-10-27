LIVE MEETING COPILOT FOR OPENWHISPR
Implementation brief for Claude Code

How to use this document
- Read this whole document first.
- Then read CLAUDE.md in the OpenWhispr repo. It is the technical reference for the codebase. This brief was written from that file and from public docs, not from reading the source. The repo may differ from what is written here.
- Section 14 lists assumptions that must be checked against the real code before planning. Do that first and report what you find.
- Then write a step by step implementation plan. Work in the phases in section 13. Do not skip phase 0.
- If something is unclear or the code contradicts this brief, ask Abhishek. Do not guess.
- Keep the code for this feature in its own folders so upstream OpenWhispr changes stay easy to merge.


1. WHAT WE ARE BUILDING

A live copilot that runs during a meeting, on top of OpenWhispr. It listens to the live transcript and helps the user in real time: short answers, suggestions, questions to ask, web search, answers from the user's own project files, and quick actions.

The goal: everything people normally do with AI after a meeting (search, summarize, draft, look things up) should be possible live, during the meeting, with very low delay.

Main design idea: a small fast decision model (called Jev) runs every few seconds on the new transcript and decides if anything should be done. Only when Jev says yes do we call the bigger answering model. This saves cost and delay, and avoids spamming the user.

This is an assistive tool. It is visible to the user, not hidden. The copilot has no outward actions. It never sends messages, creates tasks, or shares anything. It only reads (web search, shared Google Docs, project files, past meeting notes) and creates local files, and only after the user clicks save.

Platform: Ubuntu running Wayland (Abhishek's setup). Version 1 supports Ubuntu only. Wayland limits what a normal app window can do, so read section 17 before planning the window.
Base: Abhishek's local clone of OpenWhispr (MIT license). The Copilot is a new section inside OpenWhispr, with its own window and its own settings page.


2. DECISIONS ALREADY MADE

- Speech to text: the user chooses the provider inside OpenWhispr. Soniox is the recommended one. Abhishek has already added Soniox as a provider in his own local clone of OpenWhispr. Do not fork anything and do not add Soniox again. Read his local changes (git diff against upstream) and build on them. Existing OpenWhispr providers stay available.
- Models: the router (Jev) is a small fast model. The main model is a separate, stronger model. Each is chosen in settings. Do not hardcode providers.
- Copilot lives inside OpenWhispr. It is not a separate product.
- Version 1 is Ubuntu only. Do not spend time on Windows or macOS, but avoid code that makes porting hard.
- The copilot window is always on top, can be semi transparent, and becomes solid when something new arrives.
- When the user shares their screen, the copilot window minimizes. It is not hidden from screen capture. Do not use content protection or any hiding trick on the copilot window.
- Screenshots are taken only when needed, not on every turn.
- Everything in this brief is in scope. Nothing is postponed. The build order is in section 13.


3. THE MAIN FLOW

Step by step, during a meeting:

1. Audio is captured by OpenWhispr and sent to the selected speech to text provider.
2. The provider returns transcript segments (partial and final) with speaker labels when available.
3. A transcript event bus receives them. The Transcript tab, the rolling summary, and the router all read from this bus.
4. Every few seconds, if there is new final text, the trigger logic decides whether to call Jev.
5. Jev reads the recent transcript, the rolling summary, and the meeting plan. It returns a small JSON decision (section 5).
6. If the decision is "wait", nothing happens.
7. If the decision asks for an action, the context builder collects what is needed: recent transcript, rolling summary, project file chunks (RAG), web search results, past meeting notes, a screenshot, thread history.
8. The main model is called with that context. The answer streams into a card in the right thread.
9. The user can reply, tap a quick action on the card, or start parallel threads.
10. In the background, a summary service updates the rolling summary every few minutes.
11. When the meeting ends, the threads and the summary are saved into the meeting note.

If the user types or speaks a message in the copilot input, skip Jev and go straight to the context builder and main model. Jev is only for proactive help.


4. SPEED RULES

Speed is the main requirement. If the copilot feels slow it is useless.

- Stream every model answer token by token.
- Show a card immediately with a status (thinking, searching), then fill it in.
- Run independent work in parallel: for example the web search and the project search start at the same time.
- Never block the transcript on the router. The router must never delay the transcript or the UI.
- If the router call is still running when the next trigger fires, skip the new trigger. Do not queue calls.
- If any call fails or times out, fail quietly: show nothing for proactive calls, show a small error on the card for user triggered calls.
- Measure every step (section 12). Put timing in the decision log from the first version.

Starting targets, to be tuned after phase 0. These are guesses, not measurements:
- Router decision: under about 1 second.
- User question to first visible token: under about 2 seconds for fast answers.
- Web search answers: first card within about 3 seconds, filled in as results arrive.


5. THE ROUTER (JEV)

Purpose: decide fast and cheap whether to do something, and what.

Trigger rules (all configurable):
- Only run when there is new final transcript text since the last run.
- Run when a speaker finishes (a pause or end of utterance), and at most once every N seconds (default 4).
- Skip if a router call is already running.
- Cheap rules before the model: a question mark, phrases like "do you know", "what is", "can you check", a name or term that is not in the summary. Rules can only raise the chance of a call, not replace the model.
- Quiet mode: the user can lower how often the copilot speaks.

Input to Jev:
- Last few minutes of transcript (the window size is part of the decision output for the next call, default small).
- Current rolling summary.
- Meeting plan text, if any.
- A short list of recent cards (so it does not repeat itself).
- Settings: quiet level, allowed features (web search on or off, screenshot on or off, project search on or off).

Output: one JSON object only. This format is LOCKED and is not editable by the user. The editable part of the prompt cannot change it.

{
  "action": "wait | answer | suggest | ask_question | search | summarize_now",
  "intent": "short plain text of what the user would want",
  "model_tier": "fast | reasoning",
  "needs_project_search": true or false,
  "project_query": "text or empty",
  "needs_web": true or false,
  "web_query": "text or empty",
  "needs_past_meetings": true or false,
  "past_meetings_query": "text or empty",
  "needs_screenshot": true or false,
  "thread": "main | new:<short title> | <existing thread id>",
  "transcript_window_seconds": number,
  "confidence": number from 0 to 1,
  "reason": "one short sentence for the log"
}

Rules for the router prompt:
- Default is "wait". The router must lean quiet. A wrong interruption is worse than a missed one.
- Keep the output tiny. No long text.
- Validate the JSON in code. If it is invalid, treat it as "wait" and log it.
- Do not repeat a suggestion that is already shown in recent cards.

The router model and the main model must each have their own model setting (see section 9).


6. THE MAIN MODEL CALL

The context pack, in this order:
1. System prompt: locked format part plus the user's editable instruction part.
2. Meeting info: title, attendees if known, the meeting plan.
3. Rolling summary.
4. Recent transcript, as many seconds as the router asked for.
5. Project file chunks, if requested.
6. Web results, if requested.
7. Past meeting note results, if requested.
8. Screenshot, if requested and allowed.
9. Thread history: last few cards of this thread only.
10. The intent from the router, or the user message.

Keep a token budget per part so the pack stays small. Put the budgets in one config file.

Two tiers:
- fast: short answer, small model, no long reasoning.
- reasoning: slower, for complex tasks.
The router picks the tier. The user can override from the card.

Answers are shown as cards (section 8). Every card must show its sources and a confidence label (high, medium, low). If the model is not sure, it must say so. Never present a guess as a fact. This is a main requirement because a wrong confident answer in front of a client is the worst outcome.

Web search: use the built-in web search tool of the selected main model provider (for example Anthropic or OpenAI). Do not build a separate search service. If the selected provider has no web search tool (for example a local model), turn web search off and show that clearly in settings. Check the provider's current docs for the exact tool name, limits and cost before building.


7. THREADS

- There is always a Main thread. Proactive cards and normal replies go there.
- Custom threads can be created by the user with the plus button, or by the router with "new:<title>".
- Threads run in parallel. Each thread has its own history and its own running request.
- Limit the number of running requests (default 3). The Main thread has priority.
- A thread request must never block the router or the transcript.
- Every running request can be cancelled.
- The Recents list shows past threads of the current meeting and of earlier meetings.
- The router chooses the thread for a proactive card: Main, an existing thread, or a new thread with a short title (see the "thread" field in section 5). When it is unsure it must use Main. Each card shows which thread it went to, and the user can move a card to another thread with one tap. Log every thread choice so it can be tuned.


8. THE WINDOW (UI)

General
- A separate always on top window, small by default.
- Built with the same stack as the rest of OpenWhispr (React, TypeScript, Tailwind, shadcn/ui).
- All text goes through the i18n system.
- Every icon button has a tooltip.

Two sizes
- Compact: one column, taller than wide. A small header with three buttons: Summary, Copilot, Transcript/Context switch, and a plus button for a new thread.
- Expanded: four panes side by side: Current Meeting Summary, Main thread, Recents, Custom threads. Expanding does not stop or reset anything. Main thread and parallel threads keep running.
- The compact view is the default. The expanded view is opened by the user.

Copilot view (default)
- A feed of cards. Each card has: type label (Answer, Suggestion, Question to ask, Search result, Action), title, streamed body, source list, confidence label, dismiss, pin, thumbs up and down, and quick action chips (for example Explain, Search more, Make a doc, Draft a reply).
- A status line: listening, thinking, searching.
- One input at the bottom for all threads. It shows "Sending to: <thread name>" and the user can switch the target. Do not use two inputs.
- The input has: attach button, text, push to talk mic, send.
- The mic in the input is for talking to the copilot, not into the meeting. It must be push to talk, and its audio must not be added to the meeting transcript.

Transcript view
- Live transcript with speaker names.
- Auto scroll that pauses when the user scrolls up, with a "jump to latest" button.
- The user can select one or more lines and send them to the copilot ("talk about this").
- A bookmark button on a line.

Context view
- List of projects with checkboxes. Each project has files. Checked projects are used for this meeting.
- Show indexing status per project (ready, indexing, failed).
- Show the current rolling summary and let the user edit it. Edits are kept as pinned corrections and are passed to every later summary update.
- A meeting plan text box (talking points, what to cover at the start and the end).

Transparency
- Setting: opacity slider and an on/off switch for "fade when idle".
- When fading is on, the window becomes solid for a few seconds when a new card arrives, then fades back. It also becomes solid on hover.
- Do not make text unreadable. Keep a minimum opacity.
- Verify that transparent windows work properly on the user's Ubuntu setup (see section 14).

Presenting mode
- A manual toggle and a hotkey. When on, the copilot window minimizes to a small icon. When off, it comes back.
- Automatic detection of screen sharing also minimizes the window. Its feasibility on Ubuntu is not verified (see phase 14). The manual toggle must always work and is the fallback.

Start and end of meeting
- At the start, show one suggestion card based on the meeting plan (for example how to open the meeting).
- Near the scheduled end, or when the user presses a button, show a closing recap card: key points, decisions, and what the user can say to wrap up. If the meeting is linked to a calendar event, use its end time. Otherwise let the user set a timer.


9. SETTINGS (NEW "COPILOT" SECTION IN OPENWHISPR)

Models
- Router (Jev) model: provider and model. For now Jev is a small, fast model. Make the default a small model from the existing model registry, and let the user change it.
- Main model: provider and model, plus a separate choice for the reasoning tier.
- Summary model: provider and model (can be the same as the router).
- Implementation: add new inference scopes next to the existing ones in src/config/inferenceScopes.ts, for example copilotRouter, copilotMain, copilotSummary. Reuse the provider registry and selectResolvedLLMConfig. Do not write a new provider layer. Local models through the existing llama.cpp support must be selectable for the router.

Speech to text
- Choose the provider used for the meeting transcript. Mark Soniox as recommended.

Prompts
There are three prompts: router, main, summary. For each one:
- A locked part (output format and safety rules). Shown read only.
- An editable part (the instructions).
- Presets: General, Client call, Sales call, Standup. Presets are only starting points. The editable part can be changed freely. Do not make a preset aimed at hiding the tool from other people.
- Reset to default button.
- For the router prompt only: a test box where the user pastes a short transcript and sees the decision JSON and the time taken.
Defaults live in code in one folder so they are easy to review.

Behavior
- How often the router runs (seconds).
- Quiet level (low, normal, high).
- Allow web search (on or off).
- Allow screenshots (on or off, default on demand).
- Fade when idle and opacity.
- Rolling summary interval in minutes (default 3).

Projects
- Create a project, add files or a folder, remove files.
- Show indexing status.

Hotkeys
- Show or hide the copilot window.
- Answer now (force an answer on the last few lines).
- Presenting mode toggle.
- Use the existing hotkey manager and its conflict checks.


10. ROLLING SUMMARY

- Runs in the background every few minutes (setting) if there is new transcript.
- It is incremental: input is the previous summary plus the new transcript since the last update. Do not resend the whole meeting.
- Output is structured text: current topic, decisions, open questions, action items (with owner if said), key facts and numbers, names mentioned.
- It uses the pinned corrections from the user.
- The router and the main model both read it, so they do not need the full meeting every time.
- It must not block anything. If it fails, keep the old summary.
- Router can also ask for "summarize_now".


11. PROJECT CONTEXT (RAG)

- A project is a named set of files the user picks before or during a meeting.
- Supported in version 1: Word documents (.docx), PDF, and Google Docs. ("Docs" is understood as Word documents. If Abhishek meant something else, he will say so.)
- Google Docs have no sign in. The user adds a Google Docs link that is shared so anyone with the link can view it. The app fetches the text of the doc, converts it, and indexes it like any other file. Whether a link fetch works from the app, and in which format, must be checked first (section 14). If a link is not shared, show a clear error that says the doc must be shared by link. Add a refresh button for each Google Doc, and refresh them when a meeting starts.
- The user can also paste a Google Docs link into the copilot input to use that doc right now, and then choose to add it to a project.
- Index with chunking: split into chunks of roughly 200 to 300 tokens with some overlap, keep file name and position with each chunk, then embed.
- OpenWhispr already has a local semantic search (Qdrant plus all-MiniLM-L6-v2, with SQLite FTS5). Reuse the Qdrant and embedding code if it is easy to do, but use a separate collection for project chunks. Important: do not rely on the existing notes search for this. From the docs it is not clear that it splits long notes into chunks, and this model has a small input limit, so long text may be cut. Check this in the code and report it. If the embedding model is too weak, make the embedding model easy to swap.
- Search both by meaning and by keyword, and merge results, as the existing notes search does.
- Return the top few chunks with their file names. These become the source list on the card.
- Keep a small in memory index of the live transcript (windows of about 30 to 60 seconds with overlap) so the copilot can answer "what did they say about X earlier". The rolling summary covers the big picture.
- Only the projects checked for this meeting are searched.
- Past meeting notes are also searchable by the copilot. Use OpenWhispr's existing notes search (meaning plus keyword) and show the meeting title and date as the source. First check whether long meeting notes are chunked before embedding. If text from the end of a long note cannot be found, index old meeting notes into the copilot's own chunked index instead, so content anywhere in a note can be found.
- Search must be fast when the app has been idle. The existing semantic search starts its services lazily, which makes the first search slow. Warm the project index when a meeting starts.


12. LOGGING, DATA, AND TESTING

Decision log (a SQLite table, written for every router call)
- time, transcript window used, the decision JSON, validity, router latency, whether it led to a card, user feedback on that card.
- Used for tuning. Transcript text in logs only when the user turns on debug logging.

Other tables (SQLite, same database as notes)
- copilot_threads, copilot_cards (with sources, confidence, feedback, status), copilot_summaries (versions and pinned corrections), copilot_projects, copilot_project_files.
- Link threads and the final summary to the meeting note.

Timing
- Record these for each flow: transcript final time, router start and end, context build time, time to first token, total time. Show them in debug logs.

Testing
- Use the repo's existing test style (node --test).
- Unit tests: trigger logic, router JSON validation, context builder budgets, chunking, thread concurrency limits.
- A mock websocket server for the Soniox provider (the repo already does this for Parakeet streaming, copy that approach).
- A router evaluation script: a folder of recorded or written meeting transcripts with marked moments where help was wanted, and a command that runs the router on them and reports misses and false alarms. False alarms matter more than misses.
- Manual test checklist on Ubuntu with Wayland (and with XWayland if it is used as a fallback).


13. BUILD PHASES

Do these in order. Each phase must work and be testable before the next.

Phase 0: Latency prototype (standalone script, 1 to 2 days)
- A small script outside the app: microphone to Soniox websocket to router to main model with web search, printing results and timings.
- Goal: measure the real time from end of speech to first answer token, from the user's location. Soniox has US, EU, and JP regions, so test more than one.
- Report numbers to Abhishek. If they are not good enough, stop and discuss before building more.
- Also in phase 0, run a small Electron test window on his Wayland desktop and report what works: always on top over a video call, transparency, dragging and remembering position, minimize and restore by code, and a global hotkey. Also test the same window through XWayland. These results decide how the window is built (section 17).

Phase 1: Transcript bus and Soniox review
- Soniox is already added as a provider in Abhishek's local clone. Read that code first and report how it works.
- Check it against the Soniox real time websocket API: partial and final tokens, speaker labels, language switching, region choice, manual finalization, reconnect after a dropped connection, and key storage through the existing secure keys. Fix gaps. Add tests with a mock websocket server.
- Read how OpenWhispr's meeting mode produces live transcript segments. Make a small internal transcript event bus that any provider feeds, including Soniox.
- The Transcript tab shows live text from the bus.
- Done when: a live meeting shows a correct live transcript with speakers using Soniox, and still works with the existing providers.

Phase 2: Router
- Implement the trigger logic, the router call, JSON validation, the decision log, and the settings for the router model.
- Add the test box and the evaluation script.
- Done when: on test transcripts, the router is mostly quiet and picks sensible actions, and every call is logged with timing.

Phase 3: Main model and cards
- Context builder with token budgets, main model call with streaming, card storage, the card UI in a basic window.
- Include recent transcript and thread history. No RAG or web yet.
- Done when: a router decision or a typed question produces a streamed card in the Main thread.

Phase 4: Web search and rolling summary
- Add web search and sources on cards.
- Add the rolling summary service and show it in the Context tab with editing and pinned corrections.

Phase 5: Project context
- Projects, file ingest (.docx, PDF, Google Docs by shared link), chunking, indexing, search, past meeting notes search, sources on cards, warm up at meeting start.

Phase 6: Full window and settings
- Compact and expanded views, transparency behavior, presenting mode, hotkeys.
- The Copilot settings section with the three prompts, presets, reset, and the router test box.

Phase 7: Threads
- Custom threads, parallel requests, Recents, concurrency limit, cancel.

Phase 8: Screenshot
- Screenshot on demand when the router asks for it or the user presses the button. Reuse the existing screen capture helper. Keep it in memory only. Show a clear indicator every time one is sent.

Phase 9: Start and end of meeting, and post meeting
- Start suggestion card and closing recap card.
- Save threads and the final summary into the meeting note.
- Add action buttons that need a click to confirm (for example draft a follow up). No automatic sending.

Phase 10: Talking points checklist
- The meeting plan (section 8) can hold a list of talking points. Show them as a checklist in the Context tab, with a small progress count in the compact header.
- The app marks a point as covered when the transcript covers it. Run this check on the rolling summary interval and when the router runs, using a cheap structured model call. The user can tick or untick any point by hand, and manual choices always win.
- Near the end of the meeting, nudge the user about points not yet covered.
- Done when: points get ticked during a test meeting without wrong ticks being common.

Phase 11: Commitment capture
- Detect commitments in the transcript, for example "I will send this by Friday". For each one keep: who said it, the text, the due date if one was said, and the transcript time.
- Show them in a short list in the copilot window. The user can edit, delete, or approve each one.
- Handoff, always on click: copy the list, or save it into the meeting note. There is no task tool integration for now.
- Done when: commitments are captured with few false ones and can be copied or saved into the note.

Phase 12: Google Docs and local documents
- Google Docs by shared link: fetch, convert, index, refresh (section 11). No OAuth, no Google sign in, no connector for Drive or Slack. These are not in scope.
- Paste a Google Docs link in the copilot input to use it right away.
- Document creation is local. When the user asks the copilot to make a document (for example "make a doc of the decisions so far"), the copilot writes it and shows an Action card with a preview. When the user clicks Save, the file is written to a local folder chosen in settings. Markdown by default. Word (.docx) if the user asks for it. A link to the file is added to the meeting note. Nothing is uploaded anywhere.
- Done when: the copilot can answer from a shared Google Doc, and can create a local document from a typed command after the user clicks Save.

Phase 13: Automatic thread routing
- Turn on the router's thread choice (section 7). Test on the evaluation set. When the router is unsure it uses Main.
- Add "move card to thread" in the UI if not already there.
- Done when: proactive cards land in sensible threads in the test meetings, and wrong routing is rare.

Phase 14: Automatic screen share detection
- First research and report: can screen sharing be detected reliably on Ubuntu with Wayland without extra permissions? This is not verified. Do not assume it.
- If it can be detected reliably, minimize the window automatically when sharing starts and restore it when it stops, with a setting to turn this off.
- If it cannot be done reliably, keep the manual presenting toggle and tell Abhishek clearly. Do not ship a feature that works only sometimes without saying so.


14. THINGS TO VERIFY IN THE CODE FIRST

Check each of these and report before planning:

1. How meeting transcription works today: where live segments come from, whether partial results are available, how speaker labels are produced, and where a transcript event bus can be attached.
2. Whether the meeting mode can use a cloud streaming provider, or only the existing local and OpenAI paths.
3. How providers and keys are added (SECRET_KEYS in environment.js, settings store, provider registry).
4. How to add new inference scopes and whether the scope config can handle a fast router model with strict JSON output.
5. Whether local llama.cpp models are fast enough on this machine to be used as the router.
6. Whether notes search chunks long text before embedding, and what the embedding input limit is in practice.
7. Whether the existing overlay windows can be reused for the copilot window (always on top, transparency, click behavior) on Ubuntu. Transparent windows can be a problem on some Linux setups. Test it early.
8. Whether the existing screen capture helper works on Abhishek's Wayland session. The repo docs say capture is skipped on Wayland. Research the desktop portal options and report whether a screenshot can be taken without a permission prompt each time.
9. How global hotkeys work on his desktop. On GNOME Wayland OpenWhispr uses native shortcuts that only fire a toggle, so there is no global push to talk. Confirm the desktop is GNOME.
10. The repo version. Abhishek's installed OpenWhispr was 1.8.3, but upstream main is much newer. Check which version his local clone is based on and how far it is behind upstream main. Confirm with him before rebasing.
11. The structure for adding a new window and a new settings page, and the i18n rule that every new string needs a key in all language files.
12. The Soniox provider in Abhishek's local clone: what it covers, what it misses, and whether it has tests.
13. Whether the text of a Google Doc shared by link can be fetched from the app without sign in, in which format, and what happens when the link is not shared.
14. Whether screen sharing can be detected on his Wayland setup (see phase 14).
15. Whether system audio capture for meetings works on his Wayland session with the audio system he uses (PipeWire or PulseAudio).


15. RULES FOR THE CODE

- Keep new code in separate folders, for example src/copilot for main process code and src/components/copilot for UI. Change existing files only where needed, and keep those changes small.
- Follow the repo's own rules in CLAUDE.md: new IPC channels go in both ipcHandlers.js and preload.js, new settings go through useSettings.ts and the settings page, all UI strings use i18n, Node 24.
- API keys are stored with the existing secure storage. Never log keys.
- By default, do not log transcript text. Log only when debug logging is on.
- Screenshots live in memory for one request. Never write them to disk or to the database.
- The copilot has no outward actions. It never sends messages, creates tasks, or uploads or shares anything. The only thing it writes is a local file, and only after the user clicks Save.
- If a model returns bad output, fail quietly for proactive cards.
- Do not add features that are not in this brief without asking.


16. QUESTIONS TO ASK ABHISHEK IF THE CODE DOES NOT ANSWER THEM

- Which main model should be the default, and which model for the reasoning tier?
- If the desktop is not GNOME, which one is it?
- If the window tests in phase 0 show that always on top does not work on Wayland, should the app run through XWayland?
- If long meeting notes are cut when embedded, may the copilot keep its own index of old meeting notes?


17. WAYLAND NOTES (ALL UNVERIFIED, TEST THEM IN PHASE 0)

Abhishek uses Wayland. These points are based on general knowledge of Wayland, not on tests of his machine. Test each one.

- Always on top: Wayland has no standard way for an ordinary app window to put itself above other windows. The compositor may ignore Electron's always on top setting. This matters a lot, because the copilot must float over the meeting.
- Window position: apps often cannot choose or restore their own window position on Wayland. Dragging and remembering position may not work.
- XWayland fallback: running the app through XWayland (X11 mode) often makes always on top and positioning work. The trade offs (hotkeys, capture, scaling) are unknown. Decide after the phase 0 window test and ask Abhishek.
- Global hotkeys: OpenWhispr uses native GNOME shortcuts, which only fire a toggle. All copilot hotkeys must be toggles. The push to talk mic in the copilot input must work only while the copilot window is focused (hold a key or hold the button), not as a global hotkey.
- Screenshots: see item 8 in section 14. If screenshots need a permission prompt every time, report it and discuss before building phase 8.
- Transparency: usually works when the compositor supports it. Test it.
- Screen share detection: see phase 14.
- If any of these fail and have no good workaround, tell Abhishek early. Do not build the window around a feature that does not work on his machine.
