# RAG + OKF Pipeline Proposal

## Objective

This document extends the current Copilot/RAG design rather than replacing it. The existing flow already has a strong fast-decider + retrieval + answer-card loop, and the repo docs show that the current weakness is not the file gate itself but the authority and evidence quality of the answer step.

The proposal below adds a deterministic OKF layer in front of the probabilistic RAG layer so the system can answer:

- official, versioned facts from canonical docs with high precision
- exploratory questions from broad meeting/project memory with broad recall
- mixed questions that need both authority and discovery

The goal is to keep the current method intact while adding a second memory system that resolves the exact failure pattern described in the comparison report: documents disagree, newer docs override older ones, and the answer model often chooses the wrong source without explicit authority precedence.

## Sources reviewed

The design below is based on the repository docs and the external references noted in the comparison report:

- [copilot_current_status.md](copilot_current_status.md)
- [copilot_implementation_brief.md](copilot_implementation_brief.md)
- [docs/copilot/RAG_PLAN.md](docs/copilot/RAG_PLAN.md)
- [docs/copilot/DECISION_MODEL_DESIGN.md](docs/copilot/DECISION_MODEL_DESIGN.md)
- [docs/copilot/IMPLEMENTATION_PLAN.md](docs/copilot/IMPLEMENTATION_PLAN.md)
- [docs/copilot/V2_PLAN.md](docs/copilot/V2_PLAN.md)
- [docs/copilot/phase0b-report.md](docs/copilot/phase0b-report.md)
- The comparison report referenced in the request, plus the external OKF article and the RAG survey paper.

## Summary of the current method

The current implementation already contains a capable architecture:

1. Meeting transcript enters the Copilot pipeline.
2. A small decider is used to decide whether to act and whether project context is needed.
3. The system runs a RAG-like retrieval layer over project files / meeting memory.
4. The answer model reads the moment, summary, catalog, and retrieved passages and emits a card.

This is described clearly in [copilot_current_status.md](copilot_current_status.md), [docs/copilot/RAG_PLAN.md](docs/copilot/RAG_PLAN.md), and [docs/copilot/DECISION_MODEL_DESIGN.md](docs/copilot/DECISION_MODEL_DESIGN.md).

This remains a solid live-meeting architecture. The issue is not that the system lacks retrieval; it is that the system currently lacks a strong authority layer when the information source is ambiguous or contradictory. The comparison report makes this explicit:

- all three arms send nearly every file moment to the files
- the right page is often found
- the answer model still gives the wrong answer when documents disagree or when older plans conflict with newer as-built docs
- the system can over-ask or over-search, and the answer model often solves the wrong angle even when the passage is available

This is exactly where a new OKF layer helps.

## What the external OKF article is saying

The Medium article referenced in the brief argues that RAG alone is probabilistic and semantically similar but not necessarily authoritative. The design is to split memory into two systems:

- OKF: a curated, deterministic, version-controlled, canonical source of truth
- RAG: a broad, exploratory system for unstructured, historically messy data

The key insight is not “replace RAG,” but “route to the right memory system for the question.”

This matches the core failure mode in the comparison report: source authority is missing. In other words, the system is not failing because it cannot find the document; it is failing because it cannot know which document wins when facts disagree.

The RAG survey paper reinforces the same larger design principle: modern RAG is not a single monolith but a stack of retrieval, ranking, augmentation, and verification components. The real advancements are in layered orchestration, not in any one retrieval method alone.

## Why the current RAG design needs a companion OKF layer

The current repository docs show a strong retrieval stack with:

- project file catalog
- hybrid retrieval (FTS + vector)
- RRF scoring
- retrieval floors and relevance gating
- answer model context with passages and file catalog

This is a strong exploratory layer. It is good for:

- meeting notes
- project memory
- broad search over unstructured files
- discovering a likely clue when the user is unsure what they need

But it is not sufficient for authoritative facts, formal definitions, policy decisions, or versioned “source-of-truth” data.

The comparison report identifies the exact problem:

- “The documents disagree.”
- “The answer model isn't told which document wins.”
- “The quick-answer prompt makes the model ignore passages already in context.”

This is a classic “authority gap.” An OKF layer fixes this by explicitly separating:

- canonical fact lookup
- exploratory retrieval
- final answer synthesis and evidence check

## Proposed architecture: RAG + OKF layered pipeline

### High-level flow

```text
query / meeting moment
        |
        v
D1 decider (current fast gate remains)
        |
        +--> if question is authoritative / canonical / policy / metric / API / runbook / formula
        |           -> OKF fact lookup path
        |
        +--> if question is exploratory / broad / historical / fuzzy / conversational
                    -> RAG project search path
        |
        +--> if mixed question: both -> OKF first, RAG second, then merge with precedence rules

        v
Evidence normalizer / authority resolver
        |
        v
Answer model
        |
        +--> citation / source label / precedence note
        |
        v
Final card / answer
```

### The important rule

This does not replace the current D1 and RAG logic. It adds a new authoritative retrieval tier before the answer model finalizes. The existing decider still decides whether a card or search is needed. It is simply supplemented by OKF classification and authoritative evidence routing.

## Proposed system components

### 1. Current fast gate remains unchanged

Keep the existing decisions in place:

- act / no-act
- needs project
- needs web
- card/summary/answer path
- current transcript signal handling

This is the low-latency front gate already described in [docs/copilot/DECISION_MODEL_DESIGN.md](docs/copilot/DECISION_MODEL_DESIGN.md) and [docs/copilot/phase0b-report.md](docs/copilot/phase0b-report.md).

### 2. Query type classifier

Add a lightweight classifier that asks one question before retrieval:

- is this a canonical fact query?
- is this a policy / formula / metric / contract / runbook / approved answer?
- is this an exploratory or historical knowledge query?
- is this a mixed query requiring both authority and discovery?

This is not a full LLM router. It is a deterministic classifier or a very small model call over the user question and the current moment. It decides the retrieval lane.

### 3. OKF authoritative memory layer

OKF is a curated knowledge bundle, likely stored as Markdown files in a Git-friendly canonical folder with metadata such as:

- title
- owner
- tags
- status
- version
- source of truth
- validation state
- last reviewed date
- related docs

The article’s key pattern is that each file represents a single concept with human-readable content and YAML frontmatter. This makes it ideal for:

- official formulas
- status definitions
- API contracts
- business metrics
- runbooks
- approved product facts
- policy text

The logic is simple and deterministic:

- if the query matches an OKF entity, open the authoritative file directly
- do not depend on vector similarity for source-of-truth facts
- prioritize approval status and version metadata
- use newer versions over older versions when the metadata says so

### 4. RAG exploratory layer remains in place

Keep the existing project search / project memory pipeline intact:

- FTS5 + vector retrieval merging
- top-k context passages
- file catalog and profiles
- scoring floor and relevance gating

This remains the broad search system for messy data where the answer may be “what did people say”, “what did we decide”, or “what is buried in meeting transcript and project materials.”

### 5. Authority precedence resolver

This is the key new layer.

When both OKF and RAG return evidence, the resolver applies precedence rules like:

1. canonical OKF doc beats informal notes or old proposal docs
2. newest approved version beats older drafts
3. as-built documentation beats planning documents
4. official contracts / runbooks / formulas beat Slack summaries or meeting notes
5. if two facts conflict and neither is canonical, keep both and label the uncertainty

This is the direct fix for the comparison report’s observed problem: the model does not know which doc wins when contradictory files are attached.

### 6. Answer synthesis with evidence contract

The answer model is still used, but it is now forced to produce an answer under an evidence contract:

- if authoritative source found: cite it and give the answer directly
- if only exploratory source found: cite the likely file chunks and say “inferred from project material”
- if conflicting sources exist: explicitly surface the conflict and state the precedence rule
- if no reliable evidence is found: answer conservatively and say so

This solves the “wrong answer even with right passages” issue.

## New pipeline in practice

### Pipeline A: authoritative fact query

```text
user question
   -> classifier decides canonical / formula / policy / metric / runbook
   -> OKF direct lookup
   -> evidence verification (same file, latest version, owner, approved metadata)
   -> answer model with exact source excerpt
   -> final answer + canonical source reference
```

Use cases:

- “What is the official churn formula?”
- “What is the exact API contract?”
- “Which runbook is the approved recovery procedure?”
- “What is the current approved definition for this metric?”

### Pipeline B: exploratory / meeting memory query

```text
user question
   -> classifier decides exploratory or historical
   -> current RAG retrieval path (FTS + vector)
   -> relevant passages returned
   -> answer model synthesizes with context and uncertainty language
```

Use cases:

- “What did we discuss about the pricing model?”
- “Which proposal mentioned onboarding friction?”
- “Search our notes around this issue.”

### Pipeline C: mixed query

```text
user question
   -> classifier sees both canonical + exploratory need
   -> OKF lookup for official facts
   -> RAG retrieval for context and historical interpretation
   -> authority resolver merges both
   -> answer model answers with precedence and evidence labels
```

Use cases:

- “What is the approved rule, and how did the team implement it historically?”
- “What is the current policy and what do the project docs say about rollout?”

## Implementation plan inside the current repo

This should be added in layers without disturbing the current pipeline:

### Phase 1: add OKF bundle registry

- store canonical docs in a dedicated folder, e.g. project-level OKF bundle
- each file has metadata frontmatter and canonical tags
- register bundle in the Copilot project config with owner, status, and version metadata

### Phase 2: add OKF router gate

- keep the current decider
- add a tiny query classifier that selects `okf`, `rag`, or `mixed`
- route before the final answer synthesis step only

### Phase 3: add authoritative lookup service

- exact title / keyword / tag lookup
- metadata-based version resolution
- precedence rules for version and status
- no vector search for canonical source-of-truth facts

### Phase 4: add evidence precedence resolver

- apply source-of-truth ranking
- identify conflicting records
- present the winner plus a confidence label

### Phase 5: answer model evidence contract

- answer model must say whether it used canonical docs, exploratory docs, or both
- if conflicting docs exist, say which one wins and why

### Phase 6: keep the current pipeline as fallback

- if no OKF result exists, fall back to the existing RAG pipeline
- if OKF result exists but is incomplete, use RAG as supporting context

## Detailed comparison against the current report

### Comparison table

| Dimension | Current A0 / current RAG | P profile variant | T split-gate variant | Proposed RAG + OKF |
|---|---|---|---|---|
| Search trigger | D1 decides together with other tasks | D1 sees richer profiles | separate gate after card decision | same current gate remains, plus authoritative route classifier |
| Retrieval source | project files and excerpts | richer file profiles | same file set, different gate timing | OKF for canonical truth + RAG for exploratory memory |
| Authority model | implicit, weak | stronger summarized profiles | still weak, no document precedence | explicit authority and precedence rules |
| Contradictory docs | unresolved | unresolved | unresolved | resolved by canonical precedence |
| Best use case | broad project memory | slightly more informed file matching | fewer wasted searches | both official fact lookup and exploratory search |
| Failure mode | wrong answer when docs disagree | still wrong in many cases | lower wasted searches but slower | corrects source-of-truth issues first |
| Latency | fastest | slower | slower due to added gate | near current with small authoritative lookup overhead |
| Cost | lower | higher | lower than P but still slower | modest increase, but far more reliable answers |
| Risk | false positives and weak factual grounding | adds context burden | adds waiting | route-based, with fallbacks |

### Real-check interpretation of the report

The comparison report says the main weakness is not the search decision itself, but the answer step. That is the crucial design signal. The system can already find the right page often, yet it still gives wrong answers when multiple documents disagree.

This means the solution is not to “make the search smarter” alone. The solution is to add an explicit authority layer that declares which source wins before the answer synthesis step begins.

That is exactly what OKF provides.

## Recommended design outcome for this project

The best upgrade path is:

1. keep all existing D1 logic and project search logic intact
2. add a lightweight OKF selector before final answer generation
3. store canonical docs as structured Markdown bundles
4. route official facts to OKF immediately
5. use RAG only when the question is exploratory or historical
6. when both are present, merge them with a precedence resolver and explicit evidence labeling

This keeps the current method safe while giving it a deterministic truth layer.

## References

### Research and architecture sources

- Gao et al., "Retrieval-Augmented Generation for Large Language Models: A Survey" (arXiv:2312.10997)
- The OKF article referenced by the user: "OKF + RAG: The Ultimate AI Agent Architecture" by Ravish Khullar
- Project documentation reviewed in this repo: [copilot_current_status.md](copilot_current_status.md), [copilot_implementation_brief.md](copilot_implementation_brief.md), [docs/copilot/RAG_PLAN.md](docs/copilot/RAG_PLAN.md), [docs/copilot/DECISION_MODEL_DESIGN.md](docs/copilot/DECISION_MODEL_DESIGN.md), [docs/copilot/IMPLEMENTATION_PLAN.md](docs/copilot/IMPLEMENTATION_PLAN.md), [docs/copilot/V2_PLAN.md](docs/copilot/V2_PLAN.md), [docs/copilot/phase0b-report.md](docs/copilot/phase0b-report.md)

### External reference URLs

- https://medium.com/@ravishkhullar/okf-rag-the-ultimate-ai-agent-architecture-26b9ceed44f1
- https://arxiv.org/abs/2312.10997

## Final recommendation

The correct upgrade is not “replace RAG with OKF” and not “throw away the current decider.” The right move is:

- keep the current live-meeting decider and retrieval system
- add OKF as a canonical-source memory layer
- route authoritative questions to OKF and exploratory ones to RAG
- merge both with explicit source precedence and evidence labeling

That design directly addresses the gap identified in the comparison report and matches the architecture principles from the OKF and RAG literature.
