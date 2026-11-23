# Copilot Decision, Duplicate Guard, Gap Questions & Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the live copilot answer only moments that need an answer, never repeat a card, ask the user for missing facts (as words to ask the client) instead of guessing, and write a summary that includes cards, retrieved facts and open gaps.

**Architecture:** Keep the Perplexity decider (`perplexity/pplx-decider-v1.2`, key `OPENROUTER_API_KEY`, probabilities only) as the signal source. Add three questions to it (`answerable`, `already_answered`, `gap`). Policy stays in pure code (`interpret.js`) plus a new deterministic duplicate guard. After RAG retrieval, a code-side sufficiency check chooses answer / answer-with-caveat / gap card; the answer model writes only the gap questions the missing facts require (max 2).

**Tech Stack:** Node (CommonJS), `node --test`, OpenRouter (`/systemone` decider, chat completions for answer/summary), existing `src/copilot/rag`.

**Spec:** Conversation design of 2026-11-24 (no separate spec file). Context docs: `docs/copilot/DECISION_MODEL_DESIGN.md`, `docs/copilot/RAG_PLAN.md`. Decision (user-approved): gap questions are phrased as words the USER can ask the client.

## Global Constraints

- All thresholds are unvalidated defaults in `core/decision/config.js`; none may be hardcoded elsewhere (KOTLIN-style "no magic numbers" applies to JS here: named config fields).
- Decider stays ONE call per decision (adds questions, not calls). `timeoutMs: 1500` unchanged; failure falls back through `fallbackDecision` and must never throw.
- `OPENROUTER_API_KEY` is read only via `getDecisionEnv` / `getCopilotAiConfig`; never logged or sent to the renderer.
- Answer format (`LOCKED_FORMAT` in `prompts/main.js`) is parsed by `parseAnswer`; new output kinds must be additive and tolerated by the old parser.
- Copilot UI strings are plain English (not i18n yet, per CLAUDE.md).
- Tests: `node --test test/copilot/<file>`; `store/ragStore/service` tests need `ELECTRON_RUN_AS_NODE=1 npx electron --test`.

## Review Focus

- Same question spoken twice (partial then final, or mic + system echo) must produce one card.
- A rephrased repeat ("what's the price?" / "how much does it cost?") 60s later must not make a second card.
- User explicitly asks again after a card ("say that again", "explain more") must still run (explicit bypasses the guard).
- RAG returns nothing relevant: gap card, not an invented answer.
- Decider down (`decision_unavailable`): no gap/duplicate logic may throw; behaviour equals today's fallback.
- Summary call failing must not block cards (existing backoff preserved).

## File Structure

- Modify `src/copilot/core/decision/config.js`: new thresholds.
- Modify `src/copilot/core/decision/questions.js`: three new questions.
- Modify `src/copilot/core/decision/interpret.js`: use them; new `skip`/`gap` outcomes.
- Create `src/copilot/core/decision/duplicateGuard.js`: pure similarity check.
- Create `src/copilot/core/answer/sufficiency.js`: pure RAG sufficiency verdict.
- Modify `src/copilot/prompts/main.js`: strict-skip wording, `gap` deliverable.
- Modify `src/copilot/core/answer/parseAnswer.js`: parse `GAPS:` line.
- Modify `src/copilot/main/engine.js`: wire guard, richer card memory, sufficiency, gap cards, summary facts.
- Modify `src/copilot/core/summary/rollingSummary.js`: accept a `facts` block.
- Tests: `test/copilot/decision.test.js`, new `duplicateGuard.test.js`, `sufficiency.test.js`, extend `answer.test.js`, `summary.test.js`, `engine.test.js`.

---

### Task 1: Decision questions and stricter policy

**Files:**
- Modify: `src/copilot/core/decision/config.js`, `questions.js`, `interpret.js`
- Test: `test/copilot/decision.test.js`

**Interfaces:**
- Produces: config fields `answerableMin: 0.5`, `alreadyAnsweredThreshold: 0.7`, `gapMin: 0.6`, and `actThreshold.normal` raised from `0.3` to `0.45` (quiet `0.6`, chatty `0.25`). `questions.answerable` (noul: "Is new_text a question or claim that a short factual answer would resolve?"), `questions.already_answered` (noul, only when cards exist: "Did a card in `cards` already answer the same need, in any wording?"), `questions.gap` (noul: "Is key information the answer would depend on missing from new_text, summary and context?"). `interpret()` result gains `raw.answerable`, `raw.alreadyAnswered`, `raw.gap`.
- Decision kinds: existing `run|wait|skip|recheck`; `run` gains `deliverable: "gap_questions"` when `gap >= gapMin` and `answerable < answerableMin`.

- [ ] **Step 1: Write failing tests** in `decision.test.js`: (a) `already_answered` 0.8 with cards → `{kind:"skip"}` reason `already_answered 80%`; (b) `answerable` 0.2, `act` 0.4 non-explicit → `wait` reason `not_answerable`; (c) `gap` 0.7 & `answerable` 0.3 & `act` 0.6 → `run` with `deliverable:"gap_questions"`; (d) explicit request ignores `already_answered` and `answerable`; (e) `questions` omits `already_answered` when no cards.
- [ ] **Step 2: Run** `node --test test/copilot/decision.test.js` → new tests FAIL.
- [ ] **Step 3: Implement** the config fields, the questions in `buildQuestions(ctx)` (`already_answered` only inside the `ctx.hasCards` branch), and in `interpret()` apply in order after the existing `explicit` / `supersede` / cooldown checks: `already_answered >= alreadyAnsweredThreshold` → skip; `answerable < answerableMin && gap < gapMin` → wait `not_answerable`; gap rule → `go({kind:"gap_questions"})`. Missing answers for the new questions are treated as neutral (answerable 1, others 0) so an older decider response still works.
- [ ] **Step 4: Run** `node --test test/copilot/decision.test.js` → PASS (update thresholds in existing tests that depended on `0.3`).
- [ ] **Step 5: Commit** `git commit -m "feat(copilot): decider answerable/already_answered/gap questions and stricter bar"`

### Task 2: Duplicate guard

**Files:**
- Create: `src/copilot/core/decision/duplicateGuard.js`
- Test: `test/copilot/duplicateGuard.test.js`

**Interfaces:**
- Produces: `isDuplicate({ text, cards, asked, now, windowMs, minOverlap }) -> { duplicate: boolean, matchedJobId?: string, score: number }`. `cards` items: `{ jobId, gist, title?, body?, shownAt }`. Uses lowercase content-word sets (drop stop words, digits kept), Jaccard overlap `>= minOverlap` (config `duplicateOverlap: 0.6`) against cards younger than `duplicateWindowMs: 300000` and against `asked` (Set of normalized strings).

- [ ] **Step 1: Write failing tests**: identical text → duplicate; "what's the price" vs "how much does the price cost" → duplicate (overlap on `price`); different topic → not; card older than window → not; empty text → not; numbers differ ("$20 a month" vs "$40 a month") → not duplicate.
- [ ] **Step 2: Run** `node --test test/copilot/duplicateGuard.test.js` → FAIL.
- [ ] **Step 3: Implement** `isDuplicate` and a local `contentWords(text)`; stop-word list inline, kept short.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(copilot): deterministic duplicate guard`

### Task 3: Wire guard and longer card memory in the engine

**Files:**
- Modify: `src/copilot/main/engine.js` (`runDecision`, cards memory around lines 851-1010; `cards` slice(-2))
- Test: `test/copilot/engine.test.js`

**Interfaces:**
- Consumes: `isDuplicate` (Task 2).
- Produces: `s.cards` keeps last 6 (was 2) with `title`/`body` filled when the job finishes; the decider `recentCards` input still sliced to 2 in `buildState.js`; `runDecision` skips with reason `duplicate_guard` before spending a card when `decision.kind==="run"`, `trigger!=="explicit"` and `isDuplicate(...)` true (card-less `addSkipped` not called for duplicates).

- [ ] **Step 1: Write failing engine tests** using the existing fake-client helpers in `test/copilot/helpers.js`: same question twice 10 s apart → exactly one card; reworded repeat → one card; explicit repeat → two cards.
- [ ] **Step 2: Run** `node --test test/copilot/engine.test.js` → FAIL.
- [ ] **Step 3: Implement**: raise the card list cap via named const `MAX_CARD_MEMORY = 6`; fill card `title/body` in the `handle.done.then` of `startAnswer`; apply the guard right before `s.jobs.push(job)`; add decision record reason.
- [ ] **Step 4: Run** → PASS, then run `node --test test/copilot/*.test.js` excluding the Electron-only files; no regressions.
- [ ] **Step 5: Commit** `feat(copilot): skip repeat questions before they become cards`

### Task 4: Strict answer prompt and gap-question output

**Files:**
- Modify: `src/copilot/prompts/main.js`, `src/copilot/core/answer/parseAnswer.js`
- Test: `test/copilot/answer.test.js`

**Interfaces:**
- Produces: `BY_DELIVERABLE.gap_questions` instructing: "Do not answer. Name what is missing and write at most 2 questions the USER can ask the client, plain words, each at most 14 words, only questions the missing facts require." Format line `GAPS: <question> | <question>`. `parseAnswer(text)` returns `gaps: string[]` (max 2, same tolerance as `followups`, hidden from body while streaming). `SKIP_RULE` tightened: SKIP also when the moment repeats a point in "Earlier cards" or only restates the transcript.

- [ ] **Step 1: Write failing tests**: `parseAnswer("TITLE: x\n- a\nGAPS: Which plan? | By when?")` → `gaps` equals both, body excludes the line; partial `GA` line not in body; reply with no GAPS → `gaps: []`; prompt for `gap_questions` contains "Do not answer".
- [ ] **Step 2: Run** `node --test test/copilot/answer.test.js` → FAIL.
- [ ] **Step 3: Implement** the prompt text and parser change (reuse the `followups` regex approach).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(copilot): gap-question card format and stricter skip rule`

### Task 5: RAG sufficiency and gap cards

**Files:**
- Create: `src/copilot/core/answer/sufficiency.js`
- Modify: `src/copilot/main/engine.js` (`startAnswer`, the RAG block around lines 425-570)
- Test: `test/copilot/sufficiency.test.js`, `test/copilot/engine.test.js`

**Interfaces:**
- Produces: `judgeSufficiency({ project: boolean, passages: string, hits: Array<{score:number}>, minScore: number, minHits: number }) -> "enough" | "thin" | "none"`. Config `sufficiency: { minScore: 0.69, minHits: 1 }` (reuses the existing auto-look floor). Engine rule: when `spec.project` or `projectAuto` ran and the verdict is `none` and the decision asked for a factual answer → rerun spec as `deliverable:"gap_questions"`; `thin` → keep deliverable but append the caveat line "State what is not in the files." to the user message.
- Consumes: `retrieve.js` result (`hits`, `passages`), existing `ragResult`.

- [ ] **Step 1: Write failing tests**: no hits → `none`; one hit below `minScore` → `none`; one hit above → `enough` with long passages, `thin` when passages under 200 chars; engine test with a stub retriever returning nothing → card has `gaps` and no invented answer.
- [ ] **Step 2: Run** both files → FAIL.
- [ ] **Step 3: Implement** `judgeSufficiency` (pure) and the engine branch; log the verdict in the existing `copilot-rag.jsonl` stage record.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(copilot): RAG sufficiency check turns empty retrieval into gap questions`

### Task 6: Gap card in the UI state

**Files:**
- Modify: `src/copilot/main/engine.js` (card event payload), `src/components/copilot/copilotState.ts`, the card component under `src/components/copilot/` that renders followups
- Test: `test/copilot/copilotState.test.js`

**Interfaces:**
- Produces: card event field `gaps: string[]`; reducer stores it; UI renders gaps as a labelled "Ask them" list with a copy-on-tap behaviour matching followups. Tapping a gap does NOT start a new job (unlike followups).

- [ ] **Step 1: Write failing reducer test**: card event with `gaps` is kept, idempotent on replay.
- [ ] **Step 2: Run** `node --import tsx --test test/copilot/copilotState.test.js` → FAIL.
- [ ] **Step 3: Implement** reducer field and the render block; follow existing card component styling.
- [ ] **Step 4: Run** → PASS; `yarn build`-equivalent `npm run build` type check passes.
- [ ] **Step 5: Commit** `feat(copilot): show Ask-them gap questions on cards`

### Task 7: Summary with conversation, facts and open gaps

**Files:**
- Modify: `src/copilot/core/summary/rollingSummary.js`, `src/copilot/main/engine.js` (`maybeUpdate` call sites and recap at ~line 621)
- Test: `test/copilot/summary.test.js`

**Interfaces:**
- Produces: `maybeUpdate(transcript, extras?: { cards: Array<{title:string, body:string}>, gaps: string[] })`; `buildSummaryMessages(previous, lines, maxWords, skipped, extras)` appends "Facts already shown from the project files:" and "Still unanswered:" blocks (each clipped, max 600 chars). `SYSTEM` prompt adds: keep decisions, commitments, answered facts and open questions separate; never restate a card verbatim. Recap deliverable (`summary`) receives the same extras plus retrieved file names.

- [ ] **Step 1: Write failing tests**: messages include card facts and gaps when given; omitted blocks when extras empty (existing outputs unchanged); output word cap unchanged.
- [ ] **Step 2: Run** `node --test test/copilot/summary.test.js` → FAIL.
- [ ] **Step 3: Implement** extras plumbing; engine passes the last 6 finished cards and unanswered gaps (gaps cleared when a later card answers the same text per Task 2 guard).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(copilot): summary uses cards, retrieved facts and open questions`

### Task 8: Replay check and docs

**Files:**
- Modify: `docs/copilot/DECISION_MODEL_DESIGN.md` (add a "2026-11 update" note), `docs/copilot/MEETING_LOGS_TEST_REPORT.md` unchanged
- Run: `scripts/copilot/replay-fast.mjs` on the saved meetings

- [ ] **Step 1:** Run the replay before/after with `COPILOT_DECISION_MODEL` unchanged; record cards per meeting, duplicate count (cards whose `isDuplicate` vs an earlier card is true), and skipped-real-questions.
- [ ] **Step 2:** Adjust only config thresholds from Task 1 if real questions get dropped (target: duplicates ≈ 0, no explicit request dropped).
- [ ] **Step 3:** Document the new questions, thresholds and gap flow; commit `docs(copilot): decision/gap flow update`.

## Self-Review

- Coverage: Decision calling → T1, T3; RAG flow → T5; gap questions → T4-T6; dynamic output (only needed questions, max 2) → T1, T4; summary → T7; duplicates → T2, T3.
- Types: `isDuplicate`, `judgeSufficiency`, `gaps: string[]`, `deliverable: "gap_questions"` named identically across tasks.
- Risk to verify at Task 8, not assumed: `pplx-decider-v1.2` must accept the extra `noul` questions (same type as existing ones; the older-response fallback in T1 covers a decider that ignores them).
