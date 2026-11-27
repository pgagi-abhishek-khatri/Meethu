import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  Code2,
  Copy,
  Download,
  Eye,
  FileText,
  FolderOpen,
  Loader2,
  RotateCcw,
  X,
} from "../icons";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/dialog";
import { useToast } from "../ui/useToast";
import { cn } from "../lib/utils";
import { PaneHeader, Block } from "./CopilotPane";
import type { LocalCodeRepo, SingleCodeContextResult, SummaryBundleResult } from "./copilotApi";

const SECTION_TABS: { key: string; label: string }[] = [
  { key: "00_index.md", label: "Layer A Index" },
  { key: "10_features.md", label: "Features" },
  { key: "20_contracts.md", label: "Contracts" },
  { key: "30_files.md", label: "Files" },
  { key: "40_symbols.md", label: "Symbols" },
  { key: "50_docs.md", label: "Docs" },
  { key: "60_config.md", label: "Config" },
  { key: "70_data.md", label: "Data" },
  { key: "90_coverage.md", label: "Coverage" },
  { key: "__full__", label: "Full .md" },
];

function formatSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function CopyButton({ text, label = "Copy .md" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Button size="sm" variant="outline" className="h-7 gap-1.5 px-2.5 text-xs" onClick={handleCopy}>
      {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
      {copied ? "Copied" : label}
    </Button>
  );
}

function SingleContextPreviewModal({
  contextFile,
  summaryBundle,
  onClose,
  onDownload,
  onExportFolder,
  downloading,
  exporting,
}: {
  contextFile: SingleCodeContextResult | null;
  summaryBundle?: SummaryBundleResult | null;
  onClose: () => void;
  onDownload: () => void;
  onExportFolder?: () => void;
  downloading: boolean;
  exporting?: boolean;
}) {
  const [activeTab, setActiveTab] = useState<string>("00_index.md");

  useEffect(() => {
    if (!contextFile) return;
    setActiveTab(summaryBundle?.files?.["00_index.md"] ? "00_index.md" : "__full__");
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [contextFile, summaryBundle, onClose]);

  if (!contextFile || !contextFile.markdown) return null;

  const hasBundle = Boolean(summaryBundle?.ok && summaryBundle.files);
  const activeText =
    activeTab !== "__full__" && hasBundle && summaryBundle?.files?.[activeTab]
      ? summaryBundle.files[activeTab]
      : contextFile.markdown;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={contextFile.fileName || "Repository Context"}
        onClick={(e) => e.stopPropagation()}
        className="flex h-[90vh] w-[92vw] max-w-6xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl dark:border-white/15 dark:bg-[#141720]"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-2.5 dark:border-white/10">
          <div className="flex min-w-0 items-center gap-2">
            <FileText size={15} className="shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-medium text-foreground">
              {contextFile.fileName || "context.md"}
            </span>
            {contextFile.metrics && (
              <span className="shrink-0 rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success">
                {formatSize(contextFile.metrics.markdownChars)} · {contextFile.metrics.includedModules}{" "}
                modules · {contextFile.metrics.compressionPct}% smaller
              </span>
            )}
            {summaryBundle?.layerATokens != null && (
              <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                Layer A: ~{summaryBundle.layerATokens.toLocaleString()} tokens
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <CopyButton text={activeText} />
            {onExportFolder && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1.5 px-2.5 text-xs"
                disabled={exporting}
                onClick={onExportFolder}
              >
                {exporting ? <Loader2 size={13} className="animate-spin" /> : <FolderOpen size={13} />}
                Export folder
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 px-2.5 text-xs"
              disabled={downloading}
              onClick={onDownload}
            >
              {downloading ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
              Download .md
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              title="Close preview"
              onClick={onClose}
            >
              <X size={14} />
            </Button>
          </div>
        </div>
        {hasBundle && (
          <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/50 px-4 py-1.5 dark:border-white/10">
            {SECTION_TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setActiveTab(t.key)}
                className={cn(
                  "shrink-0 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                  activeTab === t.key
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
        <div className="flex min-h-0 flex-1 flex-col overflow-auto p-4">
          <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground/90">
            {activeText}
          </pre>
        </div>
      </div>
    </div>
  );
}

function RepoFileRow({
  repo,
  contextFile,
  contextError,
  loadingContext,
  refreshing,
  downloading,
  onPreview,
  onDownload,
  onRefresh,
  onRemove,
}: {
  repo: LocalCodeRepo;
  contextFile?: SingleCodeContextResult | null;
  contextError?: string | null;
  loadingContext: boolean;
  refreshing: boolean;
  downloading: boolean;
  onPreview: () => void;
  onDownload: () => void;
  onRefresh: () => void;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const fileName = contextFile?.fileName || `${repo.name}-context.md`;
  const modulesCount = contextFile?.metrics?.includedModules ?? repo.stats?.codeModules ?? 0;
  const branch = contextFile?.activeBranch || repo.activeBranch;
  const metaParts = [
    formatSize(contextFile?.metrics?.markdownChars),
    modulesCount ? `${modulesCount} modules` : null,
    branch ? `branch: ${branch}` : null,
    repo.stats?.truncated ? "partial index: file limit reached" : null,
    repo.stats?.skippedLarge ? `${repo.stats.skippedLarge} large files skipped` : null,
    repo.stats?.secretsRedacted ? `${repo.stats.secretsRedacted} secrets redacted` : null,
  ].filter(Boolean);

  const detail = useMemo(() => {
    if (contextError) return contextError;
    if (contextFile?.summary) {
      return expanded
        ? `${contextFile.summary} Local path: ${repo.path}. Approx. ${contextFile.metrics?.estMarkdownTokens?.toLocaleString() ?? 0} tokens (0 vectors, 0 GitHub API).`
        : contextFile.summary;
    }
    const base = `Single offline Code-to-MD context for ${repo.name}${branch ? ` (${branch})` : ""}${modulesCount ? ` with ${modulesCount} indexed modules` : ""}.`;
    return expanded
      ? `${base} Local path: ${repo.path}. Searched automatically in meetings (0 vectors, 0 GitHub API).`
      : base;
  }, [branch, contextError, contextFile, expanded, modulesCount, repo.name, repo.path]);

  const busy = loadingContext || refreshing;

  return (
    <div className="group flex items-start gap-3 px-3 py-2.5">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-foreground/5 text-foreground/60 dark:bg-white/5">
        <Code2 size={14} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-xs font-medium text-foreground" title={repo.path}>
            {fileName}
          </span>
          {busy ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
              <Loader2 size={11} className="animate-spin" />
              {refreshing ? "Refreshing" : "Preparing"}
            </span>
          ) : contextError ? (
            <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] text-destructive">
              Unavailable
            </span>
          ) : (
            <span className="rounded-full bg-success/10 px-2 py-0.5 text-[11px] text-success">
              Ready
            </span>
          )}
        </div>
        {metaParts.length > 0 && (
          <p className="mt-0.5 text-[11px] text-muted-foreground/80">{metaParts.join(" · ")}</p>
        )}
        <p
          className={cn(
            "mt-0.5 text-[11.5px] leading-relaxed",
            contextError ? "text-destructive/90" : "text-muted-foreground"
          )}
        >
          {detail}
          {!contextError && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="ms-1.5 inline font-medium text-primary hover:underline"
            >
              {expanded ? "less" : "more"}
            </button>
          )}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-70 transition-opacity group-hover:opacity-100">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title="Preview context .md"
          disabled={busy}
          onClick={onPreview}
        >
          {loadingContext ? <Loader2 size={13} className="animate-spin" /> : <Eye size={13} />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title="Download context .md"
          disabled={downloading || refreshing}
          onClick={onDownload}
        >
          {downloading ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title="Rebuild context file"
          disabled={busy}
          onClick={onRefresh}
        >
          <RotateCcw size={13} className={refreshing ? "animate-spin" : ""} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title="Remove repository"
          onClick={onRemove}
        >
          <X size={14} />
        </Button>
      </div>
    </div>
  );
}

/**
 * Fallback builder if running against an older Electron main process without `code-context`.
 */
function buildFallbackContextFromModules(
  repo: LocalCodeRepo,
  mods: { relPath: string; language: string; totalLines: number; markdown: string }[]
): SingleCodeContextResult {
  const fileName = `${repo.name}-context.md`;
  const lines = [
    `# Repository Context: ${repo.name}`,
    repo.activeBranch ? `- **Active Branch**: \`${repo.activeBranch}\`` : "",
    `- **Modules**: ${mods.length}`,
    "",
    ...mods.slice(0, 200).map((m) => `### \`${m.relPath}\`\n${m.markdown}\n`),
  ].filter(Boolean);
  const markdown = lines.join("\n");
  return {
    ok: true,
    fileName,
    activeBranch: repo.activeBranch || undefined,
    summary: `Unified Code-to-MD context for ${repo.name}${repo.activeBranch ? ` (${repo.activeBranch})` : ""} covering ${mods.length} modules.`,
    markdown,
    metrics: {
      repoName: repo.name,
      totalModules: mods.length,
      includedModules: Math.min(mods.length, 200),
      rawCodeChars: markdown.length,
      markdownChars: markdown.length,
      estRawTokens: Math.round(markdown.length / 4),
      estMarkdownTokens: Math.round(markdown.length / 4),
      compressionPct: 0,
      vectorCalls: 0,
      githubApiCalls: 0,
    },
  };
}

export default function CopilotCodePanel({ embedded = false }: { embedded?: boolean }) {
  const api = window.copilot?.code;
  const { toast } = useToast();

  const [repos, setRepos] = useState<LocalCodeRepo[]>([]);
  const [contextMap, setContextMap] = useState<Record<string, SingleCodeContextResult>>({});
  const [bundleMap, setBundleMap] = useState<Record<string, SummaryBundleResult>>({});
  const [errorMap, setErrorMap] = useState<Record<string, string>>({});
  const [loadingPaths, setLoadingPaths] = useState<Record<string, boolean>>({});
  const [refreshingPath, setRefreshingPath] = useState<string | null>(null);
  const [downloadingPath, setDownloadingPath] = useState<string | null>(null);
  const [exportingPath, setExportingPath] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [previewRepoPath, setPreviewRepoPath] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<LocalCodeRepo | null>(null);

  const fetchContextForRepo = useCallback(
    async (repo: LocalCodeRepo): Promise<SingleCodeContextResult | null> => {
      if (!api) return null;
      setLoadingPaths((prev) => ({ ...prev, [repo.path]: true }));
      setErrorMap((prev) => {
        if (!(repo.path in prev)) return prev;
        const next = { ...prev };
        delete next[repo.path];
        return next;
      });
      let lastError: string | null = null;
      try {
        try {
          if (typeof api.getContextFile === "function") {
            const res = await api.getContextFile(repo.path);
            if (res?.ok) {
              setContextMap((prev) => ({ ...prev, [repo.path]: res }));
              return res;
            }
            if (res?.error) lastError = res.error;
          }
        } catch (err) {
          lastError = err instanceof Error ? err.message : null;
          // Fallback when running against a dev Electron main before restart
        }
        try {
          if (typeof api.modules === "function") {
            const modRes = await api.modules(repo.path);
            if (modRes?.ok && modRes.modules) {
              const fallback = buildFallbackContextFromModules(repo, modRes.modules);
              setContextMap((prev) => ({ ...prev, [repo.path]: fallback }));
              return fallback;
            }
          }
        } catch (err) {
          lastError = lastError || (err instanceof Error ? err.message : null);
        }
        setErrorMap((prev) => ({
          ...prev,
          [repo.path]: lastError || "Could not load repository context from disk.",
        }));
        return null;
      } finally {
        setLoadingPaths((prev) => ({ ...prev, [repo.path]: false }));
      }
    },
    [api]
  );

  const loadRepos = useCallback(async () => {
    if (!api) return;
    try {
      const list = await api.listRepos();
      setRepos(list);
      await Promise.all(list.map((r) => fetchContextForRepo(r)));
    } catch (err) {
      toast({
        title: "Could not load repositories",
        description: err instanceof Error ? err.message : "Failed to list local repositories.",
        variant: "destructive",
      });
    }
  }, [api, fetchContextForRepo, toast]);

  useEffect(() => {
    void loadRepos();
  }, [loadRepos]);

  const handlePickRepo = async () => {
    if (!api) return;
    setPicking(true);
    try {
      const res = await api.pickRepo();
      if (res.canceled) return;
      if (!res.ok || !res.repo) {
        toast({
          title: "Could not add repository",
          description: res.error || "Select a valid local directory.",
          variant: "destructive",
        });
        return;
      }
      await loadRepos();
      toast({
        title: "Repository ready",
        description: `${res.repo.name}-context.md built offline (${res.repo.stats?.codeModules ?? 0} modules).`,
      });
    } catch (err) {
      toast({
        title: "Could not add repository",
        description: err instanceof Error ? err.message : "Failed to index selected folder.",
        variant: "destructive",
      });
    } finally {
      setPicking(false);
    }
  };

  const handleRefreshRepo = async (repo: LocalCodeRepo) => {
    if (!api) return;
    setRefreshingPath(repo.path);
    try {
      const res = await api.refreshRepo(repo.path);
      if (!res?.ok) {
        toast({
          title: "Could not rebuild repository",
          description: res?.error || "Repository folder not found on disk.",
          variant: "destructive",
        });
        return;
      }
      const nextRepo = res.repo ?? repo;
      if (res.repo) {
        setRepos((prev) =>
          prev.map((item) => (item.id === nextRepo.id || item.path === repo.path ? nextRepo : item))
        );
      }
      await fetchContextForRepo(nextRepo);
      toast({
        title: "Repository updated",
        description: `${nextRepo.name}-context.md rebuilt from local disk.`,
      });
    } catch (err) {
      toast({
        title: "Could not rebuild repository",
        description: err instanceof Error ? err.message : "Failed to rebuild context file.",
        variant: "destructive",
      });
    } finally {
      setRefreshingPath(null);
    }
  };

  const handlePreviewRepo = async (repo: LocalCodeRepo) => {
    if (typeof api?.getSummaryBundle === "function" && !bundleMap[repo.path]) {
      void api.getSummaryBundle(repo.path).then((b) => {
        if (b?.ok) setBundleMap((prev) => ({ ...prev, [repo.path]: b }));
      }).catch(() => {});
    }
    if (contextMap[repo.path]?.markdown) {
      setPreviewRepoPath(repo.path);
      return;
    }
    const fetched = await fetchContextForRepo(repo);
    if (fetched?.markdown) {
      setPreviewRepoPath(repo.path);
    } else {
      toast({
        title: "Could not load preview",
        description: "Try restarting the app or clicking refresh.",
        variant: "destructive",
      });
    }
  };

  const handleExportFolder = async (repo: LocalCodeRepo) => {
    if (!api?.exportSummaryBundle) return;
    setExportingPath(repo.path);
    try {
      const res = await api.exportSummaryBundle(repo.path);
      if (res?.canceled) return;
      if (res?.ok && res.path) {
        toast({ title: "Exported tiered summary", description: res.path });
      } else {
        toast({
          title: "Could not export summary",
          description: res?.error || "Export failed.",
          variant: "destructive",
        });
      }
    } finally {
      setExportingPath(null);
    }
  };

  const handleDownloadRepo = async (repo: LocalCodeRepo) => {
    if (!api) return;
    setDownloadingPath(repo.path);
    try {
      if (typeof api.downloadContextFile === "function") {
        try {
          const res = await api.downloadContextFile(repo.path);
          if (res?.ok && res.path) {
            toast({ title: "Saved context file", description: res.path });
            return;
          }
          if (res?.canceled) return;
        } catch {
          // Fall through to Blob download when old main doesn't expose code-context-download
        }
      }
      const ctx = contextMap[repo.path] ?? (await fetchContextForRepo(repo));
      if (ctx?.markdown) {
        const blob = new Blob([ctx.markdown], { type: "text/markdown;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = ctx.fileName || `${repo.name}-context.md`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } finally {
      setDownloadingPath(null);
    }
  };

  if (!api) {
    return (
      <div className="space-y-4">
        <PaneHeader
          title="Repositories"
          description="Connect a local codebase folder for offline meeting context."
        />
        <p className="text-sm text-muted-foreground">
          Local repository bridge is unavailable in this environment.
        </p>
      </div>
    );
  }

  const readyCount = repos.filter(
    (r) => !loadingPaths[r.path] && refreshingPath !== r.path && !errorMap[r.path]
  ).length;
  const description = repos.length
    ? `${readyCount} of ${repos.length} ready. Searched automatically when a meeting needs your codebase.`
    : "Connect a local codebase folder so meetings search your code offline (0 vectors, 0 GitHub API).";

  const content = (
    <div className="overflow-hidden rounded-lg border border-border/70 bg-card/50 dark:border-border-subtle dark:bg-surface-2/50">
      {repos.length > 0 && (
        <div className="divide-y divide-border/60 dark:divide-border-subtle/50">
          {repos.map((repo) => (
            <RepoFileRow
              key={repo.id}
              repo={repo}
              contextFile={contextMap[repo.path]}
              contextError={errorMap[repo.path]}
              loadingContext={Boolean(loadingPaths[repo.path])}
              refreshing={refreshingPath === repo.path}
              downloading={downloadingPath === repo.path}
              onPreview={() => void handlePreviewRepo(repo)}
              onDownload={() => void handleDownloadRepo(repo)}
              onRefresh={() => void handleRefreshRepo(repo)}
              onRemove={() => setConfirmRemove(repo)}
            />
          ))}
        </div>
      )}
      <button
        type="button"
        disabled={picking}
        onClick={() => void handlePickRepo()}
        className={cn(
          "flex w-full items-center justify-center gap-2 px-3 text-xs text-muted-foreground transition-colors hover:bg-foreground/3 hover:text-foreground disabled:opacity-60 dark:hover:bg-white/3",
          repos.length
            ? "border-t border-border/60 py-2.5 dark:border-border-subtle/50"
            : "py-8"
        )}
      >
        {picking ? (
          <Loader2 size={repos.length ? 14 : 18} className="animate-spin" />
        ) : (
          <FolderOpen size={repos.length ? 14 : 18} />
        )}
        Connect repository folder
        {!repos.length && (
          <span className="text-muted-foreground/60">
            · compiles a single offline Code-to-MD context file
          </span>
        )}
      </button>
    </div>
  );

  return (
    <div className="space-y-4">
      {embedded ? (
        <Block title="Repositories" description={description}>
          {content}
        </Block>
      ) : (
        <div className="space-y-4">
          <PaneHeader title="Local Code Repositories" description={description} />
          {content}
        </div>
      )}

      <ConfirmDialog
        open={confirmRemove !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmRemove(null);
        }}
        title={confirmRemove ? `Remove "${confirmRemove.name}-context.md"?` : ""}
        description="This removes the repository from Copilot's local code context. Your files on disk are not touched."
        confirmText="Remove"
        variant="destructive"
        onConfirm={() => {
          if (!confirmRemove || !api) return;
          const targetId = confirmRemove.id;
          const targetPath = confirmRemove.path;
          setConfirmRemove(null);
          void api
            .removeRepo(targetId)
            .then(() => {
              setContextMap((prev) => {
                const next = { ...prev };
                delete next[targetPath];
                return next;
              });
              setErrorMap((prev) => {
                const next = { ...prev };
                delete next[targetPath];
                return next;
              });
              return loadRepos();
            })
            .catch((err) => {
              toast({
                title: "Could not remove repository",
                description: err instanceof Error ? err.message : "Failed to remove repository.",
                variant: "destructive",
              });
            });
        }}
      />

      <SingleContextPreviewModal
        contextFile={previewRepoPath ? contextMap[previewRepoPath] ?? null : null}
        summaryBundle={previewRepoPath ? bundleMap[previewRepoPath] ?? null : null}
        onClose={() => setPreviewRepoPath(null)}
        onDownload={() => {
          const target = repos.find((r) => r.path === previewRepoPath);
          if (target) void handleDownloadRepo(target);
        }}
        onExportFolder={
          api?.exportSummaryBundle
            ? () => {
                const target = repos.find((r) => r.path === previewRepoPath);
                if (target) void handleExportFolder(target);
              }
            : undefined
        }
        downloading={previewRepoPath !== null && downloadingPath === previewRepoPath}
        exporting={previewRepoPath !== null && exportingPath === previewRepoPath}
      />
    </div>
  );
}
