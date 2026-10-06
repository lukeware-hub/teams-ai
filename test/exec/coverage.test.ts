import { describe, expect, it } from 'vitest';
import { coveragePasses, parseCoverageSummary } from '../../server/exec/coverage.js';

describe('parseCoverageSummary', () => {
  it('parses a valid summary', () => {
    expect(parseCoverageSummary('{"linesPct": 83.4}')).toEqual({ linesPct: 83.4 });
  });

  it('returns null on invalid JSON, wrong shape, non-numeric or missing linesPct', () => {
    expect(parseCoverageSummary('not json')).toBeNull();
    expect(parseCoverageSummary('[]')).toBeNull();
    expect(parseCoverageSummary('null')).toBeNull();
    expect(parseCoverageSummary('{"linesPct": "83"}')).toBeNull();
    expect(parseCoverageSummary('{}')).toBeNull();
    expect(parseCoverageSummary('{"linesPct": NaN}')).toBeNull();
  });
});

describe('coveragePasses', () => {
  it('passes at or above the floor, fails below it, and fails closed on no summary', () => {
    expect(coveragePasses({ linesPct: 80 })).toBe(true);
    expect(coveragePasses({ linesPct: 80.1 })).toBe(true);
    expect(coveragePasses({ linesPct: 79.9 })).toBe(false);
    expect(coveragePasses(null)).toBe(false);
  });

  it('honors a custom floor', () => {
    expect(coveragePasses({ linesPct: 50 }, 40)).toBe(true);
    expect(coveragePasses({ linesPct: 30 }, 40)).toBe(false);
  });
});
