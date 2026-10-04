/** Audit L6: server-supplied URLs reach `href` only when they are http(s); React does not block `javascript:`. */
export function safeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const u = new URL(value);
    // The original string is returned (not the normalised one); a leading space or control character would not start with the scheme.
    return (u.protocol === 'https:' || u.protocol === 'http:') && /^https?:/i.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
