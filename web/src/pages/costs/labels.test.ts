import { describe, expect, it } from 'vitest';
import { KIND_LABEL, PHASE_LABEL, labelOf } from './labels.js';

describe('cost labels', () => {
  it('names the docs phase and its step kind, so the panel never shows a raw key', () => {
    expect(labelOf(PHASE_LABEL, 'phase8')).toBe('Documentação');
    expect(labelOf(KIND_LABEL, 'docs')).toBe('Documentação');
  });
});
