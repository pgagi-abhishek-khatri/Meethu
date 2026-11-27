// Extracts data models, SQL tables, ordered migrations (+ multi-head warnings),
// scripts, env var names (never values), feature flags, CI/deploy targets, and component-level dependencies.
const path = require("path");

function extractFileConfigSignals({ relPath, text, specialKind, componentId = "root", lockfileVersions = new Map() } = {}) {
  const res = {
    models: [],
    migrations: [],
    scripts: [],
    envVars: [],
    documentedEnvVars: [],
    featureFlags: [],
    ciJobs: [],
    deployFiles: [],
    declaredDeps: [],
    projectMeta: null,
  };
  if (!text) return res;
  const base = path.basename(relPath).toLowerCase();

  // .env.example / .env.template documents env var names
  if (/^\.env\.(example|sample|template)$/i.test(base)) {
    for (const line of text.split("\n")) {
      const m = /^\s*([A-Z][A-Z0-9_]{1,60})\s*=/.exec(line);
      if (m) res.documentedEnvVars.push(m[1]);
    }
    return res;
  }

  // Migrations
  if (/(?:^|\/)(?:migrations?|alembic\/versions)\//.test(relPath)) {
    const downRev = /down_revision\s*=\s*['"]?([A-Za-z0-9_]+|None)['"]?/i.exec(text)?.[1] || null;
    const rev = /revision\s*=\s*['"]([A-Za-z0-9_]+)['"]/i.exec(text)?.[1] || null;
    res.migrations.push({ relPath, name: path.basename(relPath), rev, downRev });
  }

  // SQL CREATE TABLE
  const sqlTblRe = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([A-Za-z0-9_."`]+)\s*\(([\s\S]*?)\);/gi;
  let m;
  while ((m = sqlTblRe.exec(text)) !== null) {
    const tableName = m[1].replace(/["`]/g, "");
    const cols = m[2]
      .split("\n")
      .map((l) => l.trim().replace(/,$/, ""))
      .filter((l) => l && !/^(?:PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT|--)/i.test(l))
      .slice(0, 12)
      .map((l) => l.split(/\s+/).slice(0, 2).join(" "));
    res.models.push({ name: tableName, kind: "sql_table", file: relPath, line: text.slice(0, m.index).split("\n").length, fields: cols });
  }

  // Prisma models
  if (base.endsWith(".prisma")) {
    const pmRe = /^model\s+([A-Za-z0-9_]+)\s*\{([\s\S]*?)\}/gm;
    while ((m = pmRe.exec(text)) !== null) {
      const fields = m[2].split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//") && !l.startsWith("@@")).slice(0, 12);
      res.models.push({ name: m[1], kind: "prisma_model", file: relPath, line: text.slice(0, m.index).split("\n").length, fields });
    }
  }

  // Python SQLAlchemy / Pydantic models
  if (relPath.endsWith(".py")) {
    const pyModelRe = /^class\s+([A-Za-z0-9_]+)\(([^)]*(?:Base|Model|BaseModel|SQLModel)[^)]*)\):/gm;
    while ((m = pyModelRe.exec(text)) !== null) {
      const lineNum = text.slice(0, m.index).split("\n").length;
      const tbl = /__tablename__\s*=\s*['"]([^'"]+)['"]/.exec(text.slice(m.index, m.index + 400))?.[1];
      res.models.push({ name: tbl ? `${m[1]} (${tbl})` : m[1], kind: "py_model", file: relPath, line: lineNum, fields: [] });
    }
  }

  // Env vars with default check
  const envAssignRe = /(?:process\.env\.([A-Z0-9_]{2,60})|os\.(?:getenv|environ\.get)\(\s*['"]([A-Z0-9_]{2,60})['"])\s*(\|\||\?\?|,)?/g;
  while ((m = envAssignRe.exec(text)) !== null) {
    res.envVars.push({ name: m[1] || m[2], file: relPath, hasDefault: Boolean(m[3]) });
  }

  // Feature flags
  const flagRe = /(?:isFeatureEnabled|hasFeature|featureFlag|useFlag)\(\s*['"]([a-zA-Z0-9_.-]{2,60})['"]/g;
  while ((m = flagRe.exec(text)) !== null) {
    res.featureFlags.push({ name: m[1], file: relPath, line: text.slice(0, m.index).split("\n").length, defaultVal: "unknown" });
  }

  // package.json scripts & dependencies
  if (base === "package.json" && specialKind === "config") {
    try {
      const pkg = JSON.parse(text);
      const comp = componentId || "root";
      const pkgDir = path.dirname(relPath) === "." ? "." : path.dirname(relPath);
      const isRootManifest = relPath === "package.json" || pkgDir === comp;
      if (isRootManifest && (pkg.description || pkg.name)) {
        res.projectMeta = { name: String(pkg.name || "").trim(), description: String(pkg.description || "").trim() };
      }
      if (pkg.scripts && typeof pkg.scripts === "object") {
        for (const [k, cmd] of Object.entries(pkg.scripts)) {
          res.scripts.push({ component: comp, packageRelPath: relPath, isComponentRoot: isRootManifest, name: k, command: String(cmd), file: relPath });
        }
      }
      const prod = [];
      const dev = [];
      for (const [dep, ver] of Object.entries(pkg.dependencies || {})) prod.push([dep, lockfileVersions.get(dep) || ver]);
      for (const [dep, ver] of Object.entries(pkg.devDependencies || {})) dev.push([dep, lockfileVersions.get(dep) || ver]);
      res.declaredDeps.push({ pkgKey: `${comp}::${relPath}`, component: comp, packageFile: relPath, prod, dev });
    } catch {}
  }

  if (base === "makefile" || base === "dockerfile" || base.startsWith("dockerfile.") || base === "procfile" || base === "docker-compose.yml" || base === "docker-compose.yaml") {
    res.deployFiles.push(relPath);
    const comp = componentId || "root";
    const isRoot = comp === "root" || path.dirname(relPath) === comp || path.dirname(relPath) === ".";
    if (base === "makefile") {
      const tgtRe = /^([A-Za-z0-9_.-]+)\s*:(?![=])/gm;
      let tm;
      while ((tm = tgtRe.exec(text)) !== null) {
        if (!tm[1].startsWith(".")) {
          res.scripts.push({ component: comp, packageRelPath: relPath, isComponentRoot: isRoot, name: `make ${tm[1]}`, command: `make ${tm[1]}`, file: relPath });
        }
      }
    } else if (base === "dockerfile" || base.startsWith("dockerfile.")) {
      const cmdMatch = /^(?:ENTRYPOINT|CMD)\s+(.+)$/im.exec(text);
      if (cmdMatch) {
        res.scripts.push({ component: comp, packageRelPath: relPath, isComponentRoot: isRoot, name: "docker-entry", command: cmdMatch[1].trim(), file: relPath });
      }
    } else if (base === "procfile") {
      for (const pl of text.split("\n")) {
        const pm = /^([A-Za-z0-9_-]+)\s*:\s*(.+)$/.exec(pl.trim());
        if (pm) res.scripts.push({ component: comp, packageRelPath: relPath, isComponentRoot: isRoot, name: `proc:${pm[1]}`, command: pm[2].trim(), file: relPath });
      }
    }
  }

  if (base === "pyproject.toml" && specialKind === "config") {
    const comp = componentId || "root";
    const descM = /^\s*description\s*=\s*["']([^"']+)["']/m.exec(text);
    if (descM && (relPath === "pyproject.toml" || path.dirname(relPath) === comp)) {
      res.projectMeta = { name: "", description: descM[1].trim() };
    }
    const scriptsSec = /\[(?:project|tool\.poetry)\.scripts\]([\s\S]*?)(?:\n\[|$)/.exec(text);
    if (scriptsSec) {
      for (const line of scriptsSec[1].split("\n")) {
        const sm = /^\s*([A-Za-z0-9_.-]+)\s*=\s*["']([^"']+)["']/.exec(line);
        if (sm) res.scripts.push({ component: comp, packageRelPath: relPath, isComponentRoot: true, name: sm[1], command: sm[2], file: relPath });
      }
    }
    if (/\[tool\.pytest/i.test(text)) res.scripts.push({ component: comp, packageRelPath: relPath, isComponentRoot: true, name: "pytest", command: "pytest", file: relPath });
  } else if (base === "cargo.toml" && specialKind === "config") {
    const comp = componentId || "root";
    if (/\[package\]/.test(text)) {
      res.scripts.push({ component: comp, packageRelPath: relPath, isComponentRoot: true, name: "cargo test", command: "cargo test", file: relPath });
      if (/\[\[bin\]\]/.test(text)) res.scripts.push({ component: comp, packageRelPath: relPath, isComponentRoot: true, name: "cargo run", command: "cargo run", file: relPath });
    }
  } else if (base === "go.mod" && specialKind === "config") {
    const comp = componentId || "root";
    res.scripts.push({ component: comp, packageRelPath: relPath, isComponentRoot: true, name: "go test", command: "go test ./...", file: relPath });
  }

  if (/^\.github\/workflows\/.+\.ya?ml$/i.test(relPath)) {
    const name = /^name:\s*(.+)$/m.exec(text)?.[1]?.trim() || path.basename(relPath);
    const triggers = [];
    if (/\bpush\b/.test(text)) triggers.push("push");
    if (/\bpull_request\b/.test(text)) triggers.push("pull_request");
    if (/\bworkflow_dispatch\b/.test(text)) triggers.push("manual");
    if (/\bschedule\b/.test(text)) triggers.push("schedule");
    res.ciJobs.push({ file: relPath, name, triggers });
  }

  return res;
}

function extractDataAndConfig({ fileSources = [], cachedSignals = [], lockfileVersions = new Map(), modules = [] } = {}) {
  const models = [];
  const migrations = [];
  const scripts = [];
  const envVars = new Map();
  const featureFlags = [];
  const ciJobs = [];
  const externalUsageCounts = new Map();
  const declaredDeps = new Map();

  const documentedEnvVars = new Set();
  const projectMeta = { name: "", description: "" };
  const deployFiles = [];

  for (const mod of modules) {
    for (const pkg of mod.structure?.externalPackages || []) {
      externalUsageCounts.set(pkg, (externalUsageCounts.get(pkg) || 0) + 1);
    }
    for (const ev of mod.structure?.talksTo?.envVars || []) {
      if (!envVars.has(ev)) envVars.set(ev, { name: ev, files: new Set(), hasDefault: false, documented: false });
      envVars.get(ev).files.add(mod.relPath);
    }
  }

  const allSignals = [
    ...cachedSignals,
    ...fileSources.map((src) => extractFileConfigSignals({ ...src, lockfileVersions })),
  ];

  for (const sig of allSignals) {
    if (!sig) continue;
    for (const dEnv of sig.documentedEnvVars || []) documentedEnvVars.add(dEnv);
    for (const m of sig.models || []) models.push(m);
    for (const mg of sig.migrations || []) migrations.push(mg);
    for (const sc of sig.scripts || []) scripts.push(sc);
    for (const ev of sig.envVars || []) {
      if (!envVars.has(ev.name)) envVars.set(ev.name, { name: ev.name, files: new Set(), hasDefault: false, documented: false });
      const rec = envVars.get(ev.name);
      rec.files.add(ev.file);
      if (ev.hasDefault) rec.hasDefault = true;
    }
    for (const fl of sig.featureFlags || []) featureFlags.push(fl);
    for (const cj of sig.ciJobs || []) ciJobs.push(cj);
    for (const df of sig.deployFiles || []) deployFiles.push(df);
    if (sig.projectMeta) {
      if (!projectMeta.description && sig.projectMeta.description) projectMeta.description = sig.projectMeta.description;
      if (!projectMeta.name && sig.projectMeta.name) projectMeta.name = sig.projectMeta.name;
    }
    for (const dd of sig.declaredDeps || []) {
      const entry = declaredDeps.get(dd.pkgKey) || { component: dd.component, packageFile: dd.packageFile, prod: new Map(), dev: new Map() };
      for (const [dep, ver] of dd.prod || []) entry.prod.set(dep, lockfileVersions.get(dep) || ver);
      for (const [dep, ver] of dd.dev || []) entry.dev.set(dep, lockfileVersions.get(dep) || ver);
      declaredDeps.set(dd.pkgKey, entry);
    }
  }

  for (const rec of envVars.values()) {
    rec.documented = documentedEnvVars.has(rec.name);
  }
  for (const docEnv of documentedEnvVars) {
    if (!envVars.has(docEnv)) {
      envVars.set(docEnv, { name: docEnv, files: new Set(), hasDefault: false, documented: true });
    }
  }

  // Detect multiple Alembic heads
  migrations.sort((a, b) => a.relPath.localeCompare(b.relPath));
  const referencedDownRevs = new Set(migrations.map((x) => x.downRev).filter(Boolean));
  const revMigrations = migrations.filter((x) => x.rev);
  const heads = revMigrations.filter((x) => !referencedDownRevs.has(x.rev));

  // Build external packages table
  const externalPackages = [];
  for (const deps of declaredDeps.values()) {
    for (const [pkg, ver] of deps.prod.entries()) {
      externalPackages.push({ component: deps.component, packageFile: deps.packageFile, name: pkg, version: ver, kind: "prod", sites: externalUsageCounts.get(pkg) || 0 });
    }
    for (const [pkg, ver] of deps.dev.entries()) {
      externalPackages.push({ component: deps.component, packageFile: deps.packageFile, name: pkg, version: ver, kind: "dev", sites: externalUsageCounts.get(pkg) || 0 });
    }
  }
  externalPackages.sort((a, b) => (a.kind !== b.kind ? (a.kind === "prod" ? -1 : 1) : b.sites - a.sites || a.name.localeCompare(b.name)));

  // Collapse identical scripts across sibling sub-packages (e.g., 12 expo-module packages)
  const scriptGroups = new Map();
  for (const sc of scripts) {
    const parentGroup = path.posix.dirname(path.posix.dirname(sc.file || ""));
    const groupKey = `${sc.component}::${parentGroup}::${sc.name}::${sc.command}`;
    if (!scriptGroups.has(groupKey)) scriptGroups.set(groupKey, []);
    scriptGroups.get(groupKey).push(sc);
  }
  const compactScripts = [];
  for (const items of scriptGroups.values()) {
    if (items.length >= 3 && !items.some((x) => x.isComponentRoot)) {
      const first = items[0];
      const prefix = path.posix.dirname(path.posix.dirname(first.file || ""));
      compactScripts.push({
        ...first,
        file: `${prefix === "." ? "" : `${prefix}/`}* (${items.length} packages)`,
      });
    } else {
      compactScripts.push(...items);
    }
  }

  return {
    models,
    migrations,
    migrationHeads: heads,
    scripts: compactScripts,
    envVars: [...envVars.values()].sort((a, b) => a.name.localeCompare(b.name)),
    featureFlags,
    ciJobs,
    deployFiles: [...new Set(deployFiles)].sort(),
    projectMeta,
    externalPackages,
  };
}

module.exports = { extractFileConfigSignals, extractDataAndConfig };
