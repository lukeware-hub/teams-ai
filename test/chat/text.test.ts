import { describe, expect, it } from 'vitest';
import { clip, withoutCodes } from '../../server/chat/text.js';

describe('clip', () => {
  it('leaves a short text as it is', () => {
    expect(clip('curto', 20)).toBe('curto');
  });

  it('keeps the head and the tail, marks what it left out, and never goes past the limit', () => {
    const out = clip(`${'a'.repeat(500)}FIM`, 200);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.startsWith('aaa')).toBe(true);
    expect(out.endsWith('FIM')).toBe(true);
    expect(out).toContain('caracteres omitidos');
  });
});

describe('withoutCodes and web addresses', () => {
  it('keeps an address whole, even when it holds something that looks like a code', () => {
    expect(withoutCodes('veja https://example.com/docs/T5-setup e o teste (AC-001)')).toBe('veja https://example.com/docs/T5-setup e o teste');
  });
});
