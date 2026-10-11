import { describe, expect, it } from 'vitest';
import { findCycle } from '../../server/contracts/plan.js';
import { makePlanTask } from '../fixtures/contracts.js';

describe('findCycle', () => {
  it('returns null for an acyclic graph', () => {
    expect(findCycle([makePlanTask({ id: 'T1-a' }), makePlanTask({ id: 'T2-b', dependsOn: ['T1-a'] })])).toBeNull();
  });

  it('uses the first occurrence when ids repeat', () => {
    expect(
      findCycle([makePlanTask({ id: 'T1-a', dependsOn: ['T2-b'] }), makePlanTask({ id: 'T2-b', dependsOn: ['T1-a'] }), makePlanTask({ id: 'T2-b' })]),
    ).toEqual(['T1-a', 'T2-b', 'T1-a']);
  });
});
