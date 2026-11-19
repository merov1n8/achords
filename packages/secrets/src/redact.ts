export const REDACTED = "[REDACTED]";

// Known values shorter than this would redact ordinary words.
const MIN_KNOWN_LENGTH = 8;

// Well-known credential shapes. Order matters: specific patterns before generic ones.
const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, // Telegram bot token
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /(?<=\bBearer\s+)[A-Za-z0-9._~+/-]{20,}=*/g,
];

// key=value / key: value where the key name says it is a secret. Only the value is replaced.
const ASSIGNMENT =
  /(\b[A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|pwd)[A-Za-z0-9_.-]*\b\s*[:=]\s*["']?)([^\s"']{8,})/gi;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Returns a function that removes known secret values and credential-shaped strings. */
export function createRedactor(known: Iterable<string>): (text: string) => string {
  const values = [...new Set(known)]
    .filter((v) => v.length >= MIN_KNOWN_LENGTH)
    .sort((a, b) => b.length - a.length);
  const knownPattern = values.length ? new RegExp(values.map(escapeRegExp).join("|"), "g") : null;

  return (text) => {
    let out = knownPattern ? text.replace(knownPattern, REDACTED) : text;
    for (const p of PATTERNS) out = out.replace(p, REDACTED);
    return out.replace(ASSIGNMENT, (_m, key: string, value: string) =>
      value === REDACTED ? `${key}${value}` : `${key}${REDACTED}`,
    );
  };
}
