// Thin client for a D1 System One endpoint (OpenRouter or Liquid direct). No retries: a late decision is
// worth less than none, and the caller fails quiet. The key never leaves main.
const ERROR = {
  NO_KEY: "no_key",
  TIMEOUT: "timeout",
  HTTP: "http",
  NETWORK: "network",
  BAD_BODY: "bad_body",
};

function createLiquidClient({ apiKey, url, model, timeoutMs, fetchImpl = fetch }) {
  async function systemOne({ state, questions, images, signal }) {
    if (!apiKey) throw Object.assign(new Error("No decision API key"), { code: ERROR.NO_KEY });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    signal?.addEventListener("abort", () => controller.abort(), { once: true });
    const started = performance.now();
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        // OpenRouter rejects a top-level `images`: pictures ride in `state`, which becomes an array.
        body: JSON.stringify({
          model,
          state: images?.length
            ? [state, ...images.map((url) => ({ type: "image_url", image_url: { url } }))]
            : state,
          questions,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw Object.assign(new Error(`Liquid ${res.status}: ${detail.slice(0, 160)}`), {
          code: ERROR.HTTP,
          status: res.status,
        });
      }
      const body = await res.json().catch(() => null);
      if (!body?.answers)
        throw Object.assign(new Error("Liquid response had no answers"), { code: ERROR.BAD_BODY });
      return {
        answers: body.answers,
        inputTokens: body.usage?.input_tokens ?? null,
        ms: performance.now() - started,
      };
    } catch (error) {
      if (error.code) throw error;
      throw Object.assign(error, {
        code: controller.signal.aborted ? ERROR.TIMEOUT : ERROR.NETWORK,
      });
    } finally {
      clearTimeout(timer);
    }
  }
  return { systemOne };
}

module.exports = { createLiquidClient, ERROR };
