// Everything tunable about the project-file search, in one place. Numbers were checked against OpenRouter
// (docs/copilot/RAG_PLAN.md): batch of 100 inputs, audio embedding up to ~180 s, video up to ~120 s.
const MB = 1024 * 1024;

const RAG = {
  embedModel: "google/gemini-embedding-2",
  analysisModel: "google/gemini-3.8-flash",
  dims: 768, // Matryoshka cut of the 3072 default: 4x smaller, same quality for this size of corpus
  embedBatch: 100, // API maximum per request
  embedConcurrency: 4,
  analysisConcurrency: 6, // calls to the reading model at once, across files
  filesAtOnce: 4,
  pdfPages: 12, // a PDF is read in parts of this many pages, side by side
  // text chunks
  chunkChars: 900,
  chunkOverlap: 120,
  minChunkChars: 160,
  // media windows (seconds)
  audioWindow: 60,
  audioOverlap: 10,
  videoWindow: 30,
  videoOverlap: 0,
  partSeconds: 600, // one analysis call reads this much audio/video
  mediaEmbedMinutes: 5, // per file: native audio/video embedding stops after this much, the rest is embedded as text (video costs ~$4/hour to embed)
  // retrieval
  fast: { k: 5, chars: 2800 },
  deep: { k: 10, chars: 7000 },
  floor: 0.58, // measured: relevant passages score 0.60-0.80, unrelated ones in the same domain 0.48-0.60
  margin: 0.05, // and a passage this far under the best one is not about the same thing
  autoScore: 0.69, // an unasked look at the files needs a match this close
  keywordFloor: 0.5, // an exact-word hit still needs at least this much closeness in meaning
  strongKeyword: 3, // an exact-term match this far from the top still counts without the embedding
  catalogFiles: 12,
  catalogChars: 420,
  queryCache: 64,
};

// kind -> limits. `maxChars` caps what gets indexed from text; `maxSeconds` caps media length.
const LIMITS = {
  text: { maxBytes: 5 * MB, maxChars: 1_200_000 },
  office: { maxBytes: 25 * MB, maxChars: 1_200_000 },
  pdf: { maxBytes: 25 * MB },
  image: { maxBytes: 10 * MB },
  audio: { maxBytes: 150 * MB, maxSeconds: 3 * 3600 },
  video: { maxBytes: 300 * MB, maxSeconds: 3600 },
  project: { maxBytes: 1024 * MB, maxChunks: 20000 },
};

const EXT = {
  text: [
    ".txt",
    ".md",
    ".markdown",
    ".csv",
    ".tsv",
    ".json",
    ".log",
    ".yaml",
    ".yml",
    ".html",
    ".htm",
    ".xml",
    ".rtf",
  ],
  office: [".docx", ".pptx", ".xlsx"],
  pdf: [".pdf"],
  image: [".png", ".jpg", ".jpeg", ".webp", ".gif"],
  audio: [".mp3", ".wav", ".m4a", ".ogg", ".flac", ".aac", ".opus"],
  video: [".mp4", ".mov", ".webm", ".mkv", ".m4v"],
};
const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".opus": "audio/ogg",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".m4v": "video/mp4",
  ".pdf": "application/pdf",
};

const extOf = (name) => (String(name).match(/\.[^./\\]+$/)?.[0] ?? "").toLowerCase();

// -> "text" | "office" | "pdf" | "image" | "audio" | "video" | null (not supported)
function classify(name) {
  const e = extOf(name);
  for (const [kind, list] of Object.entries(EXT)) if (list.includes(e)) return kind;
  return null;
}

// A file over its limit is listed with the reason instead of being dropped silently.
function checkSize(kind, bytes) {
  const lim = LIMITS[kind];
  if (!lim) return { ok: false, reason: "This file type is not supported yet." };
  if (bytes > lim.maxBytes)
    return {
      ok: false,
      reason: `Too big: ${Math.round(bytes / MB)} MB, the limit for this type is ${Math.round(lim.maxBytes / MB)} MB.`,
    };
  if (bytes === 0) return { ok: false, reason: "The file is empty." };
  return { ok: true };
}

module.exports = { RAG, LIMITS, EXT, MIME, classify, checkSize, extOf, MB };
