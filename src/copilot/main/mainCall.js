// Streams the main model's answer from OpenRouter chat completions (SSE). Main process, no Electron.
// reasoning: the fast tier must send a low effort (this model's reasoning is mandatory, default effort
// costs ~4.8 s before the first token; see docs/copilot/phase0b-report.md). Web search is OpenRouter's
// server tool: the text only starts after the search, so the card shows "searching" until then.
const { ANSWER_LIMITS, fastReasoningFor } = require("../config/budgets");

// Tuned for a live meeting (see openrouter.ai/docs/guides/features/server-tools/web-search): Exa's fast mode
// (about 0.5 s), a few short results, and at most two searches, so the answer is not held up by a long research loop.
const WEB_SEARCH = {
  type: "openrouter:web_search",
  parameters: {
    engine: "exa",
    mode: "fast",
    max_results: 4,
    max_total_results: 6,
    search_context_size: "low",
  },
};

// The deep model (Claude) searches natively: no engine to pick, at most two searches.
const DEEP_SEARCH = { type: "openrouter:web_search", parameters: { max_uses: 2 } };

function createMainModel({
  apiKey,
  model,
  baseUrl = "https://openrouter.ai/api/v1",
  fetchImpl = fetch,
  now = Date.now,
  retry402Ms = 4000,
}) {
  // stream({messages, tier, web, signal, onDelta}) -> { text, sources, usage, firstTokenMs, totalMs }
  const attempt = async function stream({
    messages,
    tier = "fast",
    web = false,
    signal,
    onDelta,
    model: modelOverride,
  }) {
    const useModel = modelOverride || model;
    if (!apiKey) throw Object.assign(new Error("no key"), { code: "no_key" });
    const limits = ANSWER_LIMITS[tier] ?? ANSWER_LIMITS.fast;
    const timeout = AbortSignal.timeout(limits.timeoutMs);
    const t0 = now();
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: useModel,
        messages,
        stream: true,
        max_tokens: limits.maxTokens,
        temperature: 0.3,
        ...((tier === "fast" ? fastReasoningFor(useModel) : limits.reasoning)
          ? { reasoning: tier === "fast" ? fastReasoningFor(useModel) : limits.reasoning }
          : {}),
        ...(web ? { tools: [tier === "deep" ? DEEP_SEARCH : WEB_SEARCH], max_tool_calls: 2 } : {}),
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok)
      throw Object.assign(new Error(`main model ${res.status}`), { code: `http_${res.status}` });

    let text = "";
    let usage = null;
    let finishReason = null;
    let firstTokenMs = null;
    const sources = new Map();
    const take = (data) => {
      if (data.usage) usage = data.usage;
      finishReason = data.choices?.[0]?.finish_reason ?? finishReason;
      const delta = data.choices?.[0]?.delta;
      for (const a of delta?.annotations ?? [])
        if (a.type === "url_citation" && a.url_citation?.url)
          sources.set(a.url_citation.url, {
            url: a.url_citation.url,
            title: a.url_citation.title ?? "",
            snippet: String(a.url_citation.content ?? "").slice(0, 400), // what the card shows when a source is tapped
          });
      const piece = delta?.content;
      if (piece) {
        firstTokenMs ??= now() - t0;
        text += piece;
        onDelta?.(text);
      }
    };

    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue; // SSE comments (": OPENROUTER PROCESSING") and blanks
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const data = JSON.parse(payload);
          if (data.error)
            throw Object.assign(new Error(data.error.message ?? "stream error"), {
              code: "stream_error",
            });
          take(data);
        } catch (e) {
          if (e.code === "stream_error") throw e; // a malformed line is skipped
        }
      }
    }
    return {
      text,
      sources: [...sources.values()],
      usage,
      finishReason,
      firstTokenMs,
      totalMs: now() - t0,
    };
  };
  // OpenRouter answers 402 when the credits are reserved by requests still running (several web answers at once):
  // the balance is fine, so wait for them to settle and try once more.
  return async function withRetry(args) {
    try {
      return await attempt(args);
    } catch (e) {
      if (e.code !== "http_402" || args.signal?.aborted) throw e;
      await new Promise((r) => setTimeout(r, retry402Ms));
      return attempt(args);
    }
  };
}

module.exports = { createMainModel };
