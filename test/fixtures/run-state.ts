import type { PlanTask } from '../../server/contracts/plan.js';
import type { RunState, RunStatus, TaskRuntime } from '../../server/pipeline/run-state.js';
import type { TaskState } from '../../server/pipeline/task-state.js';
import { makePlanTask } from './contracts.js';

export function runtime(
  def: Partial<PlanTask> & { id: string },
  state: TaskState = 'planned',
  extra: Partial<TaskRuntime> = {},
): TaskRuntime {
  return {
    def: makePlanTask(def),
    state,
    attempts: 0,
    replanned: false,
    infraRetries: {},
    flakyRetries: {},
    replacedBy: [],
    bootstrapsFrozenPaths: false,
    ...extra,
  };
}

export function runState(...tasks: TaskRuntime[]): RunState {
  return {
    status: 'running',
    tasks: new Map(tasks.map((t) => [t.def.id, t])),
    order: tasks.map((t) => t.def.id),
  };
}

export function withStatus(state: RunState, status: RunStatus): RunState {
  return { ...state, status };
}
