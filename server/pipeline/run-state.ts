import { z } from 'zod';
import { findCycle, PlanTask, scaffoldId } from '../contracts/plan.js';
import { TASK_STATES, TERMINAL_STATES, assertTransition, type TaskState } from './task-state.js';

export interface TaskRuntime {
  def: PlanTask;
  state: TaskState;
  attempts: number;
  replanned: boolean;
  infraRetries: Record<string, number>;
  flakyRetries: Record<string, number>;
  replacedBy: string[];
  /** True for T0-scaffold and, transitively, for whatever the SM replans it into - the one task allowed
   * to write the frozen docs it bootstraps (spec (orchestrator) §4). Tracked by lineage, not by id, so a
   * replan (which the SM is trusted to author) doesn't silently strip the permission from its own work. */
  bootstrapsFrozenPaths: boolean;
}

export const RUN_STATUSES = ['running', 'paused:quota', 'paused:auth', 'draining'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface RunState {
  status: RunStatus;
  /** Why the run drains, when only a stop request does: a manual resume may undo a stop, never an exhausted budget. */
  stopOnly?: boolean;
  tasks: Map<string, TaskRuntime>;
  order: string[];
}

export interface ReducibleEvent {
  type: string;
  data: Record<string, unknown>;
}

export const RunEvent = {
  TaskPlanned: 'TASK_PLANNED',
  TaskStateChanged: 'TASK_STATE_CHANGED',
  AttemptConsumed: 'ATTEMPT_CONSUMED',
  InfraRetry: 'INFRA_RETRY',
  FlakyRetry: 'FLAKY_RETRY',
  TaskReplanned: 'TASK_REPLANNED',
  RunPaused: 'RUN_PAUSED',
  RunResumed: 'RUN_RESUMED',
  RunBudgetExhausted: 'RUN_BUDGET_EXHAUSTED',
  RunStopRequested: 'RUN_STOP_REQUESTED',
  FixTasksPlanned: 'FIX_TASKS_PLANNED',
  TasksUnblocked: 'TASKS_UNBLOCKED',
} as const;

export class UnknownTaskError extends Error {}
export class DuplicateTaskError extends Error {}
export class ReplanError extends Error {}

const TaskPlannedData = z.object({ task: PlanTask });
const StateChangedData = z.object({ taskId: z.string(), to: z.enum(TASK_STATES) });
const TaskRefData = z.object({ taskId: z.string() });
const GateRetryData = z.object({ taskId: z.string(), gate: z.string().min(1) });
const ReplannedData = z.object({ taskId: z.string(), replacements: z.array(PlanTask).min(1) });
const PausedData = z.object({ reason: z.enum(['quota', 'auth']), until: z.string().optional() });
const FixTasksData = z.object({ tasks: z.array(PlanTask).min(1) });
const UnblockedData = z.object({ taskIds: z.array(z.string()).min(1) });

export function emptyRunState(): RunState {
  return { status: 'running', tasks: new Map(), order: [] };
}

export function reduceEvents(events: Iterable<ReducibleEvent>): RunState {
  const state = emptyRunState();
  for (const event of events) applyEvent(state, event);
  return state;
}

export function applyEvent(state: RunState, event: ReducibleEvent): void {
  switch (event.type) {
    case RunEvent.TaskPlanned: {
      const planned = TaskPlannedData.parse(event.data).task;
      addTask(state, planned, false, planned.id === scaffoldId(planned.service ?? null));
      return;
    }
    case RunEvent.TaskStateChanged: {
      const { taskId, to } = StateChangedData.parse(event.data);
      const task = getTask(state, taskId);
      assertTransition(task.state, to);
      task.state = to;
      return;
    }
    case RunEvent.AttemptConsumed: {
      getTask(state, TaskRefData.parse(event.data).taskId).attempts += 1;
      return;
    }
    case RunEvent.InfraRetry: {
      const { taskId, gate } = GateRetryData.parse(event.data);
      bump(getTask(state, taskId).infraRetries, gate);
      return;
    }
    case RunEvent.FlakyRetry: {
      const { taskId, gate } = GateRetryData.parse(event.data);
      bump(getTask(state, taskId).flakyRetries, gate);
      return;
    }
    case RunEvent.TaskReplanned: {
      replan(state, ReplannedData.parse(event.data));
      return;
    }
    case RunEvent.RunPaused: {
      const reason = PausedData.parse(event.data).reason;
      // Draining is terminal for scheduling; a pause must not let a resume undo it.
      // A quota pause lifts on its own, so it must not hide an auth pause that waits for a human.
      if (state.status !== 'draining' && !(state.status === 'paused:auth' && reason === 'quota')) state.status = `paused:${reason}`;
      return;
    }
    case RunEvent.RunResumed: {
      // Only the human's resume (data.manual) lifts a stop; the automatic resume after a quota pause must not.
      if (state.status === 'draining' && state.stopOnly && event.data.manual === true) {
        state.status = 'running';
        state.stopOnly = false;
      } else if (state.status !== 'draining') state.status = 'running';
      return;
    }
    case RunEvent.RunBudgetExhausted: {
      state.status = 'draining';
      state.stopOnly = false;
      return;
    }
    case RunEvent.RunStopRequested: {
      if (state.status !== 'draining') state.stopOnly = true;
      state.status = 'draining';
      return;
    }
    case RunEvent.FixTasksPlanned: {
      for (const task of FixTasksData.parse(event.data).tasks) {
        // A blocked dependency could never merge, so a fix task waiting on it would never run; its own gates still judge it.
        // A blocked scaffold stays a dependency: without it the repository has nothing to install or build.
        const deps = task.dependsOn.flatMap((d) => liveIds(state, d)).filter((d) => state.tasks.get(d)?.state !== 'blocked' || state.tasks.get(d)?.bootstrapsFrozenPaths);
        addTask(state, { ...task, dependsOn: [...new Set(deps)] }, false);
      }
      return;
    }
    case RunEvent.TasksUnblocked: {
      // A human's resume: the cause of a block (a sandbox, a login, a missing tool) may be fixed, so each blocked task starts over.
      for (const taskId of UnblockedData.parse(event.data).taskIds) {
        const task = getTask(state, taskId);
        if (task.state !== 'blocked') continue;
        Object.assign(task, { state: 'ready', attempts: 0, infraRetries: {}, flakyRetries: {} });
      }
      return;
    }
    default:
      return;
  }
}

function addTask(state: RunState, def: PlanTask, replanned: boolean, bootstrapsFrozenPaths = false): void {
  if (state.tasks.has(def.id)) throw new DuplicateTaskError(`task ${def.id} already exists`);
  state.tasks.set(def.id, {
    def,
    state: 'planned',
    attempts: 0,
    replanned,
    infraRetries: {},
    flakyRetries: {},
    replacedBy: [],
    bootstrapsFrozenPaths,
  });
  state.order.push(def.id);
}

/** A superseded task stands for the tasks that replaced it, so a task planned later never waits on it. */
function liveIds(state: RunState, taskId: string): string[] {
  const replacedBy = state.tasks.get(taskId)?.replacedBy ?? [];
  return replacedBy.length > 0 ? replacedBy.flatMap((id) => liveIds(state, id)) : [taskId];
}

function getTask(state: RunState, taskId: string): TaskRuntime {
  const task = state.tasks.get(taskId);
  if (!task) throw new UnknownTaskError(`unknown task ${taskId}`);
  return task;
}

function bump(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

function replan(state: RunState, { taskId, replacements }: { taskId: string; replacements: PlanTask[] }): void {
  const original = getTask(state, taskId);
  if (original.replanned) throw new ReplanError(`task ${taskId} was produced by a replan and cannot be replanned`);
  if (TERMINAL_STATES.has(original.state)) throw new ReplanError(`task ${taskId} is ${original.state}`);
  assertTransition(original.state, 'superseded');

  // Validate everything before mutating, so a rejected replan leaves the state untouched.
  const ids = replacements.map((r) => r.id);
  if (new Set(ids).size !== ids.length) throw new ReplanError('replacement ids must be unique');
  for (const replacement of replacements) {
    if (state.tasks.has(replacement.id)) throw new DuplicateTaskError(`task ${replacement.id} already exists`);
    if (replacement.dependsOn.includes(taskId)) {
      throw new ReplanError(`replacement ${replacement.id} depends on the task it replaces`);
    }
  }
  const rewired = new Map<string, PlanTask>();
  for (const task of state.tasks.values()) {
    if (task.def.id === taskId || !task.def.dependsOn.includes(taskId)) continue;
    rewired.set(task.def.id, {
      ...task.def,
      dependsOn: [...new Set([...task.def.dependsOn.filter((d) => d !== taskId), ...ids])],
    });
  }
  const futureDefs = [
    ...[...state.tasks.values()].filter((t) => t.def.id !== taskId).map((t) => rewired.get(t.def.id) ?? t.def),
    ...replacements,
  ];
  const cycle = findCycle(futureDefs);
  if (cycle) throw new ReplanError(`replan would create a dependency cycle: ${cycle.join(' -> ')}`);

  for (const replacement of replacements) addTask(state, replacement, true, original.bootstrapsFrozenPaths);
  original.state = 'superseded';
  original.replacedBy = ids;
  for (const [id, def] of rewired) getTask(state, id).def = def;
}
