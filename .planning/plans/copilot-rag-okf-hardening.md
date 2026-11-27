# Plan: Copilot repo-context RAG + OKF hardening

**Spec**: none (planned from the code-review findings; see "Findings map")
**Epic**: none
**Created**: 2026-11-26
**Status**: in progress (Phase 1 partly done, Phase 3 mostly done; see progress below)
**Stack**: Electron + Node (JS), tests via `node --import tsx --test` (pure) and `ELECTRON_RUN_AS_NODE=1 npx electron --test` (better-sqlite3 modules)

## Goal

Questions about an added repo/files answer fast (fast card p50 <= 1.2 s retrieval, deep <= 2.5 s), from an index that is never stale, without freezing the main process or leaking secrets to external models, with OKF acting as a verified authority.

## Findings map (review # -> phase)

| Phase | Review findings |
|---|---|
| 1 Freshness + off-main-thread | 1, 2, 28, 29, 16 (partly) |
| 2 Retrieval latency | 3, 12, 13, 14 |
| 3 Security | 5, 6, 7, 8, 9, 10 |
| 4 Code-aware quality | 4, 11, 15, 16, 17 |
| 5 OKF integrity | 18-25 |
| 6 Tests + silent catches | 26, 27, 30 |

## Sequencing

Phase 3 (security) and Phase 1 start first and in parallel: they touch different files except `service.js`. Phase 2 follows 1 (shares `retrieve.js` less, but benefits from a fresh index when benchmarking). Phase 4 follows 2 (chunking changes need the new cache keys). Phase 5 is independent and can run beside 2/4. Phase 6 tests are written **inside each phase first (TDD)**; Phase 6 itself only fills leftover gaps and the silent-catch sweep.

```
P3 ─┐
P1 ─┼─► P2 ─► P4 ─┐
P5 ─┴────────────┴─► P6 (gap fill, final gate)
```

Rule for every task: write the failing test first, then the code, then one commit. Max 3 files per task. Shared file `src/copilot/main/service.js` is edited by P1 and P3; do those tasks sequentially, not in parallel.

---

## Phase 1: Freshness + off-main-thread indexing

**Acceptance**
- Edit/add/delete a file or switch branch, then ask a question: the answer reflects it with no manual refresh.
- Cold index of a 1500-file repo does not block the main process for more than 50 ms at a time (measured by event-loop lag in a test).
- Warm freshness check <= 50 ms.

| # | Task (test first) | Files |
|---|---|---|
| 1.1 | Add `repoFingerprint(repoDir)`: `git rev-parse HEAD` + `git status --porcelain` hash (non-git: dir mtime walk fallback). Async, with a 5 s timeout. Test: fingerprint changes on edit, branch switch, untracked file; stable otherwise. | `src/copilot/rag/repoFingerprint.js` (new), `test/copilot/repoFingerprint.test.js` (new) |
| 1.2 | Make `runGit` async with timeout and stderr capture; keep the sync API only where tests need it. Test: hung git is killed; non-git dir reports an error, not branch "HEAD". | `src/helpers/connectors/gitLocalAdapter.js`, `test/helpers/gitLocalAdapter.test.js` |
| 1.3 | `GitRegistry.refresh()` (re-sync branches/commits/active branch) and call it when the fingerprint changes; raise the 30-commit cap to configurable. Test: registry reflects a new commit/branch. | `src/copilot/core/okf/gitRegistry.js`, `test/copilot/gitRegistry.test.js` |
| 1.4 | Convert `createLocalCodeIndex` walk/read to async (`fs.promises`, yielding every N files) and report `{truncated, skippedLarge}`. Test: event-loop lag under threshold on a generated 1500-file fixture; truncation flag set. | `src/copilot/rag/vectorlessCodeSearch.js`, `test/copilot/vectorlessCodeSearch.test.js` (new) |
| 1.5 | Move the index build to a worker thread (`worker_threads`) with a small client; main only posts results. Test: build result equals the in-process build; worker crash rejects and respawns. | `src/copilot/rag/codeIndexWorker.js` (new), `src/copilot/rag/codeIndexClient.js` (new), `test/copilot/codeIndexClient.test.js` (new) |
| 1.6 | Replace the forever-cache `codeSynths` with a bounded LRU keyed by registered repo id; `ensureFresh(repo)` compares the fingerprint before each `code-*` call and rebuilds incrementally (the cache already skips unchanged files). Evict on `code-repo-remove`. Test: stale index is rebuilt; removed repo is evicted; the map never exceeds the cap. | `src/copilot/main/service.js`, `src/copilot/rag/codeSynthCache.js` (new), `test/copilot/codeSynthCache.test.js` (new) |
| 1.7 | Cap ingestion concurrency in `addPaths` and `resumeIndexing` (queue, default 3). Test: never more than N in flight. | `src/copilot/rag/ingest.js`, `src/copilot/main/service.js`, `test/copilot/ingestQueue.test.js` (new) |

Parallel: 1.1, 1.2, 1.4 (independent files). Sequential: 1.3 after 1.2; 1.5 after 1.4; 1.6 after 1.1, 1.3, 1.5; 1.7 after 1.6 (same `service.js`).

---

## Phase 2: Retrieval latency

**Acceptance (measured by a benchmark script against a fixed fixture, p50/p95)**
- Fast-path retrieval p50 <= 1.2 s, p95 <= 2.0 s with a warm embed cache; no LLM call on the fast path's critical path.
- Deep path capped at 1.5 s waiting for the query writer.
- Vector top-k at 20k chunks x 768 dims <= 40 ms.

| # | Task (test first) | Files |
|---|---|---|
| 2.1 | Benchmark harness: replay N questions against a fixture index with fake clients, record stage timings from `copilot-rag.jsonl`. Gives the baseline before any change. | `scripts/copilot/retrieve-bench.js` (new), `test/copilot/retrieveStages.test.js` (new) |
| 2.2 | Parallelize in `retrieve.js`: start `rawEmbed` and writer immediately; run temporal router, ALS (per project, `Promise.all`), embed and writer concurrently; preserve result semantics. Test with fake slow clients: total time ~ max, not sum; results identical to serial. | `src/copilot/rag/retrieve.js`, `test/copilot/retrieveParallel.test.js` (new) |
| 2.3 | Deterministic code-aware query rewrite (`rewriteQuery`: identifier split, stopword strip, quoted-symbol keep). Fast path uses it; LLM writer only on deep or when the rewrite yields < 2 terms; deep waits <= 1.5 s (`queryWaitMs`). Test: rewrite cases; the fast path makes zero writer calls. | `src/copilot/rag/queryRewrite.js` (new), `src/copilot/rag/config.js`, `test/copilot/queryRewrite.test.js` (new) |
| 2.4 | Heap-based top-k (min-heap size k) in `vectors.js`; test equivalence with the old sort on random data and a timing assertion. | `src/copilot/rag/vectors.js`, `test/copilot/vectors.test.js` (new) |
| 2.5 | Incremental matrix update in `ragStore` (append/remove rows, no wholesale rebuild); warm the matrix at project load. Test: add/delete a chunk without a full rebuild; search results unchanged. | `src/copilot/rag/ragStore.js`, `test/copilot/ragStore.test.js` |
| 2.6 | Caching: normalise the embedding cache key (collapse whitespace, last-sentence window); result cache keyed by `(project data version, normalised query)`; ALS key excludes the rolling transcript tail; LRU instead of FIFO. Test: hit/miss and invalidation on data change. | `src/copilot/rag/embedClient.js`, `src/copilot/rag/retrieve.js`, `src/copilot/rag/authoritativeLookup.js` |
| 2.7 | Embedding timeout/retry fix: one fast retry within `embedWaitMs`; log the keyword-only fallback reason into the trace. Test: failure then success inside the wait; fallback path recorded. | `src/copilot/rag/openrouter.js`, `src/copilot/rag/retrieve.js`, `test/copilot/openrouterRetry.test.js` (new) |

Parallel: 2.3, 2.4, 2.5 (separate files). Sequential: 2.1 first (baseline); 2.2 after 2.1; 2.6/2.7 after 2.2 (same `retrieve.js`).

---

## Phase 3: Security (start in parallel with Phase 1)

**Acceptance**
- A renderer-supplied path outside registered repos or dropped files is refused.
- `base=--output=/x` cannot write a file.
- A `.env`/`*.pem`/`credentials.json` is never indexed, embedded or put in a prompt.
- Retrieved text cannot close its own fence.

| # | Task (test first) | Files |
|---|---|---|
| 3.1 | `pathPolicy`: allowlist from registered repos and main-process dialog/drop results; denylist (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `credentials*`, `secrets.*`, `.ssh`, `.aws`). Test: allow, deny, traversal, symlink escape. | `src/copilot/core/validation/pathPolicy.js` (new), `test/copilot/pathPolicy.test.js` (new) |
| 3.2 | Enforce the policy in `project-add-paths`, `code-*` handlers, `project-preview-file`; remove the silent fall-back to indexing the original path when the copy fails. Test via handler unit with a stubbed ipc. | `src/copilot/main/service.js`, `test/copilot/serviceIpcSecurity.test.js` (new) |
| 3.3 | Git ref validation (`^[\w./@{}-]+$`, no leading `-`, `git check-ref-format`), `--end-of-options` and `--` in `getLocalDiff`/`searchCommits`. Test: `--output=...`, `-x`, spaces rejected. | `src/helpers/connectors/gitLocalAdapter.js`, `test/helpers/gitLocalAdapter.test.js` |
| 3.4 | Ignore + secret filter in the repo walk and file ingest: honour `.gitignore`, denylist from 3.1, drop `.json/.yaml/.csv/.log` from default ingestable types unless explicitly added, and a cheap secret-pattern scan (AWS/GitHub/OpenAI key shapes, PEM headers) that skips the file and logs a count. Test fixtures with fake secrets. | `src/copilot/rag/vectorlessCodeSearch.js`, `src/copilot/rag/config.js`, `src/copilot/rag/secretScan.js` (new) |
| 3.5 | Fence retrieved passages: `<retrieved_context>` wrapper, "data, not instructions" line, strip lookalike tags from passage text (reuse the `withoutAttendeesFence` approach). Test: an injected closing tag is neutralised. | `src/copilot/rag/retrieve.js`, `src/copilot/prompts/main.js`, `test/copilot/promptFence.test.js` (new) |
| 3.6 | Log hygiene: hash or omit question text in `copilot-rag.jsonl`, include the file in the retention sweep, log write errors once; chmod 0600 on the plaintext API-key fallback and warn in the UI; code cache out of `os.tmpdir()` into userData. | `src/copilot/rag/ragLog.js`, `src/copilot/main/settings.js`, `src/copilot/rag/codeCacheStore.js` |

Parallel: 3.1, 3.3, 3.5, 3.6. Sequential: 3.2 after 3.1; 3.4 after 3.1.

---

## Phase 4: Code-aware retrieval quality (after Phase 2)

**Acceptance**
- On a labelled set of >= 30 repo questions (exact symbol, path, concept), recall@5 improves versus the Phase 2 baseline, with no latency regression beyond +10%.
- `retrieveChunks` matches `retrieve_chunks`; two-letter identifiers searchable.

| # | Task (test first) | Files |
|---|---|---|
| 4.1 | Labelled eval set + runner (extends `scripts/copilot/rag-query-eval.js`); record the baseline recall@5/MRR. | `scripts/copilot/rag-query-eval.js`, `test/copilot/fixtures/repo-eval.json` (new) |
| 4.2 | Identifier-split shadow column + trigram FTS table; `ftsQuery` keeps short tokens, boosts exact symbol/path hits. Migration for existing DBs. Test: camel/snake matching, migration idempotent. | `src/copilot/rag/ragStore.js`, `test/copilot/ragStore.test.js` |
| 4.3 | Symbol-aware chunking: one chunk per function/class, prefix `path > symbol`, keep short tail chunks (merge instead of dropping). Test: no dropped code (concatenation covers the file), path in embedded text. | `src/copilot/rag/codeExtract.js`, `src/copilot/rag/chunker.js`, `test/copilot/codeExtract.test.js` |
| 4.4 | Extractor: class methods, multi-line signatures, decorators, Python relative imports. Test per language fixture. | `src/copilot/rag/codeExtract.js`, `src/copilot/rag/codeGraph.js` |
| 4.5 | Cache versioning: `EXTRACTOR_VERSION` column in SQLite and JSON backends; mismatch re-parses; optional content hash for same-size edits. Test: bump forces re-parse. | `src/copilot/rag/codeCacheStore.js`, `src/copilot/rag/vectorlessCodeSearch.js`, `test/copilot/codeCacheStore.test.js` |
| 4.6 | Neighbour-chunk expansion for the top hit, per-file diversity cap, passage clip raised for code (budget-aware), adaptive floor (percentile of the corpus score distribution) instead of fixed 0.58 / 0.05 margin; rerank top N instead of hard filter. Test with the eval set; budget never exceeded. | `src/copilot/rag/retrieve.js`, `src/copilot/rag/config.js` |
| 4.7 | Surface truncation: UI/status shows "indexed 1500 of N files, M skipped (size)". Make caps configurable. | `src/copilot/main/service.js`, `src/components/copilot/CopilotProjects.tsx` (+ locale strings if the UI uses i18n) |

Parallel: 4.2, 4.3/4.4 (different files), 4.5. Sequential: 4.1 first; 4.6 after 4.2/4.3.

---

## Phase 5: OKF integrity (independent; can run beside 2/4)

**Acceptance**
- A document whose bytes differ from its manifest sha256 is rejected or flagged at load, with a logged reason.
- One module owns precedence (status, then semver, then kind); `docPrecedence` and OKF routing use it.
- `npm run validate:okf` fails on dangling `document_id`.

| # | Task (test first) | Files |
|---|---|---|
| 5.1 | Verify sha256 in `registry.getDocument`; mismatch returns a `tampered` flag and is excluded from "canonical"; log the reason. Test: tamper detection. | `src/copilot/core/okf/registry.js`, `test/copilot/okfRegistry.test.js` (new) |
| 5.2 | Stop swallowing registry load errors: return a typed error and log it; `hasBundle()` reports why it is false. | `src/copilot/core/okf/registry.js` |
| 5.3 | `featureRegistryValidator`: `document_id` must exist in the manifest; fix or remove the fictional `client_requirements_v1/v2` entries. Test: dangling id fails. | `src/copilot/core/okf/featureRegistryValidator.js`, `OKF/registry/feature_registry.yaml`, `test/copilot/okfFeatureRegistry.test.js` |
| 5.4 | `precedence.js`: single implementation of the four manifest rules; wire into `router.js` (deprecated -> redirect to superseding doc instead of silent drop), `docPrecedence.js`, and the answer prompt (cite the canonical spec per OKF-0002 section 5.3). Test each rule. | `src/copilot/core/okf/precedence.js` (new), `src/copilot/core/okf/router.js`, `src/copilot/rag/docPrecedence.js` |
| 5.5 | `compareSemVer` returns null/throws a typed error handled by callers; audit callers. Test: invalid semver cannot break an answer. | `src/copilot/core/okf/versionResolver.js`, `test/copilot/versionResolver.test.js` |
| 5.6 | Use `OKF/schemas/*.json` in `validate-okf.js` (ajv) or delete them; remove the duplicate hand-written rules. | `scripts/validate-okf.js`, `OKF/schemas/*` |
| 5.7 | Consolidation spike: map overlap between `lookup`, `router`, `temporalRouter`, `featureRegistry`; extract one shared matcher. Deliver a design note first, refactor behind the existing tests. | `docs/copilot/OKF_ROUTING.md` (new), then `src/copilot/core/okf/*` |
| 5.8 | Update OKF-0002 (code/git path, new tables, the real pipeline diagram), bump to 1.1.0 and refresh sha via `validate-okf --fix`. | `OKF/documents/OKF-0002-copilot-architecture.md`, `OKF/manifest.yaml` |

Parallel: 5.1/5.2, 5.3, 5.5, 5.6. Sequential: 5.4 after 5.1; 5.7 after 5.4; 5.8 last (so the doc describes the final state).

---

## Phase 6: Tests + silent catches (gap fill and final gate)

| # | Task | Files |
|---|---|---|
| 6.1 | Dedicated `retrieve.js` tests: temporal-router error path (`retrieve.js:144`), `als_error` (`:209`), weak-match, keyword-only fallback, floor/margin behaviour. | `test/copilot/retrieve.test.js` (new) |
| 6.2 | `scientistSynthesizer` and `intentPatterns` tests. | `test/copilot/scientistSynthesizer.test.js`, `test/copilot/intentPatterns.test.js` (new) |
| 6.3 | `code-*` IPC handler tests (path policy, ref validation, eviction) beyond the store-only test. | `test/copilot/codeIpcHandlers.test.js` (new) |
| 6.4 | Fix silent catches: `engine.js:391`, `ragLog.js:17`, `codeCacheStore.js:157`, `registry.js`; extend `noSilentCatch.test.js` so these are no longer whitelisted. | listed files, `test/copilot/noSilentCatch.test.js` |
| 6.5 | CI: add `ELECTRON_RUN_AS_NODE=1 electron --test test/copilot/*.test.js` and `validate:okf` to the quality gate; document in `docs/copilot/DEV_HARNESS.md`. | `package.json`, `docs/copilot/DEV_HARNESS.md` |

---

## Testing plan summary

| Layer | Coverage |
|---|---|
| Unit | fingerprint, pathPolicy, secretScan, queryRewrite, vectors heap, precedence, semver |
| Integration | index build in worker, ragStore migration, retrieve (parallel + fallbacks), OKF registry tamper |
| IPC | `code-*`, `project-add-paths`, preview handlers with hostile input |
| Performance | `retrieve-bench.js` p50/p95 gates; event-loop-lag test for index build |
| Quality | labelled repo eval recall@5/MRR with a no-regression threshold |
| Edge | non-git dir, branch switch, renamed/deleted file, > 1500 files, invalid semver, injected fence tag, hung git |

## Gate 2 checklist

- [x] Follows existing architecture (Electron main/rag/core split; no new layer violations)
- [x] All files to change and all new files listed with locations
- [x] Tasks are small (<= 3 files), dependencies and parallel groups marked
- [x] Data, logic, IPC and performance tests planned, edge cases covered
- [ ] **Open decisions (need the user before build):** (a) worker_threads vs child process for the index; (b) whether to add ajv for schemas or delete them; (c) whether the secret scan should block or warn; (d) latency targets above are estimates until 2.1 produces a real baseline.

## Risks

- `service.js` is a 1146-line hot file touched by P1 and P3: serialize those tasks.
- Changing chunking (4.3) invalidates stored vectors: needs a re-embed migration with progress UI and cost estimate (OpenRouter calls).
- FTS migration (4.2) must be reversible; back up `copilot.db` first.
- Findings come from code reading, not execution: 2.1 and 4.1 establish real baselines before optimizing.

## Progress (2026-11-26)

Done: 1.1, 1.2, 1.3 (registry refresh), 1.4, 1.5 (as time-sliced generator, no worker), 1.6, 3.1, 3.2, 3.3, 3.4 (gitignore + redaction), 3.5, 3.6 (log + key flag).
Dropped: 1.7 (ingestor already limits to `filesAtOnce` = 4 and dedupes per file).
Deviations: 1.5 uses a cooperative generator instead of `worker_threads` (index holds closures that cannot cross a thread); 3.4 redacts secrets in place instead of skipping the file.
Not started: Phases 2, 4, 5, 6.
Known pre-existing failures (not caused by this work): noSilentCatch (Phase 6.4), ragStore catalog + docPrecedence retrieve (profile.js renderForAnswer), 3 OKF router tests, service.test window mode.

Phase 2 (2026-11-26): done 2.1 (script, simulated latencies), 2.2, 2.3, 2.4, 2.5 (warm in prefetch instead of incremental rebuild), 2.6 (embedding key normalised + LRU, ALS key + LRU; retrieval-result cache deliberately not built), 2.7.
Measured: vector top-k 30 -> 26 ms at 20k x 768 (the sort was never the cost); fast path 621 -> 251 ms p50 on simulated latencies (embed 250, writer 620).
New switch: RAG.fastQueryModel (default false) restores the old fast path that waits for the query model.

Phase 4 (2026-11-26): done 4.1 (35-question eval over 1193 files + regression floor), 4.2 (identifier-aware FTS terms), 4.4 (class methods, multi-line signatures, Python relative imports), 4.5 (EXTRACTOR_VERSION, now 4), 4.7 (truncation / skipped / redacted shown in the repo row), plus a light stemmer in the code search.
Measured on the eval: recall@1 0.69 -> 0.71, recall@3 0.86 -> 0.89, recall@5 0.91 -> 0.94, MRR 0.78 -> 0.81.
Not done, on purpose: 4.3 symbol-aware chunking and 4.6 neighbour expansion / adaptive thresholds for ragStore documents. They change the prompt budget and the cosine floor, and there is no labelled document set to show they help; build one first (scripts/copilot/rag-query-eval.js needs real embeddings).
Review claim not reproduced: "chunkCodeAst drops short chunks" (a trailing tiny function was kept).

Phase 5 (2026-11-26): done 5.1 (sha256 verified at load; refused + logged + listed), 5.2 (load errors visible; fixed an undefined-variable crash in the front-matter error path), 5.3 (OKF-#### citations must exist in the manifest; others warned), 5.4 (precedence.js: status > kind > semver > date, superseded redirect; wired into router + docPrecedence; prompt cites the canonical spec), 5.5 (compareSemVerLenient at 5 unguarded sites), 5.6 (schemas kept; drift test; superseded_by added), 5.7 (normalize.js extracted; design note docs/copilot/OKF_ROUTING.md for the rest), 5.8 (OKF-0002 1.1.0, manifest hash + version).
Also fixed: router sent `feat:…` queries to the local-code route (F19); two OKF-router tests now pass.
Remaining known failures (4): noSilentCatch (6.4); ragStore catalog + docPrecedence retrieve (both crash in profile.js renderForAnswer on a profile missing a list: likely a real bug, investigate in Phase 6); service.test window mode (fake window lacks setResizable).
