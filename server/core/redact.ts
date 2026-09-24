/**
 * Redaction for text that leaves the execution boundary (event store, UI, reports). Spec §14:
 * secret values are injected only into containers and never displayed. Two layers: every known
 * secret value is replaced verbatim, and well-known credential shapes are masked even when the
 * value was not registered (a token echoed by a tool, a `KEY=value` line in stderr).
 */
export const REDACTED = '[REDACTED]';

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g,
  /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTH))=([^\s'"]+)/g,
  /([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)([^\s@/]+)@/gi,
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redactSecrets(text: string, knownValues: readonly string[] = []): string {
  let out = text;
  // Longest first so a secret that contains another is masked whole.
  const values = [...new Set(knownValues.filter((v) => v.length >= 4))].sort((a, b) => b.length - a.length);
  for (const value of values) out = out.replace(new RegExp(escapeRegExp(value), 'g'), REDACTED);
  out = out.replace(CREDENTIAL_PATTERNS[0]!, REDACTED);
  out = out.replace(CREDENTIAL_PATTERNS[1]!, REDACTED);
  out = out.replace(CREDENTIAL_PATTERNS[2]!, REDACTED);
  out = out.replace(CREDENTIAL_PATTERNS[3]!, REDACTED);
  out = out.replace(CREDENTIAL_PATTERNS[4]!, `$1 ${REDACTED}`);
  out = out.replace(CREDENTIAL_PATTERNS[5]!, `$1=${REDACTED}`);
  out = out.replace(CREDENTIAL_PATTERNS[6]!, `$1${REDACTED}@`);
  return out;
}
