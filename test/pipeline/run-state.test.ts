import { describe, expect, it } from 'vitest';
import {
  DuplicateTaskError,
  ReplanError,
  RunEvent,
  UnknownTaskError,
  reduceEvents,
  type ReducibleEvent,
} from '../../server/pipeline/run-state.js';
import { InvalidTransitionError } from '../../server/pipeline/task-state.js';
import { makePlanTask } from '../fixtures/contracts.js';

const planned = (id: string, dependsOn: string[] = []): ReducibleEvent => ({
  type: RunEvent.TaskPlanned,
  data: { task: makePlanTask({ id, dependsOn }) },
});
const moved = (taskId: string, to: string): ReducibleEvent => ({
  type: RunEvent.TaskStateChanged,
  data: { taskId, to },
});
const replan = (taskId: string, ...replacements: ReturnType<typeof makePlanTask>[]): ReducibleEvent => ({
  type: RunEvent.TaskReplanned,
  data: { taskId, replacements },
});

describe('reduceEvents', () => {
  it('starts running and builds tasks in plan order with initial counters', () => {
    const state = reduceEvents([planned('T1-a'), planned('T2-b')]);
    expect(state.status).toBe('running');
    expect(state.order).toEqual(['T1-a', 'T2-b']);
    expect(state.tasks.get('T1-a')).toMatchObject({ state: 'planned', attempts: 0, replanned: false });
  });

  it('applies valid transitions and rejects invalid ones', () => {
    const state = reduceEvents([planned('T1-a'), moved('T1-a', 'ready'), moved('T1-a', 'implementing')]);
    expect(state.tasks.get('T1-a')!.state).toBe('implementing');
    // 'merged' is a legitimate adoption from 'planned' (R11.4 retry); 'reviewing' is not a valid jump from 'planned'.
    expect(() => reduceEvents([planned('T1-a'), moved('T1-a', 'reviewing')])).toThrow(InvalidTransitionError);
  });

  it('counts attempts and per-gate retries', () => {
    const state = reduceEvents([
      planned('T1-a'),
      { type: RunEvent.AttemptConsumed, data: { taskId: 'T1-a' } },
      { type: RunEvent.AttemptConsumed, data: { taskId: 'T1-a' } },
      { type: RunEvent.InfraRetry, data: { taskId: 'T1-a', gate: 'unit-test' } },
      { type: RunEvent.FlakyRetry, data: { taskId: 'T1-a', gate: 'unit-test' } },
    ]);
    const task = state.tasks.get('T1-a')!;
    expect(task.attempts).toBe(2);
    expect(task.infraRetries).toEqual({ 'unit-test': 1 });
    expect(task.flakyRetries).toEqual({ 'unit-test': 1 });
  });

  it('rejects events for unknown tasks and duplicate plans', () => {
    expect(() => reduceEvents([moved('T9-x', 'ready')])).toThrow(UnknownTaskError);
    expect(() => reduceEvents([planned('T1-a'), planned('T1-a')])).toThrow(DuplicateTaskError);
  });

  it('ignores event types it does not own', () => {
    const state = reduceEvents([planned('T1-a'), { type: 'PR_CREATED', data: { url: 'x' } }]);
    expect(state.tasks.size).toBe(1);
  });

  it('tracks run pauses, resumes and budget drain', () => {
    const paused = reduceEvents([{ type: RunEvent.RunPaused, data: { reason: 'quota' } }]);
    expect(paused.status).toBe('paused:quota');
    const resumed = reduceEvents([{ type: RunEvent.RunPaused, data: { reason: 'auth' } }, { type: RunEvent.RunResumed, data: {} }]);
    expect(resumed.status).toBe('running');
    const draining = reduceEvents([{ type: RunEvent.RunBudgetExhausted, data: {} }, { type: RunEvent.RunResumed, data: {} }]);
    expect(draining.status).toBe('draining');
  });
});

describe('replan', () => {
  it('supersedes a replanned task and rewires its dependents', () => {
    const state = reduceEvents([
      planned('T1-a'),
      planned('T2-b', ['T1-a']),
      replan('T1-a', makePlanTask({ id: 'T4-a1' }), makePlanTask({ id: 'T5-a2', dependsOn: ['T4-a1'] })),
    ]);
    expect(state.tasks.get('T1-a')).toMatchObject({ state: 'superseded', replacedBy: ['T4-a1', 'T5-a2'] });
    expect(state.tasks.get('T4-a1')!.replanned).toBe(true);
    expect(state.tasks.get('T2-b')!.def.dependsOn).toEqual(['T4-a1', 'T5-a2']);
    expect(state.order).toEqual(['T1-a', 'T2-b', 'T4-a1', 'T5-a2']);
  });

  it('T0-scaffold starts with permission to write the frozen docs it bootstraps, and a replan inherits it', () => {
    const state = reduceEvents([planned('T0-scaffold'), replan('T0-scaffold', makePlanTask({ id: 'T0-scaffold-r1' }), makePlanTask({ id: 'T0-scaffold-r2' }))]);
    expect(state.tasks.get('T0-scaffold')!.bootstrapsFrozenPaths).toBe(true);
    expect(state.tasks.get('T0-scaffold-r1')!.bootstrapsFrozenPaths).toBe(true);
    expect(state.tasks.get('T0-scaffold-r2')!.bootstrapsFrozenPaths).toBe(true);
  });

  it("a service's scaffold is recognized by its own id, and only in its own service", () => {
    const state = reduceEvents([
      { type: RunEvent.TaskPlanned, data: { task: makePlanTask({ id: 'T0-scaffold-inventory', service: 'inventory' }) } },
      { type: RunEvent.TaskPlanned, data: { task: makePlanTask({ id: 'T0-scaffold-orders', service: 'inventory' }) } },
    ]);
    expect(state.tasks.get('T0-scaffold-inventory')!.bootstrapsFrozenPaths).toBe(true);
    expect(state.tasks.get('T0-scaffold-orders')!.bootstrapsFrozenPaths).toBe(false);
  });

  it('an ordinary task never gets the frozen-path permission, replanned or not', () => {
    const state = reduceEvents([planned('T1-a'), replan('T1-a', makePlanTask({ id: 'T1-a-r1' }))]);
    expect(state.tasks.get('T1-a')!.bootstrapsFrozenPaths).toBe(false);
    expect(state.tasks.get('T1-a-r1')!.bootstrapsFrozenPaths).toBe(false);
  });

  it('does not duplicate a dependency already listed by the dependent', () => {
    const state = reduceEvents([planned('T1-a'), planned('T4-r'), planned('T2-b', ['T1-a', 'T4-r']), replan('T1-a', makePlanTask({ id: 'T5-r2' }))]);
    expect(state.tasks.get('T2-b')!.def.dependsOn).toEqual(['T4-r', 'T5-r2']);
  });

  it('rejects a replacement that depends on the task it replaces', () => {
    expect(() => reduceEvents([planned('T1-a'), replan('T1-a', makePlanTask({ id: 'T4-a1', dependsOn: ['T1-a'] }))])).toThrow(ReplanError);
  });

  it('rejects replanning a task that came from a replan', () => {
    expect(() =>
      reduceEvents([planned('T1-a'), replan('T1-a', makePlanTask({ id: 'T4-a1' })), replan('T4-a1', makePlanTask({ id: 'T5-a2' }))]),
    ).toThrow(ReplanError);
  });

  it('a fix task planned later waits on the replacement of a superseded task, not on the superseded one', () => {
    const fix: ReducibleEvent = { type: RunEvent.FixTasksPlanned, data: { tasks: [makePlanTask({ id: 'T900-fix-1', dependsOn: ['T1-a', 'T2-b'] })] } };
    const state = reduceEvents([planned('T1-a'), planned('T2-b'), replan('T1-a', makePlanTask({ id: 'T1-a-r1' })), fix]);
    expect(state.tasks.get('T900-fix-1')!.def.dependsOn).toEqual(['T1-a-r1', 'T2-b']);
  });

  it('a fix task planned later does not wait on a task that is already blocked', () => {
    const fix: ReducibleEvent = { type: RunEvent.FixTasksPlanned, data: { tasks: [makePlanTask({ id: 'T900-fix-1', dependsOn: ['T1-a', 'T2-b'] })] } };
    const state = reduceEvents([planned('T1-a'), planned('T2-b'), moved('T1-a', 'blocked'), fix]);
    expect(state.tasks.get('T900-fix-1')!.def.dependsOn).toEqual(['T2-b']);
  });

  it('a fix task still waits on a blocked scaffold, since nothing builds without it', () => {
    const fix: ReducibleEvent = { type: RunEvent.FixTasksPlanned, data: { tasks: [makePlanTask({ id: 'T900-fix-1', dependsOn: ['T0-scaffold'] })] } };
    const state = reduceEvents([planned('T0-scaffold'), moved('T0-scaffold', 'blocked'), fix]);
    expect(state.tasks.get('T900-fix-1')!.def.dependsOn).toEqual(['T0-scaffold']);
  });

  it('rejects replanning a terminal task', () => {
    expect(() => reduceEvents([planned('T1-a'), moved('T1-a', 'blocked'), replan('T1-a', makePlanTask({ id: 'T4-a1' }))])).toThrow(ReplanError);
  });

  it('rejects a replan that would create a cycle through a dependent', () => {
    expect(() =>
      reduceEvents([planned('T1-a'), planned('T2-c', ['T1-a']), replan('T1-a', makePlanTask({ id: 'T3-r', dependsOn: ['T2-c'] }))]),
    ).toThrow(/cycle/);
  });

  it('leaves the state untouched when a replacement id already exists', () => {
    const events = [planned('T1-a'), planned('T2-b')];
    const before = reduceEvents(events);
    expect(() => reduceEvents([...events, replan('T1-a', makePlanTask({ id: 'T3-r1' }), makePlanTask({ id: 'T2-b' }))])).toThrow(DuplicateTaskError);
    const after = reduceEvents(events);
    expect(after.order).toEqual(before.order);
    expect(after.tasks.get('T1-a')!.state).toBe('planned');
    expect(after.tasks.has('T3-r1')).toBe(false);
  });

  it('rejects duplicate ids inside the replacement list', () => {
    expect(() => reduceEvents([planned('T1-a'), replan('T1-a', makePlanTask({ id: 'T3-r' }), makePlanTask({ id: 'T3-r' }))])).toThrow(ReplanError);
  });
});

describe('run status precedence', () => {
  it('keeps draining across a pause and resume', () => {
    const state = reduceEvents([
      { type: RunEvent.RunBudgetExhausted, data: {} },
      { type: RunEvent.RunPaused, data: { reason: 'quota' } },
      { type: RunEvent.RunResumed, data: {} },
    ]);
    expect(state.status).toBe('draining');
  });

  it('RUN_STOP_REQUESTED drains and a later pause or resume cannot undo it', () => {
    const s = reduceEvents([
      { type: RunEvent.TaskPlanned, data: { task: makePlanTask({ id: 'T1' }) } },
      { type: RunEvent.RunStopRequested, data: {} },
      { type: RunEvent.RunPaused, data: { reason: 'quota', until: '2026-09-24T10:05:00.000Z' } },
      { type: RunEvent.RunResumed, data: {} },
    ]);
    expect(s.status).toBe('draining');
  });

  it('a manual resume undoes a stop, but never an exhausted budget, and an automatic resume undoes neither', () => {
    const stop = { type: RunEvent.RunStopRequested, data: {} };
    expect(reduceEvents([stop, { type: RunEvent.RunResumed, data: { manual: true } }]).status).toBe('running');
    expect(reduceEvents([stop, { type: RunEvent.RunResumed, data: {} }]).status).toBe('draining');
    const budget = { type: RunEvent.RunBudgetExhausted, data: {} };
    expect(reduceEvents([budget, { type: RunEvent.RunResumed, data: { manual: true } }]).status).toBe('draining');
    // a stop that follows an exhausted budget is still a budget drain once the stop is undone
    expect(reduceEvents([budget, stop, { type: RunEvent.RunResumed, data: { manual: true } }]).status).toBe('draining');
  });
});
