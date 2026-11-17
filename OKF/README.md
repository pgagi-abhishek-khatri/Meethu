# Official Knowledge Framework (OKF) — Canonical Registry

Welcome to the **Official Knowledge Framework (OKF)** directory for the OpenWhispr / Meethu project.

## 1. What is OKF?

As diagnosed in `Two_Approach_comp_report.md` and designed in `rag_OKF.md`, standard RAG relies purely on probabilistic semantic embeddings and lexical search. When project documents disagree (e.g. an initial proposal vs. an as-built implementation document), standard RAG retrieves both, leaving the AI unable to determine which source is authoritative.

OKF resolves this **authority gap** by providing a curated, deterministic, version-controlled source of truth.

## 2. Directory Structure

```
OKF/
├── README.md                          # This architecture and process guide
├── manifest.yaml                      # Central bundle registry and document inventory
├── schemas/                           # Machine-readable JSON Schemas for validation
│   ├── document-metadata.schema.json  # YAML frontmatter schema
│   └── bundle-manifest.schema.json    # Manifest registry schema
├── documents/                         # Canonical, authoritative specifications
│   ├── OKF-0001-template.md           # Template for new canonical documents
│   └── ...                            # Numbered canonical documents (OKF-XXXX)
└── supporting/                        # Supporting materials, research, benchmarks
    └── README.md                      # Guide for non-canonical documentation
```

## 3. Canonical vs. Supporting Documentation

- **Canonical Documents (`OKF/documents/`)**:
  - Contains authoritative project ground truth (as-built architectures, API contracts, policy definitions, official formulas, runbooks).
  - Every document **must** have valid YAML frontmatter matching `OKF/schemas/document-metadata.schema.json`.
  - Must be registered in `OKF/manifest.yaml` with its version, status, and SHA-256 checksum.
  - Carries official precedence over exploratory notes and proposal documents.

- **Supporting Documents (`OKF/supporting/` or `docs/`)**:
  - Meeting notes, research reports, exploratory proposals, benchmark comparisons, design brainstorming.
  - Do not carry authoritative precedence.
  - Cannot override `approved` canonical documents.

## 4. Metadata Schema & Frontmatter Rules

Every canonical document starts with a YAML frontmatter block:

```yaml
---
id: "OKF-0001"
title: "Document Title"
description: "Short summary of the specification scope."
owner: "team-or-handle"
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
```

### Lifecycle Statuses

- `draft`: Under review. Not yet authoritative.
- `approved`: Authoritative canonical ground truth. Overrides all non-canonical documents and older versions.
- `deprecated`: Retained for historical record; no longer recommended.
- `superseded`: Replaced by a newer canonical document. Must specify `superseded_by: "OKF-XXXX"`.

### Tag Taxonomy

Tags must be namespaced using one of the approved prefixes:
- `domain:<subsystem>` (e.g., `domain:copilot`, `domain:transcription`, `domain:rag`, `domain:ui`, `domain:audio`)
- `type:<classification>` (e.g., `type:architecture`, `type:api-contract`, `type:runbook`, `type:metric`, `type:policy`)
- `tier:<criticality>` (e.g., `tier:core`, `tier:integration`, `tier:experimental`)
- `platform:<os>` (e.g., `platform:linux`, `platform:macos`, `platform:windows`, `platform:universal`)

## 5. Precedence Rules

When facts conflict:
1. Canonical documents in `OKF/documents/` with `status: approved` override all exploratory notes, issue summaries, or old proposal documents.
2. As-built documentation overrides preliminary planning documents.
3. Higher semantic version numbers (`1.1.0` > `1.0.0`) override older versions.
4. A document marked `superseded` yields precedence to its `superseded_by` target.
5. If two non-canonical sources conflict, the system surfaces the ambiguity rather than guessing.

## 6. Validation

Run the automated validator to check schema validity, ID uniqueness, semver conformance, and manifest checksum parity:

```bash
npm run validate:okf
```
