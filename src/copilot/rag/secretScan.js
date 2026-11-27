// Source files and generated summaries may be viewed on screen or sent to an answer model.
// High-confidence secret shapes, connection strings, URL credentials, and PII are replaced with typed placeholders.
const REDACTED = "[REDACTED]";

const TYPED_PATTERNS = [
  {
    type: "private_key",
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  { type: "aws_key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: "github_token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { type: "github_token", re: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g },
  { type: "api_key", re: /\bsk-(?:or-v1-|proj-|ant-[a-z0-9]+-)?[A-Za-z0-9_-]{20,}\b/g },
  { type: "slack_token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { type: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  {
    type: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
];

// Connection strings & embedded URL passwords: scheme://user:password@host
const URL_CREDENTIAL_RE =
  /\b((?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps|mssql|https?):\/\/[^:\s/@"']+:)(?!\[REDACTED)([^\s/@"']{3,})(@[^\s"'`<>]+)/gi;

// key = "long literal": only the literal is replaced, the name stays so the code still reads.
const ASSIGNED_RE =
  /((?:api[_-]?key|secret|token|passwd|password|private[_-]?key|client[_-]?secret|access[_-]?key|auth[_-]?token)["']?\s*[:=]\s*["'])(?!\[REDACTED)([^"'\s]{12,})(["'])/gi;

// Quoted high-entropy secret literal (e.g. hex/base64 token >= 28 chars without spaces/slashes)
const QUOTED_LITERAL_RE = /(["'])([A-Za-z0-9+/=_-]{28,})\1/g;

function shannonEntropy(str) {
  const counts = new Map();
  for (const ch of str) counts.set(ch, (counts.get(ch) || 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / str.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function looksLikeCodeOrPath(s) {
  if (/^(?:[A-Z0-9]+_)+[A-Z0-9]+$/.test(s)) return true; // SCREAMING_SNAKE_CASE constant
  if (/^(?:[a-z]+_)+[a-z]+$/.test(s)) return true; // snake_case identifier
  if (/^(?:[a-z][a-zA-Z0-9]*){2,}$/.test(s) && !/[0-9]/.test(s)) return true; // pure camelCase words
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true; // UUID
  if (/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/i.test(s)) return true; // SRI integrity digest
  if (/^M[\d.,\s-]+[ZzLlHhVvCcSsQqTtAa\d.,\s-]*$/.test(s)) return true; // SVG path data
  if (/^\[REDACTED/.test(s)) return true;
  return false;
}

function lineNumberAt(text, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function redactSecrets(input, { extraPatterns = [], includeHighEntropy = true, includePii = false } = {}) {
  let count = 0;
  const types = {};
  const locations = [];
  const rawInput = String(input ?? "");
  const record = (type, line) => {
    count += 1;
    types[type] = (types[type] || 0) + 1;
    if (locations.length < 30) locations.push({ type, line });
    return `[REDACTED:${type}]`;
  };

  let text = rawInput;
  for (const { type, re } of TYPED_PATTERNS) {
    text = text.replace(re, (...args) => record(type, lineNumberAt(text, args[args.length - 2])));
  }
  for (const raw of Array.isArray(extraPatterns) ? extraPatterns : []) {
    try {
      const re = raw instanceof RegExp ? new RegExp(raw.source, raw.flags.includes("g") ? raw.flags : `${raw.flags}g`) : new RegExp(String(raw), "g");
      text = text.replace(re, (...args) => record("custom", lineNumberAt(text, args[args.length - 2])));
    } catch {
      // invalid custom regex is ignored safely
    }
  }
  text = text.replace(URL_CREDENTIAL_RE, (_m, head, _secret, tail, offset) => `${head}${record("conn_string", lineNumberAt(text, offset))}${tail}`);
  text = text.replace(ASSIGNED_RE, (_m, head, _secret, tail, offset) => `${head}${record("assigned_secret", lineNumberAt(text, offset))}${tail}`);

  if (includeHighEntropy) {
    text = text.replace(QUOTED_LITERAL_RE, (m, q, body, offset) => {
      if (looksLikeCodeOrPath(body)) return m;
      const lineIdx = text.lastIndexOf("\n", offset) + 1;
      const lineStr = text.slice(lineIdx, offset).toLowerCase();
      // Skip 32/40/64-char hex unless key/secret/token context is present on same line (avoids SHA/UUID false positives)
      const isHex = /^[0-9a-f]{32,}$/i.test(body);
      const hasSecretHint = /(?:secret|token|key|pass|auth|credential|bearer|private)/i.test(lineStr);
      const hasDigit = /[0-9]/.test(body);
      const hasUpper = /[A-Z]/.test(body);
      const hasLower = /[a-z]/.test(body);
      if (
        (!isHex && hasDigit && hasUpper && hasLower && shannonEntropy(body) >= 4.4) ||
        (isHex && shannonEntropy(body) >= 3.4 && (hasSecretHint || body.length === 64))
      ) {
        return `${q}${record("high_entropy", lineNumberAt(text, offset))}${q}`;
      }
      return m;
    });
  }

  if (includePii) {
    text = text.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, (_m, offset) => record("pii_email", lineNumberAt(text, offset)));
    text = text.replace(/\b(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g, (_m, offset) => record("pii_phone", lineNumberAt(text, offset)));
  }

  return { text, count, types, locations, hasRedactions: count > 0 };
}

function sanitizeRemoteUrl(url) {
  if (!url || typeof url !== "string") return "";
  return url
    .trim()
    .replace(/(https?:\/\/)([^:@\s]+):([^@\s]+)@/gi, "$1[REDACTED]@")
    .replace(/(https?:\/\/)([A-Za-z0-9_.-]{16,})@/gi, "$1[REDACTED]@");
}

module.exports = {
  redactSecrets,
  sanitizeRemoteUrl,
  REDACTED,
  TYPED_PATTERNS,
};
