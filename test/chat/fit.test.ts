import { describe, expect, it } from 'vitest';
import { fit } from '../../server/chat/failures.js';

describe('fit', () => {
  const pointer = 'Detalhes completos: falhas/hello-001.md.';
  it('keeps the pointer inside the limit when lines are dropped', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `linha ${i} ${'x'.repeat(30)}`);
    const out = fit(lines, 300, pointer);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.endsWith(pointer)).toBe(true);
  });
  it('keeps every line when they all fit, with no pointer', () => {
    expect(fit(['a', 'b'], 300, pointer)).toBe('a\nb');
  });
});
