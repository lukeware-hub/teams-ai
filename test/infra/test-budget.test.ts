import { describe, expect, it } from 'vitest';
import { budgetOf } from '../../scripts/test-budget.js';

const file = (name: string, startS: number, endS: number) => ({ name: `/repo/test/${name}`, startTime: startS * 1000, endTime: endS * 1000 });

describe('the test time budget', () => {
  it('reports the slowest files and the whole run from the first start to the last end', () => {
    const budget = budgetOf([file('a.test.ts', 0, 10), file('b.test.ts', 5, 60), file('c.test.ts', 2, 20)], { fileS: 60, suiteS: 480 });
    expect(budget.suiteS).toBe(60);
    expect(budget.slowest[0]).toEqual({ name: 'b.test.ts', s: 55 });
    expect(budget.problems).toEqual([]);
  });

  it('flags a file over its limit and a run over the suite limit', () => {
    const budget = budgetOf([file('slow.test.ts', 0, 90), file('quick.test.ts', 0, 10)], { fileS: 60, suiteS: 80 });
    expect(budget.problems).toEqual(['slow.test.ts took 90 s, over 60 s', 'the suite took 90 s, over 80 s']);
  });

  it('is empty for a report with no test files', () => {
    expect(budgetOf([])).toEqual({ suiteS: 0, slowest: [], problems: [] });
  });
});
