// Boundary-aware filesystem walker for single repos, nested independent repos, submodules,
// worktrees, monorepo workspaces, and non-git folders. Accounts for 100% of files encountered.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { classifySpecialFile, isSecretFilePath } = require("./specialFiles");
const { sanitizeRemoteUrl } = require("./secretScan");

const DEFAULT_IGNORE_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".venv",
  "venv",
  "node_modules",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".vercel",
  ".cache",
  "Pods",
  ".expo",
  ".gradle",
  "target",
  "out",
  "copilot-logs",
  ".superpowers",
]);

const CORE_PRIORITY_DIRS = new Set([
  "src", "app", "apps", "packages", "core", "server", "backend", "api",
  "services", "helpers", "lib", "copilot", "main", "components", "rag", "okf",
]);
const LOW_PRIORITY_DIRS = new Set([
  "scripts", "test", "tests", "__tests__", "docs", "examples", "alembic",
  "migrations", "locales", "i18n", "openwhispr-mobile", "android", "ios",
]);

function dirPriorityTier(name, parentTier = 1) {
  const low = String(name || "").toLowerCase();
  if (LOW_PRIORITY_DIRS.has(low)) return 2;
  if (parentTier >= 2) return 2;
  if (CORE_PRIORITY_DIRS.has(low)) return 0;
  return parentTier === 0 ? 0 : 1;
}

function gitSync(cwd, args, timeoutMs = 4000) {
  try {
    return execFileSync("git", args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function globToRegex(pattern) {
  let p = String(pattern || "").trim();
  if (!p) return null;
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.slice(0, -1);
  const anchored = p.startsWith("/");
  if (anchored) p = p.slice(1);

  let regexStr = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === "*") {
      if (p[i + 1] === "*") {
        if (p[i + 2] === "/") {
          regexStr += "(?:.+/)?";
          i += 2;
        } else {
          regexStr += ".*";
          i += 1;
        }
      } else {
        regexStr += "[^/]*";
      }
    } else if (ch === "?") {
      regexStr += "[^/]";
    } else if (".+^${}()|[]\\".includes(ch)) {
      regexStr += `\\${ch}`;
    } else {
      regexStr += ch;
    }
  }

  const hasSlash = p.includes("/");
  const prefix = anchored || hasSlash ? "^" : "(?:^|/)";
  const suffix = dirOnly ? "(?:/|$)" : "(?:$|/)";
  try {
    return { re: new RegExp(`${prefix}${regexStr}${suffix}`), dirOnly };
  } catch {
    return null;
  }
}

function parseIgnoreFile(content, baseRelDir = "") {
  const rules = [];
  for (const rawLine of String(content || "").split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith("#")) continue;
    let negated = false;
    let pat = line;
    if (pat.startsWith("\\#") || pat.startsWith("\\!")) {
      pat = pat.slice(1);
    } else if (pat.startsWith("!")) {
      negated = true;
      pat = pat.slice(1);
    }
    const compiled = globToRegex(pat);
    if (!compiled) continue;
    rules.push({
      raw: rawLine.trim(),
      baseRelDir,
      negated,
      dirOnly: compiled.dirOnly,
      re: compiled.re,
    });
  }
  return rules;
}

function isIgnoredByRules(relFromComponent, isDir, ruleStack, includeRules = []) {
  const norm = relFromComponent.replace(/\\/g, "/");
  // Config include overrides ignore rules
  for (const inc of includeRules) {
    if (inc.re.test(norm)) return { ignored: false, matchedRule: null };
  }
  let ignored = false;
  let matchedRule = null;
  for (const r of ruleStack) {
    let target = norm;
    if (r.baseRelDir) {
      if (!norm.startsWith(`${r.baseRelDir}/`) && norm !== r.baseRelDir) continue;
      target = norm.slice(r.baseRelDir.length + 1);
    }
    if (!target) continue;
    if (r.dirOnly && !isDir && !target.includes("/")) continue;
    if (r.re.test(target)) {
      ignored = !r.negated;
      matchedRule = r.negated ? null : r.raw;
    }
  }
  return { ignored, matchedRule };
}

function parseGitmodules(repoRoot) {
  const gmPath = path.join(repoRoot, ".gitmodules");
  if (!fs.existsSync(gmPath)) return [];
  try {
    const text = fs.readFileSync(gmPath, "utf8");
    const modules = [];
    let cur = null;
    for (const line of text.split(/\r?\n/)) {
      const sec = /^\[submodule\s+"([^"]+)"\]/.exec(line.trim());
      if (sec) {
        cur = { name: sec[1], path: "", url: "" };
        modules.push(cur);
        continue;
      }
      if (!cur) continue;
      const kv = /^(\w+)\s*=\s*(.+)$/.exec(line.trim());
      if (kv) {
        if (kv[1] === "path") cur.path = kv[2].trim();
        else if (kv[1] === "url") cur.url = sanitizeRemoteUrl(kv[2].trim());
      }
    }
    return modules.filter((m) => m.path).map((m) => {
      const subDir = path.join(repoRoot, m.path);
      const initialized = fs.existsSync(path.join(subDir, ".git"));
      const pinnedSha = gitSync(repoRoot, ["ls-tree", "HEAD", m.path])?.split(/\s+/)?.[2] || null;
      const checkedOutSha = initialized ? gitSync(subDir, ["rev-parse", "--short", "HEAD"]) : null;
      return { ...m, initialized, pinnedSha: pinnedSha?.slice(0, 8) || null, checkedOutSha };
    });
  } catch {
    return [];
  }
}

function expandUntrackedDir(baseDir, relDir, outSet, cap = 500) {
  const stack = [path.join(baseDir, relDir)];
  let added = 0;
  while (stack.length > 0 && added < cap) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (ent.isSymbolicLink() || DEFAULT_IGNORE_DIRS.has(ent.name)) continue;
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else {
        outSet.add(path.relative(baseDir, full).replace(/\\/g, "/"));
        if (++added >= cap) break;
      }
    }
  }
}

function collectGitMetadata(dir) {
  let gitRoot = dir;
  let gitMarker = path.join(dir, ".git");
  let isInheritedAncestor = false;
  if (!fs.existsSync(gitMarker)) {
    const top = gitSync(dir, ["rev-parse", "--show-toplevel"]);
    if (!top || !fs.existsSync(path.join(top, ".git"))) {
      return {
        vcs: "none",
        branch: null,
        revision: null,
        dirtyFiles: new Set(),
        fileLastRev: new Map(),
        isShallow: false,
        isWorktree: false,
        remoteUrl: "",
        submodules: [],
      };
    }
    gitRoot = path.resolve(top);
    gitMarker = path.join(gitRoot, ".git");
    isInheritedAncestor = true;
  }

  let isWorktree = false;
  let realGitDir = gitMarker;
  try {
    const st = fs.lstatSync(gitMarker);
    if (st.isFile()) {
      isWorktree = true;
      const ptr = fs.readFileSync(gitMarker, "utf8").trim();
      const m = /^gitdir:\s*(.+)$/i.exec(ptr);
      if (m) realGitDir = path.resolve(gitRoot, m[1].trim());
    }
  } catch {}

  const branch = gitSync(gitRoot, ["rev-parse", "--abbrev-ref", "HEAD"]) || "HEAD";
  const revision = gitSync(gitRoot, ["rev-parse", "--short", "HEAD"]);
  const isShallow = gitSync(gitRoot, ["rev-parse", "--is-shallow-repository"]) === "true";
  const remoteUrl = sanitizeRemoteUrl(gitSync(gitRoot, ["remote", "get-url", "origin"]) || "");

  const remapRel = (repoRelPath) => {
    if (!isInheritedAncestor) return repoRelPath;
    const rel = path.relative(dir, path.join(gitRoot, repoRelPath)).replace(/\\/g, "/");
    return rel && !rel.startsWith("..") ? rel : null;
  };

  // Parse NUL-delimited porcelain status cleanly (handles renames/copies and untracked folders)
  const dirtyRaw = gitSync(gitRoot, ["status", "--porcelain=v1", "-z"]) || "";
  const rawTokens = dirtyRaw.split("\0");
  const dirtyFiles = new Set();
  for (let i = 0; i < rawTokens.length; i++) {
    const entry = rawTokens[i];
    if (!entry || entry.length < 4) continue;
    const statusCode = entry.slice(0, 2);
    const p = entry.slice(3).replace(/\\/g, "/");
    if (statusCode[0] === "R" || statusCode[0] === "C") {
      i += 1; // skip old path token in -z format
    }
    if (p.endsWith("/")) {
      const subRel = remapRel(p.slice(0, -1));
      if (subRel !== null) expandUntrackedDir(dir, subRel, dirtyFiles);
    } else {
      const mapped = remapRel(p);
      if (mapped) dirtyFiles.add(mapped);
    }
  }

  // Per-file last-changed commit revision & churn count (single deep git log pass)
  const fileLastRev = new Map();
  const fileCommitCount = new Map();
  const revLog = gitSync(gitRoot, ["log", "-n", "3000", "--format=@@REV@@%h", "--name-only", "--"], 8000) || "";
  let curSha = null;
  for (const rawLine of revLog.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("@@REV@@")) {
      curSha = line.slice(7).trim();
    } else if (curSha) {
      const mapped = remapRel(line.replace(/\\/g, "/"));
      if (mapped) {
        if (!fileLastRev.has(mapped)) fileLastRev.set(mapped, curSha);
        fileCommitCount.set(mapped, (fileCommitCount.get(mapped) || 0) + 1);
      }
    }
  }

  const submodules = parseGitmodules(gitRoot);
  return {
    vcs: "git",
    branch,
    revision,
    dirtyFiles,
    fileLastRev,
    fileCommitCount,
    isShallow,
    isWorktree,
    isInheritedAncestor,
    realGitDir,
    remoteUrl,
    submodules,
  };
}

function detectWorkspacePackages(rootDir) {
  const packages = [];
  const addPkg = (pkgDir, name, ecosystem) => {
    const rel = path.relative(rootDir, pkgDir).replace(/\\/g, "/") || ".";
    packages.push({ relDir: rel, absDir: pkgDir, name: name || path.basename(pkgDir), ecosystem });
  };

  // 1. package.json workspaces
  const pkgJsonPath = path.join(rootDir, "package.json");
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
      const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
      if (Array.isArray(ws)) {
        for (const pattern of ws) expandWorkspaceGlob(rootDir, pattern, "node", addPkg);
      }
    } catch {}
  }

  // 2. pnpm-workspace.yaml
  const pnpmWs = path.join(rootDir, "pnpm-workspace.yaml");
  if (fs.existsSync(pnpmWs)) {
    try {
      const lines = fs.readFileSync(pnpmWs, "utf8").split(/\r?\n/);
      for (const l of lines) {
        const m = /^\s*-\s*['"]?([^'"#\s]+)['"]?/.exec(l);
        if (m) expandWorkspaceGlob(rootDir, m[1], "pnpm", addPkg);
      }
    } catch {}
  }

  // 3. Cargo.toml [workspace] members
  const cargoToml = path.join(rootDir, "Cargo.toml");
  if (fs.existsSync(cargoToml)) {
    try {
      const text = fs.readFileSync(cargoToml, "utf8");
      const m = /\[workspace\][\s\S]*?members\s*=\s*\[([\s\S]*?)\]/.exec(text);
      if (m) {
        const items = m[1].match(/['"]([^'"]+)['"]/g) || [];
        for (const item of items) expandWorkspaceGlob(rootDir, item.slice(1, -1), "cargo", addPkg);
      }
    } catch {}
  }

  // 4. go.work use (...)
  const goWork = path.join(rootDir, "go.work");
  if (fs.existsSync(goWork)) {
    try {
      const text = fs.readFileSync(goWork, "utf8");
      const dirs = text.match(/^\s*\.\/[^\s)]+/gm) || [];
      for (const d of dirs) {
        const abs = path.resolve(rootDir, d.trim());
        if (fs.existsSync(abs)) addPkg(abs, path.basename(abs), "go");
      }
    } catch {}
  }

  const dedup = new Map();
  for (const p of packages) dedup.set(p.relDir, p);
  return [...dedup.values()];
}

function expandWorkspaceGlob(rootDir, pattern, ecosystem, addPkg) {
  const clean = String(pattern || "").replace(/\/\*$/, "").replace(/^\.\//, "");
  if (!clean || clean.startsWith("!")) return;
  const target = path.join(rootDir, clean);
  if (pattern.endsWith("/*") || pattern.endsWith("/**")) {
    if (!fs.existsSync(target)) return;
    try {
      for (const ent of fs.readdirSync(target, { withFileTypes: true })) {
        if (ent.isDirectory() && !ent.name.startsWith(".")) {
          addPkg(path.join(target, ent.name), ent.name, ecosystem);
        }
      }
    } catch {}
  } else if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    addPkg(target, path.basename(target), ecosystem);
  }
}

/**
 * Walks `rootDir` (and optional extra roots), detecting nested repos, submodules, worktrees,
 * and workspace packages while respecting per-repo ignore files and accounting for 100% of files.
 */
const IGNORED_DIR_FILE_CAP = 25000;

function countFilesInIgnoredDir(dirPath, cap = IGNORED_DIR_FILE_CAP) {
  let filesCount = 0;
  let dirsCount = 1;
  let capped = false;
  const stack = [dirPath];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        dirsCount += 1;
        if (filesCount < cap) stack.push(path.join(cur, ent.name));
      } else {
        filesCount += 1;
        if (filesCount >= cap) {
          capped = true;
          return { filesCount: cap, dirsCount, capped };
        }
      }
    }
  }
  return { filesCount: Math.max(filesCount, 0), dirsCount, capped };
}

function* discoverRepoSteps(
  rootDir,
  {
    extraRoots = [],
    excludeDirs = DEFAULT_IGNORE_DIRS,
    extraExcludes = [],
    extraIncludes = [],
    extraSecretPatterns = [],
    outputDir = null,
    maxFiles = 5000,
  } = {}
) {
  const absRoot = path.resolve(String(rootDir || ""));
  const absOut = outputDir ? path.resolve(String(outputDir)) : null;
  const roots = [absRoot, ...(Array.isArray(extraRoots) ? extraRoots : []).map((r) => path.resolve(String(r)))].filter((r) =>
    fs.existsSync(r)
  );
  const rawIncludeStrings = (Array.isArray(extraIncludes) ? extraIncludes : []).map((p) => String(p || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, ""));
  const includeRules = rawIncludeStrings.map((p) => globToRegex(p)).filter(Boolean);
  const isExplicitlyIncluded = (relFromRoot, relFromComp, isDir) => {
    for (const inc of includeRules) {
      if (inc.re.test(relFromRoot) || inc.re.test(relFromComp)) return true;
    }
    if (isDir) {
      for (const raw of rawIncludeStrings) {
        if (raw.startsWith(`${relFromRoot}/`) || raw.startsWith(`${relFromComp}/`)) return true;
      }
    }
    return false;
  };
  const globalExcludeRules = (Array.isArray(extraExcludes) ? extraExcludes : []).map((p) => parseIgnoreFile(p)).flat();

  const components = new Map(); // id -> component metadata
  const files = [];
  const coverage = {
    filesFound: 0,
    indexedCandidates: 0,
    skipped: [], // { relPath, reason, kind, componentId }
    ignoredByRule: {}, // rule -> ignored file count (capped at 25000 per dir)
    ignoredMetaByRule: {}, // rule -> { files, dirs, capped }
    failed: [], // { relPath, reason, componentId }
    secretsNotRead: [], // { relPath, componentId }
    outOfRootSymlinks: 0,
    symlinkLoops: 0,
  };

  const seenWorktrees = new Set();
  const seenDirInodes = new Set();

  const absOutRel = absOut && absOut.startsWith(`${absRoot}${path.sep}`)
    ? path.relative(absRoot, absOut).replace(/\\/g, "/")
    : null;

  const registerComponent = (compDir, parentId = null, kind = "repo", customName = null) => {
    const absComp = path.resolve(compDir);
    const relFromRoot = path.relative(absRoot, absComp).replace(/\\/g, "/") || ".";
    const id = relFromRoot === "." ? (path.basename(absComp) || "root") : relFromRoot;
    if (components.has(id)) return components.get(id);
    const gitMeta = collectGitMetadata(absComp);
    if (absOutRel && gitMeta.dirtyFiles?.size) {
      for (const df of [...gitMeta.dirtyFiles]) {
        if (df === absOutRel || df.startsWith(`${absOutRel}/`) || df.startsWith(`${absOutRel}/`.replace(/^\.\//, ""))) {
          gitMeta.dirtyFiles.delete(df);
        }
      }
    }
    const workspaces = detectWorkspacePackages(absComp);
    const comp = {
      id,
      name: customName || path.basename(absComp) || id,
      absDir: absComp,
      relDir: relFromRoot,
      parentId,
      kind,
      workspaces,
      ...gitMeta,
    };
    components.set(id, comp);
    return comp;
  };

  const recordIgnore = (rule, count = 1, dirCount = 0, capped = false) => {
    const k = rule || "default_ignore";
    coverage.ignoredByRule[k] = (coverage.ignoredByRule[k] || 0) + count;
    const meta = coverage.ignoredMetaByRule[k] || { files: 0, dirs: 0, capped: false };
    meta.files += count;
    meta.dirs += dirCount;
    if (capped) meta.capped = true;
    coverage.ignoredMetaByRule[k] = meta;
  };

  for (const r of roots) {
    const rootComp = registerComponent(r, null, "root");
    const queues = [[{ dir: r, component: rootComp, rules: [...globalExcludeRules], tier: 1 }], [], []];

    while (queues[0].length > 0 || queues[1].length > 0 || queues[2].length > 0) {
      const qIdx = queues[0].length > 0 ? 0 : queues[1].length > 0 ? 1 : 2;
      const frame = queues[qIdx].shift();
      const { dir, component, tier: parentTier } = frame;
      let rules = frame.rules;

      if (absOut && (dir === absOut || dir.startsWith(`${absOut}${path.sep}`))) {
        continue;
      }

      // Symlink loop / out-of-root guard
      try {
        const real = fs.realpathSync(dir);
        const st = fs.statSync(real);
        if (real !== absRoot && !real.startsWith(`${absRoot}${path.sep}`) && !roots.some((rt) => real === rt || real.startsWith(`${rt}${path.sep}`))) {
          coverage.outOfRootSymlinks += 1;
          continue;
        }
        const inodeKey = `${st.dev}:${st.ino}`;
        if (seenDirInodes.has(inodeKey)) {
          coverage.symlinkLoops += 1;
          continue;
        }
        seenDirInodes.add(inodeKey);
      } catch {
        continue;
      }

      // Detect nested independent git repo or worktree
      let activeComp = component;
      if (dir !== component.absDir && fs.existsSync(path.join(dir, ".git"))) {
        const subMeta = collectGitMetadata(dir);
        if (subMeta.isWorktree && subMeta.realGitDir && seenWorktrees.has(subMeta.realGitDir)) {
          continue; // skip duplicate worktree pointer
        }
        if (subMeta.realGitDir) seenWorktrees.add(subMeta.realGitDir);
        const isSubmodule = component.submodules?.some(
          (s) => path.resolve(component.absDir, s.path) === path.resolve(dir)
        );
        activeComp = registerComponent(dir, component.id, isSubmodule ? "submodule" : "nested_repo");
        rules = [...globalExcludeRules]; // reset ignore rules at repo boundary
      }

      // Load local ignore files (.gitignore, .ignore, .meethuignore)
      const localRel = path.relative(activeComp.absDir, dir).replace(/\\/g, "/");
      const nextRules = [...rules];
      for (const igName of [".gitignore", ".ignore", ".meethuignore"]) {
        const igPath = path.join(dir, igName);
        if (fs.existsSync(igPath)) {
          try {
            nextRules.push(...parseIgnoreFile(fs.readFileSync(igPath, "utf8"), localRel));
          } catch {}
        }
      }

      yield;
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        coverage.failed.push({ relPath: path.relative(absRoot, dir).replace(/\\/g, "/") || ".", reason: err?.message || "readdir_failed", componentId: activeComp.id });
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));

      const subDirs = [];
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relFromComp = path.relative(activeComp.absDir, fullPath).replace(/\\/g, "/");
        const relFromRoot = path.relative(absRoot, fullPath).replace(/\\/g, "/");

        if (entry.isDirectory() || entry.isSymbolicLink()) {
          let isDir = entry.isDirectory();
          if (entry.isSymbolicLink()) {
            try {
              const real = fs.realpathSync(fullPath);
              if (!real.startsWith(`${absRoot}${path.sep}`) && !roots.some((rt) => real.startsWith(`${rt}${path.sep}`))) {
                coverage.outOfRootSymlinks += 1;
                continue;
              }
              isDir = fs.statSync(real).isDirectory();
            } catch {
              coverage.failed.push({ relPath: relFromRoot, reason: "broken_symlink", componentId: activeComp.id });
              continue;
            }
          }
          if (isDir) {
            const explicitlyIncluded = isExplicitlyIncluded(relFromRoot, relFromComp, true);
            const isHidden = entry.name.startsWith(".") && entry.name !== ".github";
            const ig = isIgnoredByRules(relFromComp, true, nextRules, includeRules);
            const wouldExclude =
              excludeDirs.has(entry.name) ||
              isHidden ||
              (ig.ignored && !fs.existsSync(path.join(fullPath, ".git")));

            if (!explicitlyIncluded && excludeDirs.has(entry.name)) {
              const cnt = countFilesInIgnoredDir(fullPath);
              recordIgnore(`dir:${entry.name}`, cnt.filesCount, cnt.dirsCount, cnt.capped);
              continue;
            }
            if (!explicitlyIncluded && isHidden) {
              const cnt = countFilesInIgnoredDir(fullPath);
              recordIgnore("hidden_dir", cnt.filesCount, cnt.dirsCount, cnt.capped);
              continue;
            }
            if (!explicitlyIncluded && wouldExclude) {
              const cnt = countFilesInIgnoredDir(fullPath);
              recordIgnore(ig.matchedRule, cnt.filesCount, cnt.dirsCount, cnt.capped);
              continue;
            }
            const subTier = dirPriorityTier(entry.name, parentTier);
            subDirs.push({
              dir: fullPath,
              component: activeComp,
              rules: nextRules,
              tier: subTier,
              rescuedByInclude: Boolean(frame.rescuedByInclude || (wouldExclude && explicitlyIncluded)),
            });
            continue;
          }
        }

        // File handling
        if (absOut && (fullPath === absOut || fullPath.startsWith(`${absOut}${path.sep}`))) {
          recordIgnore("generator_output");
          continue;
        }

        // Secret deny-list BEFORE ignore/read checks
        if (isSecretFilePath(relFromRoot, extraSecretPatterns) || isSecretFilePath(relFromComp, extraSecretPatterns)) {
          coverage.filesFound += 1;
          coverage.secretsNotRead.push({ relPath: relFromRoot, componentId: activeComp.id });
          coverage.skipped.push({ relPath: relFromRoot, reason: "secret_denied", kind: "secret", componentId: activeComp.id });
          continue;
        }

        if (frame.rescuedByInclude && !isExplicitlyIncluded(relFromRoot, relFromComp, false)) {
          recordIgnore("excluded_parent_dir");
          continue;
        }

        const ig = isIgnoredByRules(relFromComp, false, nextRules, includeRules);
        if (ig.ignored) {
          recordIgnore(ig.matchedRule);
          continue;
        }
        coverage.filesFound += 1;

        let stat;
        try {
          stat = fs.statSync(fullPath);
        } catch (err) {
          coverage.failed.push({ relPath: relFromRoot, reason: err?.message || "stat_failed", componentId: activeComp.id });
          continue;
        }

        const specialKind = classifySpecialFile(relFromComp, stat.size, { extraSecretPatterns });
        if (files.length >= maxFiles && specialKind !== "lockfile" && specialKind !== "config") {
          coverage.skipped.push({ relPath: relFromRoot, reason: "max_files_cap", kind: specialKind, componentId: activeComp.id });
          continue;
        }

        // Resolve workspace package assignment if inside a monorepo
        let packageId = activeComp.id;
        for (const ws of activeComp.workspaces || []) {
          if (relFromComp === ws.relDir || relFromComp.startsWith(`${ws.relDir}/`)) {
            packageId = `${activeComp.id}:${ws.name}`;
            break;
          }
        }

        coverage.indexedCandidates += 1;
        files.push({
          absPath: fullPath,
          relPath: relFromRoot,
          relFromComp,
          name: entry.name,
          bytes: stat.size,
          mtimeMs: stat.mtimeMs,
          specialKind,
          componentId: activeComp.id,
          packageId,
          dirty: activeComp.dirtyFiles?.has(relFromComp) || false,
        });
      }

      for (const sd of subDirs) {
        queues[sd.tier].push(sd);
      }
    }
  }

  const compList = [...components.values()];
  // Prune parent component dirtyFiles that belong to nested child components or excluded/build dirs (§5.1 #13)
  for (const comp of compList) {
    if (!comp.dirtyFiles || comp.dirtyFiles.size === 0) continue;
    const childPrefixes = compList
      .filter((other) => other.id !== comp.id && other.relDir && other.relDir !== ".")
      .filter((other) => comp.relDir === "." || other.relDir.startsWith(`${comp.relDir}/`))
      .map((other) => `${other.relDir}/`);
    for (const df of [...comp.dirtyFiles]) {
      const cleanDf = String(df || "").replace(/\\/g, "/").replace(/^\.\//, "");
      const inChild = childPrefixes.some((pfx) => cleanDf.startsWith(pfx));
      const inOut = absOutRel && (cleanDf === absOutRel || cleanDf.startsWith(`${absOutRel}/`));
      const firstSeg = cleanDf.split("/")[0];
      const inIgnored = firstSeg && excludeDirs.has(firstSeg);
      if (inChild || inOut || inIgnored) {
        comp.dirtyFiles.delete(df);
      }
    }
  }

  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return {
    absRoot,
    components: compList,
    files,
    coverage,
  };
}

function discoverRepo(rootDir, opts) {
  const gen = discoverRepoSteps(rootDir, opts);
  for (;;) {
    const step = gen.next();
    if (step.done) return step.value;
  }
}

module.exports = {
  DEFAULT_IGNORE_DIRS,
  parseIgnoreFile,
  isIgnoredByRules,
  collectGitMetadata,
  detectWorkspacePackages,
  discoverRepoSteps,
  discoverRepo,
};
