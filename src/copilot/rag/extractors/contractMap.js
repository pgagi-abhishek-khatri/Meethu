// Cross-boundary contract extractor: server routes (with parent mount prefixes), Next.js API routes,
// Electron IPC handlers/callers, OpenAPI/GraphQL schemas, webhooks, jobs/queues, and mismatch detection.
const path = require("path");

function normalizeEndpointPath(rawPath) {
  let p = String(rawPath || "").trim();
  if (!p) return "";
  p = p.split("?")[0];
  p = p.replace(/^https?:\/\/[^/]+/i, "");
  p = p
    .replace(/\$\{[^}]+\}/g, "{param}")
    .replace(/\{[^}]+\}/g, "{param}")
    .replace(/<(?:[a-z]+:)?([a-zA-Z0-9_]+)>/g, "{param}")
    .replace(/:([a-zA-Z0-9_]+)/g, "{param}");
  if (!p.startsWith("/") && !p.includes(":")) p = `/${p}`;
  return p.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

function resolveRelativeTarget(fromFile, spec, knownPaths) {
  if (!spec || !spec.startsWith(".")) return null;
  const baseDir = path.posix.dirname(fromFile.replace(/\\/g, "/"));
  const candidate = path.posix.normalize(path.posix.join(baseDir, spec));
  const exts = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", "/index.ts", "/index.js"];
  for (const ext of exts) {
    const p = `${candidate}${ext}`;
    if (knownPaths.has(p)) return p;
  }
  return null;
}

function collectMountedPrefixes(fileSources, knownPaths) {
  const mountedPrefixByFile = new Map();
  for (const { relPath, text } of fileSources) {
    if (!text) continue;
    // Map local import symbol -> resolved file path (default, namespace, destructured, CJS, Python)
    const varToFile = new Map();
    const importRe = /(?:import\s+(?:\*\s+as\s+([A-Za-z0-9_$]+)|\{([^}]+)\}|([A-Za-z0-9_$]+))\s+from\s+['"]([^'"]+)['"]|(?:const|let|var)\s+(?:\{([^}]+)\}|([A-Za-z0-9_$]+))\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)|from\s+([A-Za-z0-9_.]+)\s+import\s+([A-Za-z0-9_,\s]+))/g;
    let im;
    while ((im = importRe.exec(text)) !== null) {
      const spec = im[4] || im[7] || (im[8] ? `./${im[8].replace(/\./g, "/")}` : "");
      const target = resolveRelativeTarget(relPath, spec, knownPaths);
      if (!target) continue;
      const singleSym = im[1] || im[3] || im[6];
      if (singleSym) varToFile.set(singleSym.trim(), target);
      const named = im[2] || im[5] || im[9];
      if (named) {
        for (const piece of named.split(",")) {
          const clean = piece.trim().split(/\s+as\s+/).pop()?.trim();
          if (clean) varToFile.set(clean, target);
        }
      }
    }

    // app.use("/api/v1", billingRouter) | fastify.register(router, { prefix: "/v1" }) | app.include_router(r, prefix="/api")
    const mountRe = /\b(?:app|router|server)\.(?:use|route)\(\s*['"]([^'"]+)['"]\s*,\s*([A-Za-z0-9_$]+)/g;
    while ((im = mountRe.exec(text)) !== null) {
      const target = varToFile.get(im[2]);
      if (target && im[1].startsWith("/")) {
        mountedPrefixByFile.set(target, im[1].replace(/\/$/, ""));
      }
    }
    const pyMountRe = /include_router\(\s*([A-Za-z0-9_.]+)(?:[^)]*prefix\s*=\s*['"]([^'"]+)['"])?/g;
    while ((im = pyMountRe.exec(text)) !== null) {
      const modSym = im[1].split(".")[0];
      const target = varToFile.get(modSym);
      if (target && im[2]) mountedPrefixByFile.set(target, im[2].replace(/\/$/, ""));
    }
  }
  return mountedPrefixByFile;
}

function collectConstMap(text) {
  const map = new Map();
  // const FOO = "/api/v1/..." or FOO = "/api"
  const flatRe = /\b(?:export\s+)?(?:const|let|var)\s+([A-Z0-9_a-z$]{2,40})\s*=\s*['"]([^'"\n]{2,120})['"]/g;
  let m;
  while ((m = flatRe.exec(text)) !== null) {
    map.set(m[1], m[2]);
  }
  // const ROUTES = { login: "/auth/login", ... }
  const objRe = /\b(?:export\s+)?(?:const|let|var)\s+([A-Z0-9_a-z$]{2,32})\s*=\s*\{([\s\S]{1,800}?)\}/g;
  while ((m = objRe.exec(text)) !== null) {
    const objName = m[1];
    const body = m[2];
    const kvRe = /([A-Za-z0-9_]+)\s*:\s*['"]([^'"\n]{2,100})['"]/g;
    let kv;
    while ((kv = kvRe.exec(body)) !== null) {
      map.set(`${objName}.${kv[1]}`, kv[2]);
    }
  }
  return map;
}

function resolveExprPath(rawExpr, constMap) {
  const clean = String(rawExpr || "").trim();
  if (!clean) return { resolved: "", dynamic: true };
  // Direct string literal or template without unknown interpolation
  if (/^['"`][^'"`]+['"`]$/.test(clean)) {
    const inner = clean.slice(1, -1);
    if (!inner.includes("${")) return { resolved: inner, dynamic: false };
    let replaced = inner.replace(/\$\{([A-Za-z0-9_$.]+)\}/g, (full, sym) => constMap.get(sym) || "{param}");
    const hasOnlyPrefixOrParam = /^[/a-zA-Z0-9_{}.:-]+$/.test(replaced);
    return { resolved: hasOnlyPrefixOrParam ? replaced : "", dynamic: !hasOnlyPrefixOrParam };
  }
  if (constMap.has(clean)) {
    return { resolved: constMap.get(clean), dynamic: false };
  }
  return { resolved: "", dynamic: true };
}

// Strips comments & regex literals cleanly before scanning a line for route/IPC definitions so comments or regex patterns don't create false endpoints.
function stripLineNoiseForContracts(rawLine, lang = "") {
  let line = String(rawLine || "");
  if (lang === "python") {
    line = line.replace(/(^|\s)#.*$/, "$1");
  }
  // Remove block comment fragments on same line and trailing // comments outside quotes
  line = line.replace(/\/\*[\s\S]*?\*\//g, " ");
  let out = "";
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      out += ch;
      if (ch === "\\" && i + 1 < line.length) { out += line[++i]; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && line[i + 1] === "/") break;
    // Skip JS regex literals (/.../flags) preceded by =, (, [, ,, :, !, return, etc.
    if (ch === "/" && line[i + 1] && line[i + 1] !== "*" && /(?:^|[=([,:!&|?;\s])$/.test(out.slice(-1))) {
      let j = i + 1;
      let escaped = false;
      let inClass = false;
      let foundClose = false;
      while (j < line.length) {
        const rc = line[j];
        if (escaped) { escaped = false; j++; continue; }
        if (rc === "\\") { escaped = true; j++; continue; }
        if (rc === "[") inClass = true;
        else if (rc === "]" && inClass) inClass = false;
        else if (rc === "/" && !inClass) { foundClose = true; j++; break; }
        j++;
      }
      if (foundClose) {
        while (j < line.length && /[gimsuvy]/.test(line[j])) j++;
        out += " /REGEX/ ";
        i = j - 1;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

function collectNeedleHits(text) {
  const needles = [];
  const seen = new Set();
  const re = /['"`]([A-Za-z0-9_:/{}.-]{4,90})['"`]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const val = m[1];
    if (val.includes("/") || val.includes(":")) {
      const line = text.slice(0, m.index).split("\n").length;
      if (!seen.has(val)) {
        seen.add(val);
        needles.push({ val, line });
        if (needles.length >= 120) break;
      }
    }
  }
  return needles;
}

function collectMountsFromSource(relPath, text) {
  if (!text || (!text.includes(".use(") && !text.includes(".route(") && !text.includes("include_router("))) return [];
  const varToSpec = new Map();
  const importRe = /(?:import\s+(?:\*\s+as\s+([A-Za-z0-9_$]+)|\{([^}]+)\}|([A-Za-z0-9_$]+))\s+from\s+['"]([^'"]+)['"]|(?:const|let|var)\s+(?:\{([^}]+)\}|([A-Za-z0-9_$]+))\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)|from\s+([A-Za-z0-9_.]+)\s+import\s+([A-Za-z0-9_,\s]+))/g;
  let im;
  while ((im = importRe.exec(text)) !== null) {
    const spec = im[4] || im[7] || (im[8] ? `./${im[8].replace(/\./g, "/")}` : "");
    if (!spec || !spec.startsWith(".")) continue;
    const singleSym = im[1] || im[3] || im[6];
    if (singleSym) varToSpec.set(singleSym.trim(), spec);
    const named = im[2] || im[5] || im[9];
    if (named) {
      for (const piece of named.split(",")) {
        const clean = piece.trim().split(/\s+as\s+/).pop()?.trim();
        if (clean) varToSpec.set(clean, spec);
      }
    }
  }
  const links = [];
  const mountRe = /\b(?:app|router|server)\.(?:use|route)\(\s*['"]([^'"]+)['"]\s*,\s*([A-Za-z0-9_$]+)/g;
  while ((im = mountRe.exec(text)) !== null) {
    const spec = varToSpec.get(im[2]);
    if (spec && im[1].startsWith("/")) links.push({ fromFile: relPath, spec, prefix: im[1].replace(/\/$/, "") });
  }
  const pyMountRe = /include_router\(\s*([A-Za-z0-9_.]+)(?:[^)]*prefix\s*=\s*['"]([^'"]+)['"])?/g;
  while ((im = pyMountRe.exec(text)) !== null) {
    const spec = varToSpec.get(im[1].split(".")[0]);
    if (spec && im[2]) links.push({ fromFile: relPath, spec, prefix: im[2].replace(/\/$/, "") });
  }
  return links;
}

function extractFileContractSignals({ relPath, text, structure, filePrefix = "" } = {}) {
  const served = [];
  const called = [];
  const events = [];
  const unresolvedDynamicCalls = [];
  if (!text) return { served, called, events, unresolvedDynamicCalls, mountLinks: [], needles: [] };
  if (structure?.role === "test" || /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.[^.]+$/i.test(relPath)) {
    return { served, called, events, unresolvedDynamicCalls, mountLinks: [], needles: [] };
  }

  const mountLinks = collectMountsFromSource(relPath, text);
  const base = path.basename(relPath).toLowerCase();
  const lines = text.split("\n");
  const constMap = collectConstMap(text);
  const lang = structure?.language || (relPath.endsWith(".py") ? "python" : "");
  const needles = collectNeedleHits(text);

  // OpenAPI / Swagger paths
  if (/^(?:openapi|swagger)\.(?:ya?ml|json)$/i.test(base)) {
    const pathRe = /^\s{2,4}(\/[^\s:"]+):/gm;
    let om;
    while ((om = pathRe.exec(text)) !== null) {
      const lineNum = text.slice(0, om.index).split("\n").length;
      const p = om[1];
      served.push({ kind: "openapi", method: "SPEC", path: p, normPath: normalizeEndpointPath(p), handlerFile: relPath, handlerLine: lineNum, auth: "", schema: "openapi" });
    }
    return { served, called, events, unresolvedDynamicCalls, mountLinks, needles };
  }

  // GraphQL SDL schema Query / Mutation / Subscription fields
  if (/\.graphql$|\.gql$/i.test(base)) {
    const blockRe = /\btype\s+(Query|Mutation|Subscription)\s*\{([\s\S]*?)\}/g;
    let gm;
    while ((gm = blockRe.exec(text)) !== null) {
      const opType = gm[1].toUpperCase();
      const startLine = text.slice(0, gm.index).split("\n").length;
      const fieldLines = gm[2].split("\n");
      fieldLines.forEach((fl, offset) => {
        const fm = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(|:)/.exec(fl);
        if (fm && !fl.trim().startsWith("#")) {
          served.push({
            kind: "graphql",
            method: opType,
            path: `graphql:${fm[1]}`,
            normPath: `graphql:${fm[1]}`,
            handlerFile: relPath,
            handlerLine: startLine + offset,
            auth: "",
            schema: "graphql",
          });
        }
      });
    }
    return { served, called, events, unresolvedDynamicCalls, mountLinks, needles };
  }

  // Next.js App Router API routes: app/api/.../route.ts
  const nextAppApi = /(?:^|\/)(?:src\/)?app(\/api\/.+)\/route\.[jt]sx?$/.exec(relPath);
  if (nextAppApi) {
    const routePath = nextAppApi[1].replace(/\[([^\]]+)\]/g, "{$1}");
    const expMethodRe = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;
    let nm;
    while ((nm = expMethodRe.exec(text)) !== null) {
      const lineNum = text.slice(0, nm.index).split("\n").length;
      served.push({
        kind: "http",
        method: nm[1].toUpperCase(),
        path: routePath,
        normPath: normalizeEndpointPath(routePath),
        handlerFile: relPath,
        handlerLine: lineNum,
        auth: /auth|session|getServerSession/i.test(text) ? "auth" : "",
        schema: "nextjs-route",
      });
    }
  }

  let effectivePrefix = filePrefix;
  const prefixMatch = /(?:APIRouter\(\s*prefix\s*=\s*|prefix\s*:\s*)['"]([^'"]+)['"]/.exec(text);
  if (prefixMatch) {
    const localPfx = prefixMatch[1].replace(/\/$/, "");
    effectivePrefix = effectivePrefix && !localPfx.startsWith(effectivePrefix) ? `${effectivePrefix}${localPfx}` : localPfx;
  }

  const ipcPrefixVar = /\b(?:IPC_PREFIX|CHANNEL_PREFIX)\s*=\s*['"]([a-zA-Z0-9_-]+:)['"]/.exec(text)?.[1] || "";
  const localRouterVars = new Set(["app", "router", "server", "fastify"]);
  const routerDeclRe = /\b(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:new\s+(?:Hono|Elysia)|(?:express\.)?Router|Fastify)\s*\(/g;
  let rm;
  while ((rm = routerDeclRe.exec(text)) !== null) {
    localRouterVars.add(rm[1]);
  }

  let inBlockComment = false;
  for (let idx = 0; idx < lines.length; idx++) {
    let rawLine = lines[idx];
    const lineNum = idx + 1;
    const trimmedRaw = rawLine.trim();
    if (inBlockComment) {
      if (trimmedRaw.includes("*/")) inBlockComment = false;
      continue;
    }
    if (trimmedRaw.startsWith("/*") && !trimmedRaw.includes("*/")) {
      inBlockComment = true;
      continue;
    }
    if (!trimmedRaw || trimmedRaw.startsWith("//") || (lang === "python" && trimmedRaw.startsWith("#"))) continue;

    const line = stripLineNoiseForContracts(rawLine, lang);
    if (!line.trim()) continue;

    // 1. Express / Fastify / Hono: router.get("/path", ...), r.post("/path", ...), billingRouter.get("/path", ...)
    const jsRoute = /\b([A-Za-z0-9_$]+)\.(get|post|put|patch|delete|all)\(\s*['"`](\/[^'"`\n]*)['"`]/i.exec(line);
    if (jsRoute && (localRouterVars.has(jsRoute[1]) || /(?:Router|Routes)$/i.test(jsRoute[1]))) {
      const method = jsRoute[2].toUpperCase();
      const rawSub = jsRoute[3];
      const fullPath = rawSub.startsWith(effectivePrefix) ? rawSub : `${effectivePrefix}${rawSub.startsWith("/") ? rawSub : `/${rawSub}`}`;
      const normPath = normalizeEndpointPath(fullPath);
      const isWebhook = /webhook/i.test(fullPath) || /verifyWebhook|stripe-signature|x-hub-signature/i.test(line);
      const auth = /auth|requireUser|verifyToken|session|guard/i.test(line) ? "auth" : "";
      served.push({ kind: isWebhook ? "webhook" : "http", method, path: fullPath, normPath, handlerFile: relPath, handlerLine: lineNum, auth, schema: "" });
    }

    // 2. Python FastAPI / Flask: @router.get("/path") / @app.route("/path", methods=["POST"])
    const pyDec = /@(?:router|app|bp)\.(get|post|put|patch|delete|route)\(\s*['"]([^'"]+)['"](?:[^)]*methods\s*=\s*\[([^\]]+)\])?/i.exec(line);
    if (pyDec) {
      const rawMethod = pyDec[1].toLowerCase() === "route" ? (pyDec[3] || "GET").replace(/['"\s]/g, "").split(",")[0] : pyDec[1];
      const method = rawMethod.toUpperCase();
      const rawSub = pyDec[2];
      const fullPath = rawSub.startsWith(effectivePrefix) ? rawSub : `${effectivePrefix}${rawSub.startsWith("/") ? rawSub : `/${rawSub}`}`;
      const normPath = normalizeEndpointPath(fullPath);
      const nextSlice = lines.slice(idx, idx + 6).join(" ");
      const auth = /Depends\([^)]*(?:user|auth|token|session)|login_required/i.test(nextSlice) ? "auth" : "";
      const schemaMatch = /response_model\s*=\s*([A-Za-z0-9_]+)/.exec(line) || /:\s*([A-Z][A-Za-z0-9_]+Schema|[A-Z][A-Za-z0-9_]+Request)/.exec(nextSlice);
      served.push({ kind: /webhook/i.test(fullPath) ? "webhook" : "http", method, path: fullPath, normPath, handlerFile: relPath, handlerLine: lineNum, auth, schema: schemaMatch?.[1] || "" });
    }

    // 3. Electron IPC server handlers: ipcMain.handle("ch", ...) or handle("ch", ...)
    const ipcSrv = /\bipcMain\.(?:handle|on)\(\s*['"]([^'"\n]+)['"]/.exec(line) || (/\bhandle\(\s*['"]([^'"\n]+)['"]/.exec(line) && (relPath.includes("main") || relPath.includes("service") || relPath.includes("ipc") ? /\bhandle\(\s*['"]([^'"\n]+)['"]/.exec(line) : null));
    if (ipcSrv) {
      const raw = ipcSrv[1];
      const copilotScoped = !raw.includes(":") && relPath.includes("copilot/") ? `copilot:${raw}` : raw;
      const ch = ipcPrefixVar && !copilotScoped.includes(":") ? `${ipcPrefixVar}${copilotScoped}` : copilotScoped;
      served.push({ kind: "ipc", method: "IPC", path: ch, normPath: ch, handlerFile: relPath, handlerLine: lineNum, auth: "registered", schema: "" });
    }

    // 4. Electron IPC client / preload callers: ipcRenderer.invoke("ch") or copilotCall("ch") or constant indirection
    const ipcCli = /\b(?:ipcRenderer\.(?:invoke|send)|copilotCall|invokeIpc|call)\(\s*([^,\)\n]{2,80})/.exec(line);
    if (ipcCli && (relPath.includes("preload") || relPath.includes("components") || relPath.includes("hooks") || relPath.includes("services") || line.includes("ipcRenderer"))) {
      const res = resolveExprPath(ipcCli[1], constMap);
      if (res.resolved && !res.dynamic) {
        const raw = res.resolved;
        const ch = !raw.includes(":") && (line.includes("copilotCall") || (relPath.includes("copilot/") && relPath.includes("preload")))
          ? `copilot:${raw}`
          : ipcPrefixVar && !raw.includes(":")
            ? `${ipcPrefixVar}${raw}`
            : raw;
        called.push({ kind: "ipc", method: "IPC", path: ch, normPath: ch, callerFile: relPath, callerLine: lineNum, confidence: "certain" });
      } else if (res.dynamic) {
        unresolvedDynamicCalls.push({ kind: "ipc", rawExpr: ipcCli[1].trim(), file: relPath, line: lineNum });
      }
    }

    // 5. HTTP client calls: fetch("..."), axios.post(CONST), api.get(`${BASE}/path`) or dynamic expr
    const httpCli = /\b(?:fetch|axios\.(?:get|post|put|patch|delete)|api(?:Client)?\.(?:get|post|put|patch|delete))\(\s*([^,\)\n]{2,120})/i.exec(line);
    if (httpCli && !jsRoute) {
      const mMatch = /\.(get|post|put|patch|delete)\(/i.exec(line);
      const methodMatch2 = /method\s*:\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/i.exec(lines.slice(idx, idx + 4).join(" "));
      const method = (mMatch?.[1] || methodMatch2?.[1] || "GET").toUpperCase();
      const res = resolveExprPath(httpCli[1], constMap);
      if (res.resolved && !res.dynamic) {
        const rawP = res.resolved;
        if (!/^https?:\/\/(?!localhost)/i.test(rawP) && (rawP.startsWith("/") || rawP.startsWith("http"))) {
          called.push({ kind: "http", method, path: rawP, normPath: normalizeEndpointPath(rawP), callerFile: relPath, callerLine: lineNum, confidence: "certain" });
        }
      } else if (res.dynamic && !/^[\s{}$"']+$/.test(httpCli[1])) {
        unresolvedDynamicCalls.push({ kind: "http", rawExpr: httpCli[1].trim(), file: relPath, line: lineNum });
      }
    }

    // 6. WebSocket / Event / Queue / Job topics
    const wsEv = /\b(?:socket|ws|emitter|bus|queue)\.(?:on|emit|subscribe|process|define)\(\s*['"]([^'"\n]{2,60})['"]/.exec(line);
    if (wsEv) {
      events.push({ kind: line.includes("queue.") || line.includes(".process") || line.includes(".define") ? "job" : "event", channel: wsEv[1], file: relPath, line: lineNum, direction: line.includes(".emit") ? "emit" : "listen" });
    }
    const cronDec = /@(?:celery\.task|shared_task|Cron|Interval)\((?:['"]([^'"]+)['"])?/.exec(line);
    if (cronDec) {
      events.push({ kind: "job", channel: cronDec[1] || path.basename(relPath), file: relPath, line: lineNum, direction: "worker" });
    }
  }

  if (structure?.role === "route/page" && !served.some((s) => s.handlerFile === relPath)) {
    const routeHint = relPath.replace(/\.[a-z]+$/, "");
    events.push({ kind: "page", channel: routeHint, file: relPath, line: 1, direction: "route" });
  }

  return { served, called, events, unresolvedDynamicCalls, mountLinks, needles };
}

function correlateContractSignals(signalEntries = []) {
  const knownPaths = new Set(signalEntries.map((x) => x.relPath).filter(Boolean));
  const mountedByFile = new Map();
  for (const item of signalEntries) {
    for (const ml of item?.signals?.mountLinks || []) {
      const target = resolveRelativeTarget(ml.fromFile, ml.spec, knownPaths);
      if (target && !mountedByFile.has(target)) mountedByFile.set(target, ml.prefix);
    }
  }

  const served = [];
  const called = [];
  const events = [];
  const unresolvedDynamicCalls = [];
  const nonTestNeedles = [];

  for (const item of signalEntries) {
    if (!item || !item.signals) continue;
    const { relPath, signals } = item;
    const mountPfx = mountedByFile.get(relPath) || "";
    for (const s of signals.served || []) {
      if (mountPfx && (s.kind === "http" || s.kind === "webhook") && !s.path.startsWith(mountPfx)) {
        const fullPath = `${mountPfx}${s.path.startsWith("/") ? s.path : `/${s.path}`}`;
        served.push({ ...s, path: fullPath, normPath: normalizeEndpointPath(fullPath) });
      } else {
        served.push(s);
      }
    }
    for (const c of signals.called || []) called.push(c);
    for (const e of signals.events || []) events.push(e);
    for (const u of signals.unresolvedDynamicCalls || []) unresolvedDynamicCalls.push(u);
    if ((signals.needles || []).length > 0) {
      const isClient = relPath.includes("components") || relPath.includes("hooks") || relPath.includes("services") || relPath.includes("preload") || relPath.includes("renderer") || relPath.includes("client") || relPath.includes("app/");
      nonTestNeedles.push({ relPath, isClient, needles: signals.needles });
    }
  }

  const clientCandidates = nonTestNeedles.filter((x) => x.isClient);
  const contracts = [];
  const rawMismatches = [];
  const calledMatched = new Set();

  for (const s of served) {
    const callers = [];
    let methodMismatch = null;
    let confidence = "certain";
    called.forEach((c, idx) => {
      if (c.kind === s.kind && c.normPath === s.normPath) {
        if (c.method === s.method || s.kind === "ipc") {
          callers.push(`${c.callerFile}:L${c.callerLine}`);
          calledMatched.add(idx);
        } else {
          methodMismatch = { expected: s.method, got: c.method, caller: `${c.callerFile}:L${c.callerLine}` };
          calledMatched.add(idx);
        }
      }
    });

    if (callers.length === 0 && (s.kind === "http" || s.kind === "ipc") && s.normPath.length >= 4) {
      const literalStem = s.normPath.replace(/\{param\}.*$/, "").replace(/:.*$/, "").trim();
      const needle = literalStem.length >= 4 ? literalStem : s.normPath;
      const bareIpc = s.kind === "ipc" ? s.normPath.replace(/^[^:]+:/, "") : "";
      for (const cs of clientCandidates) {
        if (cs.relPath === s.handlerFile) continue;
        const hit = cs.needles.find((n) => n.val.includes(needle) || (bareIpc.length >= 5 && n.val.includes(bareIpc)));
        if (hit) {
          callers.push(`${cs.relPath}:L${hit.line} [likely]`);
          confidence = "likely";
          if (callers.length >= 3) break;
        }
      }
    }

    contracts.push({
      kind: s.kind,
      method: s.method,
      path: s.path,
      normPath: s.normPath,
      handlerFile: s.handlerFile,
      handlerLine: s.handlerLine,
      schema: s.schema,
      auth: s.auth,
      callers: [...new Set(callers)],
      confidence: callers.length > 0 ? confidence : unresolvedDynamicCalls.length > 0 ? "unresolved" : "certain",
      versioned: /\/v\d+\b/i.test(s.path),
    });

    if (methodMismatch) {
      rawMismatches.push({
        type: "method_mismatch",
        path: s.normPath,
        detail: `Served as ${methodMismatch.expected} at ${s.handlerFile}:L${s.handlerLine}, called as ${methodMismatch.got} at ${methodMismatch.caller}`,
      });
    } else if (callers.length === 0 && (s.kind === "http" || s.kind === "ipc")) {
      rawMismatches.push({
        type: s.kind === "ipc" ? "ipc_served_not_called" : "served_not_called",
        path: `${s.method} ${s.normPath}`,
        detail: `Served at ${s.handlerFile}:L${s.handlerLine}, no client caller found`,
      });
    }
  }

  called.forEach((c, idx) => {
    if (!calledMatched.has(idx) && (c.kind === "http" || c.kind === "ipc")) {
      rawMismatches.push({
        type: c.kind === "ipc" ? "ipc_called_not_served" : "called_not_served",
        path: `${c.method} ${c.normPath}`,
        detail: `Called at ${c.callerFile}:L${c.callerLine}, no matching server handler found`,
      });
    }
  });

  const mismatchMap = new Map();
  for (const m of rawMismatches) {
    const key = `${m.type}::${m.path}`;
    if (!mismatchMap.has(key)) mismatchMap.set(key, { ...m, count: 1 });
    else mismatchMap.get(key).count += 1;
  }
  const mismatches = [...mismatchMap.values()].map((m) =>
    m.count > 1 ? { ...m, detail: `${m.detail} (+${m.count - 1} duplicate sites)` } : m
  );

  const uncalledSample = mismatches.filter((m) => m.type === "served_not_called" || m.type === "ipc_served_not_called").slice(0, 20);
  let falseNegatives = 0;
  for (const m of uncalledSample) {
    const rawEndpoint = m.path.split(" ").slice(1).join(" ").replace(/\{param\}/g, "");
    if (rawEndpoint.length < 4) continue;
    const hitAnywhere = nonTestNeedles.some((src) => !m.detail.includes(src.relPath) && src.needles.some((n) => n.val.includes(rawEndpoint)));
    if (hitAnywhere) falseNegatives += 1;
  }
  const selfCheck = {
    sampled: uncalledSample.length,
    falseNegatives,
    lowConfidence: uncalledSample.length >= 4 && falseNegatives / uncalledSample.length > 0.25,
  };

  contracts.sort((a, b) => a.normPath.localeCompare(b.normPath) || a.method.localeCompare(b.method));
  return { contracts, mismatches, events, unresolvedDynamicCalls: unresolvedDynamicCalls.slice(0, 60), selfCheck };
}

function extractContractsFromFiles(fileSources = []) {
  const knownPaths = new Set(fileSources.map((f) => f.relPath));
  const mountedPrefixes = collectMountedPrefixes(fileSources, knownPaths);
  const signalEntries = fileSources.map((src) => ({
    relPath: src.relPath,
    signals: extractFileContractSignals({
      relPath: src.relPath,
      text: src.text,
      structure: src.structure,
      filePrefix: mountedPrefixes.get(src.relPath) || "",
    }),
  }));
  return correlateContractSignals(signalEntries);
}

module.exports = {
  normalizeEndpointPath,
  extractFileContractSignals,
  correlateContractSignals,
  extractContractsFromFiles,
};
