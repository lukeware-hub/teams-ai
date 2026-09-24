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
  planned: ['ready', 'blocked', 'superseded'],
  ready: ['implementing', 'blocked', 'superseded'],
  implementing: ['validating', 'blocked', 'superseded'],
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
