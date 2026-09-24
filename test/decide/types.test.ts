import { describe, expect, it } from 'vitest';
import { answerConfidence, minConfidence, noulConfidence, scoreConfidence } from '../../server/decide/types.js';

describe('confidence helpers', () => {
  it('noul confidence is the certainty of either answer', () => {
    expect(noulConfidence(0.98)).toBeCloseTo(0.98);
    expect(noulConfidence(0.02)).toBeCloseTo(0.98);
    expect(noulConfidence(0.5)).toBeCloseTo(0.5);
  });

  it('score confidence is 1 for a single-level distribution and 0 for a uniform one', () => {
    expect(scoreConfidence({ '0': 1, '1': 0, '2': 0 })).toBeCloseTo(1);
    expect(scoreConfidence({ '0': 1 / 3, '1': 1 / 3, '2': 1 / 3 })).toBeCloseTo(0);
    expect(scoreConfidence({ '0': 1 })).toBe(1);
    expect(scoreConfidence({ '0': 0.05, '1': 0.9, '2': 0.05 })).toBeGreaterThan(0.6);
  });

  it('answer confidence reads the field and treats null as zero', () => {
    expect(answerConfidence({ type: 'choice', value: 'a', probabilities: { a: 0.9, b: 0.1 }, confidence: 0.9 })).toBe(0.9);
    expect(answerConfidence({ type: 'noul', value: 0.7, probabilities: { yes: 0.7, no: 0.3 }, confidence: null })).toBe(0);
  });

  it('min confidence is the weakest answer, zero for no answers', () => {
    expect(
      minConfidence({
        a: { type: 'choice', value: 'x', probabilities: { x: 0.95 }, confidence: 0.95 },
        b: { type: 'noul', value: 0.6, probabilities: { yes: 0.6, no: 0.4 }, confidence: 0.6 },
      }),
    ).toBe(0.6);
    expect(minConfidence({})).toBe(0);
  });
});
