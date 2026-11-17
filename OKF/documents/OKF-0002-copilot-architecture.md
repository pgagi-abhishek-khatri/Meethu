---
id: "OKF-0002"
title: "Live Meeting Copilot Architecture and Precedence Contract"
description: "Authoritative as-built specification for in-app Copilot engine orchestration, decision tiers, and RAG boundaries."
owner: "pgagi-abhishek-khatri"
status: "approved"
version: "1.0.0"
canonical: true
bundle_id: "openwhispr-canonical-v1"
tags:
  - "domain:copilot"
  - "type:architecture"
  - "tier:core"
superseded_by: null
created_at: "2026-11-16T11:00:00Z"
updated_at: "2026-11-16T11:00:00Z"
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
Scheduler (wait for speaker turn to complete; gap 1.5s, 0.3s for question, 20s cap)
        │
        ▼
D1 Decider (Liquid-style fast model via OpenRouter)
        ├─ act / chatter / help / needs_project / needs_web
        └─ prefetch project search query embedding while D1 evaluates
        │
        ▼
Context Pack (Budgeted prompt construction)
        ├─ rolling summary
        ├─ notes / agenda plan
        ├─ project catalog & passages (hybrid RRF)
        └─ thread history
        │
        ▼
Answer Model (Fast tier: Qwen 27B / Claude Sonnet 5.5 on high-effort rerun)
        │
        ▼
Answer Verifier & Card Stream (skip pure chatter or low-confidence proactive cards)
```

## 3. Storage & Isolation Invariants

1. **Database Isolation**:
   - The Copilot maintains its own dedicated SQLite database located at `userData/copilot.db` via `better-sqlite3`.
   - Under no circumstances does the Copilot read or modify tables from the main application note database (`userData/app.db`).
2. **Schema Invariants**:
   - Meeting sessions are persisted in `copilot_sessions`.
   - Transcribed segments are recorded in `copilot_segments`.
   - UI cards are persisted in `copilot_cards`.
   - Vector embeddings and FTS5 full-text indices are stored in `copilot_chunks` and `copilot_chunks_fts`.

## 4. Retrieval & Relevance Floors

1. **Embedding Model**:
   - Embeddings use `google/gemini-embedding-2` truncated to 768 dimensions (Matryoshka cut).
2. **Search Fusion**:
   - Keyword search via SQLite FTS5 (BM25) is merged with in-memory brute-force cosine vector search using Reciprocal Rank Fusion (RRF, $k=60$, keyword weight $0.8$).
3. **Thresholds**:
   - Relevance floor: cosine $\ge 0.58$ and within $0.05$ of the top match.
   - Unasked auto-look: cosine $\ge 0.69$ (`AUTO_SCORE`).

## 5. Document Precedence Contract

When synthesizing answers involving project files:
1. Canonical documents in `OKF/documents/` bearing `status: approved` override planning notes, meeting transcripts, and legacy proposals.
2. As-built completion specifications override initial product proposals.
3. If canonical facts contradict meeting transcripts or external assumptions, the answer model must explicitly cite the canonical specification.

## 6. Revision History

- `1.0.0` (2026-11-16): Initial canonical baseline formalizing the live copilot architecture.
