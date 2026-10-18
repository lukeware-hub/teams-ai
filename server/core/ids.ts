const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TASK_ID = /^T\d+(?:-[a-z0-9]+)*$/;
/** The type a service repository ends with: notification-api, messagem-jobs, hospital-web. */
export const SERVICE_SUFFIXES = ['api', 'jobs', 'web', 'mobile', 'workflow'] as const;
const SERVICE = new RegExp(`^[a-z0-9]+(?:-[a-z0-9]+)*-(?:${SERVICE_SUFFIXES.join('|')})$`);

export const ID_PATTERNS = { SLUG, TASK_ID, SERVICE } as const;

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

/** A service name is a slug ending with one of SERVICE_SUFFIXES. */
export function assertService(value: string): string {
  if (!SERVICE.test(value)) {
    throw new InvalidIdError(`service must end with one of ${SERVICE_SUFFIXES.join(', ')}, got "${value}"`);
  }
  return value;
}

/** The GitHub repository of a project, or of one of its services: the service name alone. */
export function repoName(projectId: string, service: string | null = null): string {
  assertSlug(projectId, 'projectId');
  return service === null ? projectId : assertService(service);
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

export const RUN_KINDS = ['run', 'complete', 'readme', 'deploy'] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export interface ParsedRunId {
  /** Null for a legacy id, which never named its project. */
  projectId: string | null;
  specId: string;
  kind: RunKind;
  n: number;
}

const RUN_ID = /^([a-z0-9]+(?:-[a-z0-9]+)*)--([a-z0-9]+(?:-[a-z0-9]+)*)--(?:(complete|readme|deploy)-)?run-(\d+)$/;
const LEGACY_RUN_ID = /^(.+?)(?:-(complete|readme|deploy))?-r(\d+)$/;

/**
 * Roadmap R11.12: `<projectId>--<specId>--run-<n>`, or `--complete-run-<n>`, `--readme-run-<n>`, `--deploy-run-<n>`.
 * A slug never holds `--`, so the parts split without ambiguity, and the project makes the id unique across projects
 * that share a spec id (the runs directory is global).
 */
export function runIdOf(projectId: string, specId: string, kind: RunKind, n: number): string {
  assertPositiveInteger(n, 'run number');
  return `${assertSlug(projectId, 'projectId')}--${assertSlug(specId, 'specId')}--${kind === 'run' ? '' : `${kind}-`}run-${n}`;
}

/** Both the readable form and the legacy `<specId>[-complete|-readme|-deploy]-r<n>`; null for anything else. */
export function parseRunId(runId: string): ParsedRunId | null {
  const m = RUN_ID.exec(runId);
  if (m) return { projectId: m[1]!, specId: m[2]!, kind: (m[3] ?? 'run') as RunKind, n: Number(m[4]) };
  const old = LEGACY_RUN_ID.exec(runId);
  if (old) return { projectId: null, specId: old[1]!, kind: (old[2] ?? 'run') as RunKind, n: Number(old[3]) };
  return null;
}
