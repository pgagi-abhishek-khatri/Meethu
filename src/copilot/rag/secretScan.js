// Source files are sent onward (embedding and answer models). A credential pasted into code must not travel with them,
// so high-confidence shapes are replaced in place: the file stays searchable, the secret does not.
const REDACTED = "[REDACTED]";

const PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\bsk-(?:or-v1-|proj-|ant-[a-z0-9]+-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];
// key = "long literal": only the literal is replaced, the name stays so the code still reads.
const ASSIGNED =
  /((?:api[_-]?key|secret|token|passwd|password|private[_-]?key)["']?\s*[:=]\s*["'])([^"'\s]{12,})(["'])/gi;

function redactSecrets(input) {
  let count = 0;
  let text = String(input ?? "");
  for (const re of PATTERNS) {
    text = text.replace(re, () => {
      count += 1;
      return REDACTED;
    });
  }
  text = text.replace(ASSIGNED, (_m, head, _secret, tail) => {
    count += 1;
    return `${head}${REDACTED}${tail}`;
  });
  return { text, count };
}

module.exports = { redactSecrets, REDACTED };
