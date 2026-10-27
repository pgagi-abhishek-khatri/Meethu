// One POST to OpenRouter with the retries every RAG call needs: rate limits and overloads wait and try again,
// credit and key problems fail at once with a code the UI can word. Electron-free; fetch and sleep are injected.
const BASE = "https://openrouter.ai/api/v1";

const CODES = {
  401: "auth",
  403: "auth",
  402: "credits",
  404: "model",
  400: "bad_input",
  413: "too_big",
};

async function postJson(
  path,
  body,
  {
    apiKey,
    baseUrl = BASE,
    fetchImpl = fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    retries = 3,
    timeoutMs = 120000,
    signal,
  } = {}
) {
  if (!apiKey) throw Object.assign(new Error("no key"), { code: "no_key" });
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const t = AbortSignal.timeout(timeoutMs);
      const res = await fetchImpl(`${baseUrl}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, t]) : t,
      });
      if (res.ok) {
        const json = await res.json();
        // OpenRouter reports an upstream failure as 200 with an error object
        if (json?.error)
          throw Object.assign(new Error(json.error.message ?? "error"), {
            code: `http_${json.error.code ?? 502}`,
            retryable: true,
          });
        return json;
      }
      const text = await res.text().catch(() => "");
      const err = Object.assign(new Error(`${path} ${res.status}: ${text.slice(0, 200)}`), {
        status: res.status,
        code: CODES[res.status] ?? `http_${res.status}`,
        retryable: res.status === 429 || res.status >= 500,
        retryAfterMs: Number(res.headers?.get?.("retry-after")) * 1000 || 0,
      });
      throw err;
    } catch (e) {
      last = e;
      if (signal?.aborted) throw Object.assign(new Error("cancelled"), { code: "cancelled" });
      const retryable = e.retryable || e.name === "TimeoutError" || e.name === "TypeError"; // TypeError = network down
      if (!retryable || attempt === retries) break;
      await sleep(e.retryAfterMs || 600 * 2 ** attempt + Math.floor(Math.random() * 250));
    }
  }
  if (last && !last.code) last.code = last.name === "TimeoutError" ? "timeout" : "network";
  throw last;
}

// A tiny counting semaphore: `run(fn)` waits for a free slot.
function pool(limit) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= limit || !waiting.length) return;
    active++;
    const { fn, resolve, reject } = waiting.shift();
    fn()
      .then(resolve, reject)
      .finally(() => (active--, next()));
  };
  return {
    run: (fn) => new Promise((resolve, reject) => (waiting.push({ fn, resolve, reject }), next())),
  };
}

module.exports = { postJson, pool, BASE };
