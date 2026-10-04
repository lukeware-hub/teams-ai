/**
 * Redaction for text that leaves the execution boundary (event store, UI, reports). Spec §14:
 * secret values are injected only into containers and never displayed. Two layers: every known
 * secret value is replaced verbatim, and well-known credential shapes are masked even when the
 * value was not registered (a token echoed by a tool, a `KEY=value` line in stderr).
 */
export const REDACTED = '[REDACTED]';

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-or-v1-[A-Za-z0-9]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g,
  /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTH))=([^\s'"]+)/g,
  /([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)([^\s@/]+)@/gi,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  // Key/value shapes in any case or format: `password: x`, `"api_key":"x"`, `x-api-key=x`.
  /((?:token|secret|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key)["']?\s*[:=]\s*["']?)([^\s'",;&]{6,})/gi,
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Below this length a value is masked only as a whole token, so a 3-character secret does not shred ordinary words. */
const WHOLE_TOKEN_BELOW = 8;
const MIN_KNOWN = 3;

/**
 * Base64 of a value as it appears inside a longer base64 string: the three byte alignments, standard and
 * URL-safe, without the characters that depend on neighbouring bytes (leading pad bits, trailing partial group).
 */
function base64Forms(value: string): string[] {
  const buf = Buffer.from(value, 'utf8');
  const out: string[] = [];
  for (const k of [0, 1, 2]) {
    let body = Buffer.concat([Buffer.alloc(k), buf]).toString('base64').replace(/=+$/, '');
    if ((k + buf.length) % 3 !== 0) body = body.slice(0, -1);
    body = body.slice([0, 2, 3][k]!);
    if (body.length >= 8) out.push(body, body.replace(/\+/g, '-').replace(/\//g, '_'));
  }
  return out;
}

/** The value as written plus its URL-encoded and base64 forms (audit L5). */
function forms(value: string): string[] {
  const encoded = encodeURIComponent(value);
  return [value, ...(encoded !== value ? [encoded] : []), ...(value.length >= 6 ? base64Forms(value) : [])];
}

export function redactSecrets(text: string, knownValues: readonly string[] = []): string {
  let out = text;
  // Longest first so a secret that contains another is masked whole.
  const values = [...new Set(knownValues.filter((v) => v.length >= MIN_KNOWN).flatMap(forms))].sort((a, b) => b.length - a.length);
  for (const value of values) {
    const body = escapeRegExp(value);
    out = out.replace(new RegExp(value.length < WHOLE_TOKEN_BELOW ? `(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])` : body, 'g'), REDACTED);
  }
  out = out.replace(CREDENTIAL_PATTERNS[0]!, REDACTED);
  out = out.replace(CREDENTIAL_PATTERNS[1]!, REDACTED);
  out = out.replace(CREDENTIAL_PATTERNS[2]!, REDACTED);
  out = out.replace(CREDENTIAL_PATTERNS[3]!, REDACTED);
  out = out.replace(CREDENTIAL_PATTERNS[4]!, REDACTED);
  out = out.replace(CREDENTIAL_PATTERNS[5]!, `$1 ${REDACTED}`);
  out = out.replace(CREDENTIAL_PATTERNS[6]!, `$1=${REDACTED}`);
  out = out.replace(CREDENTIAL_PATTERNS[7]!, `$1${REDACTED}@`);
  for (const pattern of CREDENTIAL_PATTERNS.slice(8, 13)) out = out.replace(pattern, REDACTED);
  out = out.replace(CREDENTIAL_PATTERNS[13]!, REDACTED);
  out = out.replace(CREDENTIAL_PATTERNS[14]!, `$1${REDACTED}`);
  return out;
}
