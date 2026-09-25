import { createHash } from 'node:crypto';

export { HASH_PATTERN } from './patterns.js';

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const child = source[key];
      if (child !== undefined) out[key] = sortKeys(child);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}
