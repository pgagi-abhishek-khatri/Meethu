# GitHub Copilot Custom Instructions — OpenWhispr / Meethu

These instructions govern all GitHub Copilot interactions across this repository.

## 1. Single Source of Truth: The OKF Bundle Registry

The canonical, authoritative source of truth for the architecture, contracts, policies, and specifications of this repository is located in the dedicated **OKF (Official Knowledge Framework)** bundle:

- **Registry Manifest**: `OKF/manifest.yaml`
- **Canonical Documents**: `OKF/documents/` (e.g., `OKF-0001`, `OKF-0002`)
- **Bundle ID**: `openwhispr-canonical-v1`
- **Owner**: `pgagi-abhishek-khatri`
- **Status**: `approved`
- **Version**: `1.0.0`

## 2. Precedence and Source Authority Rules

When answering architectural questions, generating code, reviewing PRs, or resolving conflicting technical assertions:

1. **Canonical Overrides Exploratory**:
   Documents in `OKF/documents/` with `status: approved` strictly override informal notes, issue discussions, exploratory design drafts, and historical proposals in `docs/` or root markdown files.
2. **As-Built Overrides Proposal**:
   As-built specification records override preliminary design proposals (e.g. implementation documents override initial proposals).
3. **Semantic Version Precedence**:
   Within canonical documents, higher semantic version numbers (`1.1.0` > `1.0.0`) override older versions.
4. **Superseded Routing**:
   If a document has `status: superseded`, immediately follow its `superseded_by` pointer to the authoritative replacement document.
5. **Supporting Documents Are Context Only**:
   Materials in `OKF/supporting/` or exploratory benchmark logs provide background rationale and experimental observations, but do **not** carry canonical authority.

## 3. Core Project Conventions & Architectural Invariants

- **Desktop Framework**: Electron 41 with context isolation.
- **Node Runtime**: Node 24 (pinned in `.nvmrc`). Do not regenerate `package-lock.json` with a different major version.
- **Frontend**: React 19, Tailwind CSS v4, Vite, shadcn/ui.
- **Process Separation**:
  - Main Process: Electron entry, IPC handlers, database operations (`main.js`).
  - Preload Script: Context-isolated bridge (`preload.js`).
  - Renderer Process: React application (`src/`).
  - ONNX Utility Process: Hosts all onnxruntime-node inference (`src/workers/onnxWorker.js`).
- **Database Isolation**:
  - Live Meeting Copilot uses its own SQLite file at `userData/copilot.db` (`better-sqlite3`). It never touches the main application note database (`userData/app.db`).
- **Validation**:
  - All OKF canonical documentation must pass automated validation: `npm run validate:okf`.
