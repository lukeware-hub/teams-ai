import { describe, expect, it } from 'vitest';
import { withRenamedTypes } from '../../server/core/event-types.js';
import { taskPlanIds } from '../../server/contracts/plan.js';

describe('event type renames', () => {
  it('gives an event of a renamed type its current name, and leaves the others', () => {
    const rename = withRenamedTypes(new Map([['OLD', 'NEW']]));
    expect(rename({ type: 'OLD', data: { a: 1 } })).toEqual({ type: 'NEW', data: { a: 1 } });
    const other = { type: 'KEPT', data: {} };
    expect(rename(other)).toBe(other);
  });
});

describe('plan task ids', () => {
  it('reads the ids under the current name, and under the name before the rename', () => {
    expect(taskPlanIds({ planTasks: ['T1'] })).toEqual(['T1']);
    expect(taskPlanIds({ speckitTasks: ['T2'] })).toEqual(['T2']);
    expect(taskPlanIds({})).toEqual([]);
  });
});
