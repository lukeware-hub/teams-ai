const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TASK_ID = /^T\d+(?:-[a-z0-9]+)*$/;

export const ID_PATTERNS = { SLUG, TASK_ID } as const;

export class InvalidIdError extends Error {}

export function assertSlug(value: string, label: string): string {
  if (!SLUG.test(value)) {
    throw new InvalidIdError(`${label} must be a lowercase slug, got "${value}"`);
  }
  return value;
}

export function assertTaskId(value: string): string {
  if (!TASK_ID.test(value)) {
    throw new InvalidIdError(`taskId must match T<number>[-slug], got "${value}"`);
  }
  return value;
}

function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new InvalidIdError(`${label} must be a positive integer, got ${value}`);
  }
  return value;
}

export function repoName(projectId: string): string {
  return assertSlug(projectId, 'projectId');
}

/** Branch name keeps the task id verbatim so it can be mapped back without a lookup. */
export function taskBranch(specId: string, taskId: string): string {
  return `task/${assertSlug(specId, 'specId')}-${assertTaskId(taskId)}`;
}

/** Relative to the run: runs/<runId>/attempts/<attemptId>. */
export function attemptId(taskId: string, attempt: number): string {
  assertPositiveInteger(attempt, 'attempt');
  return `${assertTaskId(taskId)}-a${attempt}`;
}

/** Relative to the run: runs/<runId>/steps/<stepId>.ndjson. */
export function stepId(seq: number): string {
  assertPositiveInteger(seq, 'seq');
  return `s${String(seq).padStart(5, '0')}`;
}
