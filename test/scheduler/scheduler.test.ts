import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_PARALLEL, nextRunnable, runProgress, tasksToBlock } from '../../server/scheduler/scheduler.js';
import { runState, runtime, withStatus } from '../fixtures/run-state.js';

describe('nextRunnable', () => {
  it('defaults to three parallel tasks', () => {
    expect(DEFAULT_MAX_PARALLEL).toBe(3);
    const state = runState(runtime({ id: 'T1-a' }), runtime({ id: 'T2-b' }), runtime({ id: 'T3-c' }), runtime({ id: 'T4-d' }));
    expect(nextRunnable(state)).toEqual(['T1-a', 'T2-b', 'T3-c']);
  });

  it('waits until every dependency is merged', () => {
    const waiting = runState(runtime({ id: 'T1-a' }, 'reviewing'), runtime({ id: 'T2-b', dependsOn: ['T1-a'] }));
    expect(nextRunnable(waiting, 3)).toEqual([]);
    const done = runState(runtime({ id: 'T1-a' }, 'merged'), runtime({ id: 'T2-b', dependsOn: ['T1-a'] }));
    expect(nextRunnable(done, 3)).toEqual(['T2-b']);
  });

  it('serializes tasks whose affected paths overlap', () => {
    const state = runState(
      runtime({ id: 'T1-a', affectedPaths: ['src/user/**'] }),
      runtime({ id: 'T2-b', affectedPaths: ['src/user/service.ts'] }),
      runtime({ id: 'T3-c', affectedPaths: ['src/order/**'] }),
    );
    expect(nextRunnable(state, 3)).toEqual(['T1-a', 'T3-c']);
  });

  it('counts active tasks against slots and their paths as claimed', () => {
    const state = runState(
      runtime({ id: 'T1-a', affectedPaths: ['src/user/**'] }, 'implementing'),
      runtime({ id: 'T2-b', affectedPaths: ['src/order/**'] }, 'merging'),
      runtime({ id: 'T3-c', affectedPaths: ['src/user/model.ts'] }),
      runtime({ id: 'T4-d', affectedPaths: ['src/billing/**'] }),
      runtime({ id: 'T5-e', affectedPaths: ['src/report/**'] }),
    );
    expect(nextRunnable(state, 3)).toEqual(['T4-d']);
  });

  it('never picks terminal tasks', () => {
    const state = runState(runtime({ id: 'T1-a' }, 'blocked'), runtime({ id: 'T2-b' }, 'superseded'), runtime({ id: 'T3-c' }, 'merged'));
    expect(nextRunnable(state, 3)).toEqual([]);
  });

  it('starts nothing while the run is paused or draining', () => {
    const state = runState(runtime({ id: 'T1-a' }));
    expect(nextRunnable(withStatus(state, 'paused:quota'), 3)).toEqual([]);
    expect(nextRunnable(withStatus(state, 'paused:auth'), 3)).toEqual([]);
    expect(nextRunnable(withStatus(state, 'draining'), 3)).toEqual([]);
  });

  it('rejects a non-positive maxParallel', () => {
    expect(() => nextRunnable(runState(runtime({ id: 'T1-a' })), 0)).toThrow(RangeError);
  });
});

describe('tasksToBlock', () => {
  it('propagates blocked dependencies transitively', () => {
    const state = runState(
      runtime({ id: 'T1-a' }, 'blocked'),
      runtime({ id: 'T2-b', dependsOn: ['T1-a'] }),
      runtime({ id: 'T3-c', dependsOn: ['T2-b'] }),
      runtime({ id: 'T4-d' }),
    );
    expect(tasksToBlock(state).sort()).toEqual(['T2-b', 'T3-c']);
  });

  it('blocks tasks that depend on unknown tasks', () => {
    expect(tasksToBlock(runState(runtime({ id: 'T2-b', dependsOn: ['T9-missing'] })))).toEqual(['T2-b']);
  });

  it('blocks tasks that still depend on a superseded task', () => {
    const state = runState(runtime({ id: 'T1-a' }, 'superseded', { replacedBy: ['T3-r'] }), runtime({ id: 'T3-r' }), runtime({ id: 'T2-b', dependsOn: ['T1-a'] }));
    expect(tasksToBlock(state)).toEqual(['T2-b']);
  });
});

describe('runProgress', () => {
  it('is complete when every task is terminal', () => {
    const state = runState(runtime({ id: 'T1-a' }, 'merged'), runtime({ id: 'T2-b' }, 'blocked'));
    expect(runProgress(state, 3)).toBe('complete');
  });

  it('is running while work is active or startable', () => {
    expect(runProgress(runState(runtime({ id: 'T1-a' }, 'implementing')), 3)).toBe('running');
    expect(runProgress(runState(runtime({ id: 'T1-a' })), 3)).toBe('running');
  });

  it('is running while paused, so the pause is not mistaken for a deadlock', () => {
    expect(runProgress(withStatus(runState(runtime({ id: 'T1-a' })), 'paused:quota'), 3)).toBe('running');
  });

  it('ends the run when everything left depends on blocked tasks', () => {
    const state = runState(runtime({ id: 'T1-a' }, 'blocked'), runtime({ id: 'T2-b', dependsOn: ['T1-a'] }));
    const toBlock = tasksToBlock(state);
    expect(toBlock).toEqual(['T2-b']);
    for (const id of toBlock) state.tasks.get(id)!.state = 'blocked';
    expect(runProgress(state, 3)).toBe('complete');
  });

  it('counts tasks doomed by a blocked dependency as blocked before the caller applies them', () => {
    const state = runState(runtime({ id: 'T1-a' }, 'blocked'), runtime({ id: 'T2-b', dependsOn: ['T1-a'] }));
    expect(runProgress(state, 3)).toBe('complete');
    const withWork = runState(runtime({ id: 'T1-a' }, 'blocked'), runtime({ id: 'T2-b', dependsOn: ['T1-a'] }), runtime({ id: 'T3-c' }));
    expect(runProgress(withWork, 3)).toBe('running');
  });

  it('is deadlocked when nothing can ever start', () => {
    const cycle = runState(runtime({ id: 'T1-a', dependsOn: ['T2-b'] }), runtime({ id: 'T2-b', dependsOn: ['T1-a'] }));
    expect(runProgress(cycle, 3)).toBe('deadlocked');
  });
});

describe('runProgress while draining', () => {
  it('reports drained once nothing is active, so the run can go to the report', () => {
    const idle = withStatus(runState(runtime({ id: 'T1-a' }), runtime({ id: 'T2-b' }, 'merged')), 'draining');
    expect(runProgress(idle, 3)).toBe('drained');
    const busy = withStatus(runState(runtime({ id: 'T1-a' }, 'implementing')), 'draining');
    expect(runProgress(busy, 3)).toBe('running');
  });
});
