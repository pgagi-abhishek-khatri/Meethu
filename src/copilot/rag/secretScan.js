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
  if (/^\[REDACTED/.test(s)) return true;
  return false;
}

function redactSecrets(input, { extraPatterns = [], includeHighEntropy = true, includePii = false } = {}) {
  let count = 0;
  const types = {};
  const bump = (type) => {
    count += 1;
    types[type] = (types[type] || 0) + 1;
    return `[REDACTED:${type}]`;
  };

  let text = String(input ?? "");
  for (const { type, re } of TYPED_PATTERNS) {
    text = text.replace(re, () => bump(type));
  }
  for (const raw of Array.isArray(extraPatterns) ? extraPatterns : []) {
    try {
      const re = raw instanceof RegExp ? new RegExp(raw.source, raw.flags.includes("g") ? raw.flags : `${raw.flags}g`) : new RegExp(String(raw), "g");
      text = text.replace(re, () => bump("custom"));
    } catch {
      // invalid custom regex is ignored safely
    }
  }
  text = text.replace(URL_CREDENTIAL_RE, (_m, head, _secret, tail) => `${head}${bump("conn_string")}${tail}`);
  text = text.replace(ASSIGNED_RE, (_m, head, _secret, tail) => `${head}${bump("assigned_secret")}${tail}`);

  if (includeHighEntropy) {
    text = text.replace(QUOTED_LITERAL_RE, (m, q, body) => {
      if (looksLikeCodeOrPath(body)) return m;
      const hasDigit = /[0-9]/.test(body);
      const hasUpper = /[A-Z]/.test(body);
      const hasLower = /[a-z]/.test(body);
      if ((hasDigit && (hasUpper || hasLower) && shannonEntropy(body) >= 4.2) || (/^[0-9a-f]{32,}$/i.test(body) && shannonEntropy(body) >= 3.4)) {
        return `${q}${bump("high_entropy")}${q}`;
      }
      return m;
    });
  }

  if (includePii) {
    text = text.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, () => bump("pii_email"));
    text = text.replace(/\b(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g, () => bump("pii_phone"));
  }

  return { text, count, types, hasRedactions: count > 0 };
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
