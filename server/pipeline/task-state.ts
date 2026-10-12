export const TASK_STATES = [
  'planned',
  'ready',
  'implementing',
  'validating',
  'reviewing',
  'rebasing',
  'merging',
  'merged',
  'blocked',
  'superseded',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set<TaskState>(['merged', 'blocked', 'superseded']);
export const ACTIVE_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'implementing',
  'validating',
  'reviewing',
  'rebasing',
  'merging',
]);

const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  // 'merged' here is not a step forward: it adopts what an earlier run of the same spec already merged (R11.4 retry).
  planned: ['ready', 'merged', 'blocked', 'superseded'],
  ready: ['implementing', 'blocked', 'superseded'],
  // 'merged' here adopts work an earlier run already put on main (TASK_ALREADY_ON_MAIN), never skips a change.
  implementing: ['validating', 'merged', 'blocked', 'superseded'],
  validating: ['reviewing', 'implementing', 'blocked', 'superseded'],
  reviewing: ['rebasing', 'implementing', 'blocked', 'superseded'],
  rebasing: ['merging', 'implementing', 'blocked', 'superseded'],
  merging: ['merged', 'rebasing', 'blocked'],
  merged: [],
  blocked: [],
  superseded: [],
};

export class InvalidTransitionError extends Error {}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(`invalid task transition ${from} -> ${to}`);
  }
}

/** The reason a task gets when a task it depends on blocked: it says nothing of its own. */
export const DEPENDENCY_BLOCKED = 'a dependency is blocked';
