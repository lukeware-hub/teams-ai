import { describe, expect, it } from 'vitest';
import { jevGoals, meetsGoal, type Readiness } from '../../server/refine/readiness.js';

describe('meetsGoal', () => {
  it('a check passes when the percent shown for it reaches the goal, so a check shown as 80% is not listed as weak', () => {
    expect(meetsGoal(0.796)).toBe(true);
    expect(meetsGoal(0.794)).toBe(false);
    const readiness = {
      available: true,
      model: 'jev',
      average: 0.8,
      usage: null,
      outdated: false,
      skipped: false,
      docs: { 'project.md': { score: 0.8, checks: { complete: 0.796, concrete: 0.9, consistent: 0.9, scoped: 0.9 } } },
    } as unknown as Readiness;
    expect(jevGoals(readiness)).toEqual([]);
  });
});
