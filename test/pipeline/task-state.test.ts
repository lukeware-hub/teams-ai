import { describe, expect, it } from 'vitest';
import {
  ACTIVE_STATES,
  InvalidTransitionError,
  TERMINAL_STATES,
  assertTransition,
  canTransition,
} from '../../server/pipeline/task-state.js';

describe('task state machine', () => {
  it('allows the happy path', () => {
    const path = ['planned', 'ready', 'implementing', 'validating', 'reviewing', 'rebasing', 'merging', 'merged'] as const;
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it('allows returning to implementing after a failed gate, review or rebase', () => {
    expect(canTransition('validating', 'implementing')).toBe(true);
    expect(canTransition('reviewing', 'implementing')).toBe(true);
    expect(canTransition('rebasing', 'implementing')).toBe(true);
  });

  it('allows merging to return to rebasing when main moved', () => {
    expect(canTransition('merging', 'rebasing')).toBe(true);
  });

  it('allows a planned task to be adopted as merged (R11.4: a retry inherits what an earlier run of the same spec already merged)', () => {
    expect(canTransition('planned', 'merged')).toBe(true);
  });

  it('forbids skipping review', () => {
    expect(canTransition('validating', 'merging')).toBe(false);
    expect(() => assertTransition('validating', 'merging')).toThrow(InvalidTransitionError);
  });

  it('treats merged, blocked and superseded as terminal', () => {
    for (const state of ['merged', 'blocked', 'superseded'] as const) {
      expect(TERMINAL_STATES.has(state)).toBe(true);
      expect(canTransition(state, 'ready')).toBe(false);
    }
  });

  it('does not allow superseding a task that is merging', () => {
    expect(canTransition('merging', 'superseded')).toBe(false);
  });

  it('marks in-flight states as active', () => {
    expect([...ACTIVE_STATES].sort()).toEqual(['implementing', 'merging', 'rebasing', 'reviewing', 'validating']);
  });
});
