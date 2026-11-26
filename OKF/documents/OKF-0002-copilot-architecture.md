---
id: "OKF-0002"
title: "Live Meeting Copilot Architecture and Precedence Contract"
description: "Authoritative as-built specification for in-app Copilot engine orchestration, decision tiers, and RAG boundaries."
owner: "pgagi-abhishek-khatri"
status: "approved"
version: "1.1.0"
canonical: true
bundle_id: "openwhispr-canonical-v1"
tags:
  - "domain:copilot"
  - "type:architecture"
  - "tier:core"
superseded_by: null
created_at: "2026-11-16T11:00:00Z"
updated_at: "2026-11-26T12:00:00Z"
---

# Live Meeting Copilot Architecture and Precedence Contract (OKF-0002)

## 1. Scope & Authority

This document defines the authoritative, as-built architecture for the OpenWhispr / Meethu Live Meeting Copilot (`src/copilot/`). It supersedes preliminary design proposals and historical discussion notes regarding the copilot loop, decision routing, and storage isolation.

## 2. Core Orchestration Pipeline

The live meeting copilot executes the following deterministic lifecycle:

```
Meeting Audio (Mic + System WASAPI / Linux Loopback)
        │
        ▼
STT Provider (Soniox streaming tokens)
        │
        ▼
Utterance Preprocessing (merge cut-up slices, drop backchannel)
        │
        ▼
Scheduler (turn gap 600 ms, 150 ms after a question; debounce 600 / 150 ms;
           minimum 2.5 s between decider calls, 0.8 s when a question waits; a monologue is read every 8 s)
        │
        ▼
D1 Decider (fast decision model via OpenRouter /systemone, default perplexity/pplx-decider-v1.2, 1.5 s timeout)
        ├─ act / chatter / help / needs_project / needs_web
        └─ prefetch: project query embedding and vector matrix warm-up start while D1 evaluates
        │
        ▼
When-to-Call Router (direct answer │ local code │ canonical OKF │ project files)
        │
        ├─ Local code path (Section 4): vectorless index of a connected repository + local git registry
        ├─ OKF path (Section 5): canonical documents, feature registry, temporal routing
        └─ Project files path (Section 3): hybrid keyword + vector retrieval
        │
        ▼
Context Pack (budgeted prompt construction)
        ├─ rolling summary
        ├─ notes / agenda plan
        ├─ code, canonical and project passages (each fenced as data, Section 7)
        └─ thread history
        │
        ▼
Answer Model (fast tier; high-effort rerun on a stronger model with web search)
        │
        ▼
Answer Verifier & Card Stream (skip pure chatter or low-confidence proactive cards)
```

## 3. Project Files: Storage, Retrieval, Relevance

1. **Database isolation**:
   - The Copilot maintains its own SQLite database at `userData/copilot.db` via `better-sqlite3`.
   - It never reads or modifies tables of the main note database (`userData/app.db`).
2. **Tables**: `copilot_sessions`, `copilot_segments`, `copilot_cards`, `copilot_threads` (meetings);
   `copilot_projects`, `copilot_project_files`, `copilot_project_rules` (projects and the calendar rules that pick one);
   `copilot_chunks` and its FTS5 index (project passages and vectors); `copilot_code_repos`, `copilot_code_cache`
   (connected repositories and the parsed-file cache).
3. **Embeddings**: `google/gemini-embedding-2` cut to 768 dimensions (Matryoshka). A live question's embedding
   times out at 1.5 s and retries once; embeddings are cached by normalised text (case, spacing and end punctuation ignored).
4. **Search**: SQLite FTS5 keyword search is merged with in-memory brute-force cosine search by Reciprocal Rank
   Fusion (k = 60, keyword weight 0.8, written/rewritten queries 0.7 of that). Keyword queries include identifier
   parts (`retrieveChunks` finds `retrieve_chunks`).
5. **Query rewriting**: the fast path builds extra keyword queries deterministically (identifiers split, filler
   dropped) and does not wait for a model. The deep path may ask the query model and waits at most 1.5 s.
6. **Thresholds**: relevance floor cosine ≥ 0.58 and within 0.05 of the query's best match; unasked auto-look ≥ 0.69.
7. **Start together**: the temporal router, one authoritative lookup per project, the question embedding and the
   query model all start at once; the answer is no slower than the slowest.

## 4. Local Code Repositories

1. A repository the user adds through the folder picker is indexed vectorlessly: Code-to-MD per file, BM25 over
   stemmed identifier tokens, a dependency graph with personalised PageRank, and a local git registry. No vectors and no GitHub calls.
2. **Freshness**: before each question a fingerprint (git HEAD, status and the size/mtime of changed files, or a
   bounded directory walk outside git) is compared with the one the index was built from; the index is rebuilt
   only when it differs. A build runs in time slices so it cannot freeze the app.
3. **Scope**: tracked and not-ignored files only inside a git repository (`.gitignore` is honoured). Caps are reported, never silent
   (`truncated`, `skippedLarge`). At most 8 repositories are cached in memory.
4. **Secrets**: credential-shaped text (cloud keys, tokens, private-key blocks, assigned secrets) is replaced
   in place before indexing and again before search text is returned.
5. Every `code-*` request must name a repository the user added; git refs are validated and never parsed as options.

## 5. Document Precedence Contract

Implemented once, in `src/copilot/core/okf/precedence.js`. When documents disagree:
1. **Status**: `approved` overrides `draft`, `deprecated` and unverified documents.
2. **Kind**: a canonical OKF document overrides as-built documents, which override agreed changes, then requirements,
   then proposals, then informal notes.
3. **Version**: a newer semantic version overrides an older one; a malformed version ranks below every valid one.
4. **Date**, then document id, so the order is stable.
5. A superseded document redirects to its approved successor (`superseded_by`), following the chain.
6. If canonical facts contradict the meeting or an assumption, the answer must say it is the canonical specification and name it.

## 6. Bundle Integrity

1. `OKF/manifest.yaml` carries each document's SHA-256. A document whose bytes differ is refused at runtime,
   logged (`okf_integrity_failed`) and listed by the registry; it is never served as canonical.
2. A manifest that cannot be parsed is reported as a load failure (`okf_manifest_parse_failed`), distinct from an absent bundle.
3. A feature that cites an `OKF-####` document must cite one that exists in the manifest (`npm run validate:okf`);
   citations of project documents are allowed and flagged as unverifiable.
4. `npm run validate:okf` also checks front matter parity, `superseded_by` parity and the JSON Schemas in `OKF/schemas/`.

## 7. Privacy and Trust Boundaries

1. Retrieved passages are wrapped in a fence and marked as data, not instructions; text that imitates the fence is removed.
2. The retrieval log stores a question's length and a short hash, not its words (opt in with `COPILOT_LOG_CONTENT=1`).
3. Paths from the window are checked: dropped files may not be secrets or system files; repositories must be registered.
4. The OpenRouter key is stored in the OS keychain when available; the settings page says when it is not.

## 8. Revision History

- `1.1.0` (2026-11-26): Added the local code path, freshness, secrets handling, the parallel retrieval design,
  the precedence implementation, bundle integrity, trust boundaries; corrected the scheduler timings and the
  decider model; added the tables omitted from 1.0.0.
- `1.0.0` (2026-11-16): Initial canonical baseline formalizing the live copilot architecture.
