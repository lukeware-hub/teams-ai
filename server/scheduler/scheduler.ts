import { pathsOverlap } from '../core/paths.js';
import type { RunState, TaskRuntime } from '../pipeline/run-state.js';
import { ACTIVE_STATES, TERMINAL_STATES } from '../pipeline/task-state.js';

export const DEFAULT_MAX_PARALLEL = 3;

/** `drained`: the run budget is exhausted and nothing is in flight; go to the report. */
export type RunProgress = 'running' | 'complete' | 'deadlocked' | 'drained';

function ordered(state: RunState): TaskRuntime[] {
  return state.order.map((id) => state.tasks.get(id)).filter((t): t is TaskRuntime => t !== undefined);
}

function isWaiting(task: TaskRuntime): boolean {
  return task.state === 'planned' || task.state === 'ready';
}

/**
 * Tasks that may start now. The caller moves each one through
 * `planned -> ready -> implementing` (or `ready -> implementing`) itself.
 * Returns nothing while the run is paused or draining.
 */
export function nextRunnable(state: RunState, maxParallel: number = DEFAULT_MAX_PARALLEL): string[] {
  if (!Number.isInteger(maxParallel) || maxParallel < 1) {
    throw new RangeError(`maxParallel must be a positive integer, got ${maxParallel}`);
  }
  if (state.status !== 'running') return [];
  const tasks = ordered(state);
  const active = tasks.filter((t) => ACTIVE_STATES.has(t.state));
  const claimed = active.map((t) => t.def.affectedPaths);
  let slots = maxParallel - active.length;
  const picked: string[] = [];
  for (const task of tasks) {
    if (slots <= 0) break;
    if (!isWaiting(task)) continue;
    const depsMerged = task.def.dependsOn.every((d) => state.tasks.get(d)?.state === 'merged');
    if (!depsMerged) continue;
    if (claimed.some((paths) => pathsOverlap(paths, task.def.affectedPaths))) continue;
    picked.push(task.def.id);
    claimed.push(task.def.affectedPaths);
    slots -= 1;
  }
  return picked;
}

/** Waiting tasks that can never start: a dependency is blocked, superseded or unknown. */
export function tasksToBlock(state: RunState): string[] {
  const doomedIds = new Set(
    ordered(state)
      .filter((t) => t.state === 'blocked' || t.state === 'superseded')
      .map((t) => t.def.id),
  );
  const added: string[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of ordered(state)) {
      if (!isWaiting(task) || doomedIds.has(task.def.id)) continue;
      if (task.def.dependsOn.some((d) => doomedIds.has(d) || !state.tasks.has(d))) {
        doomedIds.add(task.def.id);
        added.push(task.def.id);
        changed = true;
      }
    }
  }
  return added;
}

/**
 * Tasks that `tasksToBlock` would block are counted as blocked here, so the answer does not
 * depend on the caller having applied them yet (otherwise the run could report `running` forever).
 */
export function runProgress(state: RunState, maxParallel: number = DEFAULT_MAX_PARALLEL): RunProgress {
  const doomed = new Set(tasksToBlock(state));
  const effective = ordered(state).map((t) => (doomed.has(t.def.id) ? 'blocked' : t.state));
  if (effective.every((s) => TERMINAL_STATES.has(s))) return 'complete';
  if (effective.some((s) => ACTIVE_STATES.has(s))) return 'running';
  if (state.status === 'draining') return 'drained';
  if (state.status !== 'running') return 'running';
  return nextRunnable(state, maxParallel).length > 0 ? 'running' : 'deadlocked';
}
