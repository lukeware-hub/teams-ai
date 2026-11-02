import { describe, expect, it } from 'vitest';
import { fixTasksOutcome } from '../../server/orchestrator/run.js';
import type { RunState } from '../../server/pipeline/run-state.js';

const state = (...states: string[]) => ({ tasks: new Map(states.map((s, i) => [`T${i}`, { state: s }])) }) as unknown as RunState;

describe('fixTasksOutcome', () => {
  it('goes on when a fix task was replanned and its replacement merged', () => {
    expect(fixTasksOutcome(state('merged', 'superseded', 'merged'))).toBe('merged');
  });

  it('blocks when any task is blocked', () => {
    expect(fixTasksOutcome(state('merged', 'merged', 'blocked'))).toBe('blocked');
  });
});
