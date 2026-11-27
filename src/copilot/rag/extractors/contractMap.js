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

function extractContractsFromFiles(fileSources = []) {
  const served = [];
  const called = [];
  const events = [];
  const knownPaths = new Set(fileSources.map((f) => f.relPath));
  const mountedPrefixes = collectMountedPrefixes(fileSources, knownPaths);

  for (const { relPath, text, structure } of fileSources) {
    if (!text) continue;
    if (structure?.role === "test" || /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.[^.]+$/i.test(relPath)) continue;
    const base = path.basename(relPath).toLowerCase();
    const lines = text.split("\n");

    // OpenAPI / Swagger paths
    if (/^(?:openapi|swagger)\.(?:ya?ml|json)$/i.test(base)) {
      const pathRe = /^\s{2,4}(\/[^\s:"]+):/gm;
      let om;
      while ((om = pathRe.exec(text)) !== null) {
        const lineNum = text.slice(0, om.index).split("\n").length;
        const p = om[1];
        served.push({ kind: "openapi", method: "SPEC", path: p, normPath: normalizeEndpointPath(p), handlerFile: relPath, handlerLine: lineNum, auth: "", schema: "openapi" });
      }
      continue;
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
      continue;
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

    // Detect router mount prefix if present (local or parent-mounted)
    let filePrefix = mountedPrefixes.get(relPath) || "";
    const prefixMatch = /(?:APIRouter\(\s*prefix\s*=\s*|prefix\s*:\s*)['"]([^'"]+)['"]/.exec(text);
    if (prefixMatch) {
      const localPfx = prefixMatch[1].replace(/\/$/, "");
      filePrefix = filePrefix && !localPfx.startsWith(filePrefix) ? `${filePrefix}${localPfx}` : localPfx;
    }

    // Detect custom IPC prefix namespace in preload/renderer wrappers if declared cleanly
    const ipcPrefixVar = /\b(?:IPC_PREFIX|CHANNEL_PREFIX)\s*=\s*['"]([a-zA-Z0-9_-]+:)['"]/.exec(text)?.[1] || "";

    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      const lineNum = idx + 1;

      // 1. Express / Fastify / Hono: router.get("/path", ...), billingRouter.get("/path", ...) or app.post("/path", ...)
      const jsRoute = /\b(?:app|router|server|fastify|[A-Za-z0-9_$]*(?:Router|Routes))\.(get|post|put|patch|delete|all)\(\s*['"`](\/[^'"`\n]*)['"`]/i.exec(line);
      if (jsRoute) {
        const method = jsRoute[1].toUpperCase();
        const rawSub = jsRoute[2];
        const fullPath = rawSub.startsWith(filePrefix) ? rawSub : `${filePrefix}${rawSub.startsWith("/") ? rawSub : `/${rawSub}`}`;
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
        const fullPath = rawSub.startsWith(filePrefix) ? rawSub : `${filePrefix}${rawSub.startsWith("/") ? rawSub : `/${rawSub}`}`;
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

      // 4. Electron IPC client / preload callers: ipcRenderer.invoke("ch") or copilotCall("ch") / call("ch")
      const ipcCli = /\b(?:ipcRenderer\.(?:invoke|send)|copilotCall|invokeIpc|call)\(\s*['"`]([^'"`\n]+)['"`]/.exec(line);
      if (ipcCli && (relPath.includes("preload") || relPath.includes("components") || relPath.includes("hooks") || relPath.includes("services") || line.includes("ipcRenderer"))) {
        const raw = ipcCli[1];
        const ch = !raw.includes(":") && (line.includes("copilotCall") || (relPath.includes("copilot/") && relPath.includes("preload")))
          ? `copilot:${raw}`
          : ipcPrefixVar && !raw.includes(":")
            ? `${ipcPrefixVar}${raw}`
            : raw;
        called.push({ kind: "ipc", method: "IPC", path: ch, normPath: ch, callerFile: relPath, callerLine: lineNum });
      }

      // 5. HTTP client calls: fetch("..."), axios.post("..."), api.get("...")
      const httpCli = /\b(?:fetch|axios\.(?:get|post|put|patch|delete)|api(?:Client)?\.(?:get|post|put|patch|delete))\(\s*['"`]([^'"`\n]+)['"`]/i.exec(line);
      if (httpCli && !jsRoute) {
        const mMatch = /\.(get|post|put|patch|delete)\(/i.exec(line);
        const methodMatch2 = /method\s*:\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/i.exec(lines.slice(idx, idx + 4).join(" "));
        const method = (mMatch?.[1] || methodMatch2?.[1] || "GET").toUpperCase();
        const rawP = httpCli[1];
        if (!/^https?:\/\/(?!localhost)/i.test(rawP)) {
          called.push({ kind: "http", method, path: rawP, normPath: normalizeEndpointPath(rawP), callerFile: relPath, callerLine: lineNum });
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
  }

  // Correlate served <-> called across HTTP and IPC
  const contracts = [];
  const mismatches = [];
  const calledMatched = new Set();

  for (const s of served) {
    const callers = [];
    let methodMismatch = null;
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
      versioned: /\/v\d+\b/i.test(s.path),
    });

    if (methodMismatch) {
      mismatches.push({
        type: "method_mismatch",
        path: s.normPath,
        detail: `Served as ${methodMismatch.expected} at ${s.handlerFile}:L${s.handlerLine}, called as ${methodMismatch.got} at ${methodMismatch.caller}`,
      });
    } else if (callers.length === 0 && (s.kind === "http" || s.kind === "ipc")) {
      mismatches.push({
        type: s.kind === "ipc" ? "ipc_served_not_called" : "served_not_called",
        path: `${s.method} ${s.normPath}`,
        detail: `Served at ${s.handlerFile}:L${s.handlerLine}, no client caller found`,
      });
    }
  }

  called.forEach((c, idx) => {
    if (!calledMatched.has(idx) && (c.kind === "http" || c.kind === "ipc")) {
      mismatches.push({
        type: c.kind === "ipc" ? "ipc_called_not_served" : "called_not_served",
        path: `${c.method} ${c.normPath}`,
        detail: `Called at ${c.callerFile}:L${c.callerLine}, no matching server handler found`,
      });
    }
  });

  contracts.sort((a, b) => a.normPath.localeCompare(b.normPath) || a.method.localeCompare(b.method));
  return { contracts, mismatches, events };
}

module.exports = {
  normalizeEndpointPath,
  extractContractsFromFiles,
};
