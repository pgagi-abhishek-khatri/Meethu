// Opt-in model-assisted feature summary generator (§8.2 & §12).
// Disabled by default (summaries.model: false). Runs only on already-redacted digests,
// caches by content hash for P8 determinism, and marks generated prose [auto].
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { postJson } = require("./openrouter");

const DEFAULT_SUMMARIZER_MODEL = "anthropic/claude-3.5-haiku";

function loadModelCache(cacheFile) {
  try {
    if (fs.existsSync(cacheFile)) {
      return JSON.parse(fs.readFileSync(cacheFile, "utf8")) || {};
    }
  } catch {}
  return {};
}

function saveModelCache(cacheFile, cache) {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf8");
    fs.renameSync(tmp, cacheFile);
  } catch {}
}

function buildFeatureDigest(feature) {
  const primaries = (feature.primary || [])
    .slice(0, 4)
    .map((p) => `${p.relPath} (${p.role}): ${p.purpose} [${(p.slices || []).slice(0, 4).join(", ")}]`)
    .join("\n");
  const contracts = (feature.contracts || [])
    .slice(0, 4)
    .map((c) => `${c.method} ${c.path}`)
    .join(", ");
  return [
    `Feature: ${feature.name}`,
    `Status: ${feature.status}`,
    primaries ? `Primary files:\n${primaries}` : "",
    contracts ? `Contracts: ${contracts}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function applyModelFeatureSummaries({
  features = [],
  model = false,
  apiKey = process.env.OPENROUTER_API_KEY || "",
  cacheDir = path.join(os.tmpdir(), "meethu-code-cache"),
  fetchImpl,
  maxFeatures = 12,
  log = () => {},
} = {}) {
  if (!model || !apiKey || features.length === 0) return { updated: 0 };
  const resolvedModel = typeof model === "string" && model.trim() ? model.trim() : DEFAULT_SUMMARIZER_MODEL;
  const cacheFile = path.join(cacheDir, "model_summaries.json");
  const cache = loadModelCache(cacheFile);

  let updated = 0;
  let cacheDirty = false;

  for (const feat of features.slice(0, maxFeatures)) {
    if (feat.source === "overridden") continue;
    const digest = buildFeatureDigest(feat);
    const hash = crypto.createHash("sha256").update(`${resolvedModel}\n${digest}`).digest("hex").slice(0, 20);
    if (cache[hash]) {
      feat.description = cache[hash];
      feat.confidence = "auto";
      updated += 1;
      continue;
    }

    try {
      const resp = await postJson(
        "/chat/completions",
        {
          model: resolvedModel,
          temperature: 0,
          max_tokens: 90,
          messages: [
            {
              role: "system",
              content: "Summarize what this software feature does in one plain, factual sentence (<= 160 chars). Never guess hidden behavior.",
            },
            { role: "user", content: digest },
          ],
        },
        { apiKey, fetchImpl, retries: 1, timeoutMs: 12000 }
      );
      const summary = String(resp?.choices?.[0]?.message?.content || "").replace(/\s+/g, " ").trim();
      if (summary) {
        cache[hash] = summary.slice(0, 200);
        cacheDirty = true;
        feat.description = cache[hash];
        feat.confidence = "auto";
        updated += 1;
      }
    } catch (err) {
      log({ event: "model_summary_fallback", feature: feat.id, error: err?.message || "error" });
    }
  }

  if (cacheDirty) saveModelCache(cacheFile, cache);
  return { updated, model: resolvedModel };
}

module.exports = {
  DEFAULT_SUMMARIZER_MODEL,
  buildFeatureDigest,
  applyModelFeatureSummaries,
};
