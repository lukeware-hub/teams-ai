import { describe, expect, it } from 'vitest';
import { stackSmokeProblems } from '../../scripts/smoke/stacks.js';

const row = (acIds: string[], status: 'passed' | 'failed') => ({ id: acIds.join(), name: acIds.join(), classname: 'c', status, acIds });

describe('stackSmokeProblems', () => {
  it('is empty when every criterion has a passing test', () => {
    expect(stackSmokeProblems([row(['AC-001'], 'passed'), row(['AC-002'], 'passed')], ['AC-001', 'AC-002'])).toEqual([]);
  });

  it('names a missing criterion and a failing one', () => {
    expect(stackSmokeProblems([row(['AC-001'], 'failed')], ['AC-001', 'AC-002'])).toEqual(['AC-001 did not pass (failed)', 'no test names AC-002']);
  });
});
