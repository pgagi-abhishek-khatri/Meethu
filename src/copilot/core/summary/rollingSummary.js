// Background rolling summary, so the decision model never has to read the old transcript.
// Only segments that have aged out of the raw window are folded in; the last few stay verbatim.
// The update runs off the decision path (never awaited by it) on a small cheap model.
//
// When the transcript grows faster than the summary can follow:
//   - a backlog is folded in CHUNKS (at most maxLinesPerCall lines per call), oldest first, and the
//     next chunk starts right away (catch-up) instead of waiting for the usual interval;
//   - a huge backlog (over maxBacklogSegments, e.g. after a long failure) leaves a GAP: only the
//     newest chunk is summarized, the older lines are skipped and the model is told so, because a
//     recent summary with a hole beats a stale one.
const { isBackchannel } = require("../transcript/utterances");

const DEFAULT_SUMMARY_CONFIG = {
  keepRaw: 15, // the newest 15 segments are never summarized: the models read them verbatim
  minSegments: 15, // fold in once 15 aged segments are waiting (one summary call per 15 new messages) ...
  minChars: Infinity, // ... (count only, not size)
  minIntervalMs: 0, // no time rule: the message count decides
  maxLinesPerCall: 24, // one call never reads more than this many lines ...
  maxCharsPerCall: 3000, // ... or this many characters
  maxBacklogSegments: 60, // more aged segments than this: skip the oldest ones (a gap)
  maxChain: 4, // catch-up calls in a row before waiting for the interval again
  maxWords: 300, // output cap: the whole summary rides along with the last ~20 lines
  failureBackoffMs: 60000,
};

const SYSTEM = `You keep a running summary of a live meeting for a silent assistant. Update the summary with the new lines. Keep EVERY topic discussed so far, each with its key points: who said what, positions, numbers, names, decisions, commitments, open questions. When space runs short, shorten old topics instead of dropping them. Drop only pleasantries, filler and repetition. Plain text, at most {words} words, no bullet points, no preamble. Speakers: USER is the person the assistant helps; OTHER-n are other participants.`;

function buildSummaryMessages(previous, lines, maxWords, skipped = 0) {
  const gap = skipped
    ? `\n(${skipped} earlier lines were skipped and are not covered. Do not guess about them.)`
    : "";
  return [
    { role: "system", content: SYSTEM.replace("{words}", String(maxWords)) },
    {
      role: "user",
      content: `Current summary:\n${previous || "(none yet)"}\n\nNew lines:${gap}\n${lines.join("\n")}\n\nUpdated summary:`,
    },
  ];
}

// Oldest lines first, up to the per-call limits (always at least one line).
function takeChunk(aged, cfg) {
  const chunk = [];
  let chars = 0;
  for (const s of aged) {
    if (
      chunk.length >= cfg.maxLinesPerCall ||
      (chunk.length && chars + s.text.length > cfg.maxCharsPerCall)
    )
      break;
    chunk.push(s);
    chars += s.text.length;
  }
  return chunk;
}

function createRollingSummary({ llm, label, cfg = DEFAULT_SUMMARY_CONFIG, now = Date.now }) {
  let text = "";
  let coveredUpToId = 0;
  let updating = false;
  let lastUpdateAt = -Infinity;
  let blockedUntil = 0;
  let chain = 0;
  let live = []; // the live transcript, re-read when a catch-up call follows another
  const stats = {
    updates: 0,
    failures: 0,
    lastMs: null,
    segmentsCovered: 0,
    chunks: 0,
    gaps: 0,
    segmentsSkipped: 0,
  };

  const aged = () =>
    live
      .slice(0, Math.max(0, live.length - cfg.keepRaw))
      .filter((s) => s.id > coveredUpToId && !isBackchannel(s.text)); // "Yeah." is not worth a summary token
  const enough = (list) =>
    list.length >= cfg.minSegments || list.reduce((n, s) => n + s.text.length, 0) >= cfg.minChars;

  function start(catchUp) {
    let waiting = aged();
    if (updating || now() < blockedUntil || !enough(waiting)) return null;
    if (!catchUp && now() - lastUpdateAt < cfg.minIntervalMs) return null;

    // Too far behind: keep only what fits one call from the newest end and remember the gap.
    let skipped = 0;
    if (waiting.length > cfg.maxBacklogSegments) {
      skipped = waiting.length - cfg.maxLinesPerCall;
      waiting = waiting.slice(-cfg.maxLinesPerCall);
    }
    const chunk = takeChunk(waiting, cfg);
    const upTo = chunk[chunk.length - 1].id;
    const started = now();
    updating = true;
    return llm({
      messages: buildSummaryMessages(
        text,
        chunk.map((s) => `${label(s)}: ${s.text}`),
        cfg.maxWords,
        skipped
      ),
    })
      .then((reply) => {
        const next = String(reply.text ?? "")
          .replace(/\s+/g, " ")
          .trim();
        if (!next) throw new Error("empty summary");
        text = next;
        coveredUpToId = upTo;
        stats.updates++;
        stats.chunks++;
        stats.segmentsCovered += chunk.length;
        if (skipped) {
          stats.gaps++;
          stats.segmentsSkipped += skipped;
        }
        stats.lastMs = now() - started;
        lastUpdateAt = now();
        return { text, covered: chunk.length, skipped };
      })
      .catch(() => {
        stats.failures++;
        blockedUntil = now() + cfg.failureBackoffMs;
        return null;
      })
      .finally(() => {
        updating = false;
      });
  }

  return {
    stats,
    get text() {
      return text;
    },
    get coveredUpToId() {
      return coveredUpToId;
    },
    // Returns the update promise when one starts (tests await it), else null. Never throws.
    // A successful chunk that leaves a backlog chains the next one at once, up to maxChain.
    maybeUpdate(transcript) {
      live = transcript;
      chain = 0;
      const first = start(false);
      if (!first) return null;
      const follow = async (promise) => {
        const result = await promise;
        if (result && ++chain < cfg.maxChain) {
          const more = start(true);
          if (more) return [result, ...(await follow(more))];
        }
        return result ? [result] : [];
      };
      return follow(first).then((results) => {
        const last = results[results.length - 1];
        return last
          ? {
              ...last,
              covered: results.reduce((n, r) => n + r.covered, 0),
              skipped: results.reduce((n, r) => n + r.skipped, 0),
              calls: results.length,
            }
          : null;
      });
    },
  };
}

// OpenRouter chat completions. Small, cheap, fast; no streaming needed.
// Reasoning models (DeepSeek v4.x) must have thinking switched off: with a small output cap they
// otherwise spend every token on reasoning and return an empty summary.
function createOpenRouterLlm({
  apiKey,
  model,
  baseUrl = "https://openrouter.ai/api/v1",
  timeoutMs = 15000,
  reasoningOff = /deepseek/i.test(model ?? ""),
  fetchImpl = fetch,
}) {
  return async function llm({ messages }) {
    if (!apiKey) throw new Error("no key");
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 650,
        temperature: 0.2,
        ...(reasoningOff ? { reasoning: { enabled: false } } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok)
      throw Object.assign(new Error(`summary model ${res.status}`), { status: res.status });
    const data = await res.json();
    return {
      text: data.choices?.[0]?.message?.content ?? "",
      tokens: data.usage?.total_tokens ?? null,
    };
  };
}

const DEFAULT_SUMMARY_MODEL = "deepseek/deepseek-v4.1-flash:nitro";

module.exports = {
  createRollingSummary,
  createOpenRouterLlm,
  DEFAULT_SUMMARY_CONFIG,
  DEFAULT_SUMMARY_MODEL,
  buildSummaryMessages,
};
