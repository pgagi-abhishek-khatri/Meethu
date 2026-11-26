// src/copilot/core/okf/gitRegistry.js
// Deterministic In-Memory Local Git Registry for OKF (Official Knowledge Framework).
// Strictly offline local disk .git inspection: zero GitHub API calls, zero vector embeddings.
// Sub-2ms execution, 0 LLM token cost, zero-throw policy.

const gitLocalAdapter = require("../../../helpers/connectors/gitLocalAdapter");

class GitRegistry {
  constructor({ cwd = process.cwd(), localAdapter = gitLocalAdapter } = {}) {
    this.cwd = cwd;
    this.adapter = localAdapter;
    this.branches = new Map();
    this.commits = new Map();
    this.activeBranch = null;
    this.lastSyncedAt = null;

    this.syncFromLocal();
  }

  /**
   * Synchronizes with local .git directory state (zero network access).
   */
  syncFromLocal() {
    try {
      this.branches.clear();
      this.commits.clear();
      this.activeBranch = this.adapter.getCurrentBranch({ cwd: this.cwd });

      const localBranches = this.adapter.listLocalBranches({ cwd: this.cwd });
      for (const b of localBranches) {
        this.branches.set(b.name, {
          name: b.name,
          sha: b.sha,
          upstream: b.upstream,
          lastCommitSubject: b.lastCommitSubject,
          isCurrent: b.isCurrent,
          source: "local_git",
          authority: 0.95,
          syncedAt: Date.now(),
        });
      }

      const recentCommits = this.adapter.getGitLog({ count: 30 }, { cwd: this.cwd });
      for (const c of recentCommits) {
        this.commits.set(c.sha, { ...c, source: "local_git", authority: 0.95 });
        this.commits.set(c.fullSha, { ...c, source: "local_git", authority: 0.95 });
      }

      this.lastSyncedAt = Date.now();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Vectorless lexical search over local commit history.
   */
  searchCommits(query, { count = 80 } = {}) {
    return this.adapter.searchCommits(query, { cwd: this.cwd, count });
  }

  /**
   * Deterministic entity lookup (< 2ms).
   */
  lookup(query) {
    const q = String(query || "").trim();
    const qLower = q.toLowerCase();

    // 1. Current / Active Branch inquiry
    if (
      /\b(?:current|active|present)\s+branch\b/i.test(qLower) ||
      /\b(?:which|what)\s+branch\s+(?:are\s+we\s+on|is\s+(?:checked\s+out|this|active|current))\b/i.test(qLower) ||
      qLower === "branch" ||
      qLower === "git branch"
    ) {
      return {
        matched: true,
        type: "active_branch",
        id: `branch:${this.activeBranch}`,
        data: {
          activeBranch: this.activeBranch,
          details: this.branches.get(this.activeBranch) || null,
          allBranchesCount: this.branches.size,
        },
        authority: 0.95,
        confidence: 1.0,
      };
    }

    // 2. Explicit branch reference: "branch:<name>" or exact branch name
    const branchPrefix = /^branch:([a-z0-9_\-\.\/]+)$/i.exec(q);
    const targetBranch = branchPrefix ? branchPrefix[1] : this.branches.has(q) ? q : null;
    if (targetBranch && this.branches.has(targetBranch)) {
      return {
        matched: true,
        type: "branch",
        id: `branch:${targetBranch}`,
        data: this.branches.get(targetBranch),
        authority: 0.95,
        confidence: 1.0,
      };
    }

    // 3. Commit SHA reference: "commit:abc1234" or 7-40 hex chars
    const commitMatch = /(?:commit:|\b)([0-9a-f]{7,40})\b/i.exec(qLower);
    if (commitMatch) {
      const sha = commitMatch[1];
      // Keyed by the short and the full hash; any other 7-40 character prefix of a known full hash also counts.
      let known = this.commits.get(sha);
      if (!known) {
        for (const c of this.commits.values()) {
          if (c.fullSha && c.fullSha.startsWith(sha)) {
            known = c;
            break;
          }
        }
      }
      if (known) {
        return {
          matched: true,
          type: "commit",
          id: `commit:${sha}`,
          data: known,
          authority: 0.95,
          confidence: 1.0,
        };
      }
    }

    return { matched: false };
  }
}

const registryCache = new Map();

function getGitRegistry(cwd = process.cwd(), { refresh = false } = {}) {
  const key = String(cwd || process.cwd());
  if (refresh) registryCache.delete(key);
  if (!registryCache.has(key)) {
    registryCache.set(key, new GitRegistry({ cwd: key }));
  }
  return registryCache.get(key);
}

module.exports = {
  GitRegistry,
  getGitRegistry,
};
