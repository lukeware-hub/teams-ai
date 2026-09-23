import type { TaskRuntime } from '../pipeline/run-state.js';

export type FailureKind =
  | 'code'
  | 'dependency'
  | 'timeout'
  | 'budget'
  | 'review-changes'
  | 'rebase-conflict'
  | 'schema'
  | 'infra'
  | 'environment'
  | 'flaky-test'
  | 'compaction'
  | 'spec-gap'
  | 'quota'
  | 'auth';

export interface Failure {
  kind: FailureKind;
  gate?: string;
  schemaRetriesUsed?: number;
}

export interface PolicyConfig {
  maxAttempts: number;
  maxInfraRetriesPerGate: number;
  maxFlakyRetriesPerGate: number;
  maxSchemaRetriesPerStep: number;
}

export const DEFAULT_POLICY: PolicyConfig = {
  maxAttempts: 3,
  maxInfraRetriesPerGate: 3,
  maxFlakyRetriesPerGate: 1,
  maxSchemaRetriesPerStep: 2,
};

export type PolicyAction =
  | 'retry-dev'
  | 'rerun-gate'
  | 'rerun-step'
  | 'replan'
  | 'block'
  | 'pause-quota'
  | 'pause-auth'
  | 'route-spec-gap';

export interface PolicyDecision {
  action: PolicyAction;
  consumeAttempt: boolean;
}

/**
 * Attempt budget: a task gets `maxAttempts` dev attempts. When they are spent the
 * task is replanned once; replacement tasks start with a fresh attempt budget
 * but can never be replanned again, so they block when their budget is spent.
 */
export function decideOnFailure(
  failure: Failure,
  task: TaskRuntime,
  cfg: PolicyConfig = DEFAULT_POLICY,
): PolicyDecision {
  switch (failure.kind) {
    case 'quota':
      return { action: 'pause-quota', consumeAttempt: false };
    case 'auth':
      return { action: 'pause-auth', consumeAttempt: false };
    case 'spec-gap':
      return { action: 'route-spec-gap', consumeAttempt: false };
    case 'compaction':
      return { action: task.replanned ? 'block' : 'replan', consumeAttempt: false };
    case 'schema':
      if ((failure.schemaRetriesUsed ?? 0) < cfg.maxSchemaRetriesPerStep) {
        return { action: 'rerun-step', consumeAttempt: false };
      }
      return attemptFailure(task, cfg);
    case 'infra':
    case 'environment':
      if (gateRetries(task.infraRetries, failure) < cfg.maxInfraRetriesPerGate) {
        return { action: 'rerun-gate', consumeAttempt: false };
      }
      return attemptFailure(task, cfg);
    case 'flaky-test':
      if (gateRetries(task.flakyRetries, failure) < cfg.maxFlakyRetriesPerGate) {
        return { action: 'rerun-gate', consumeAttempt: false };
      }
      return attemptFailure(task, cfg);
    case 'code':
    case 'dependency':
    case 'timeout':
    case 'budget':
    case 'review-changes':
    case 'rebase-conflict':
      return attemptFailure(task, cfg);
    default: {
      const unreachable: never = failure.kind;
      throw new Error(`unhandled failure kind ${String(unreachable)}`);
    }
  }
}

function gateRetries(counter: Record<string, number>, failure: Failure): number {
  if (!failure.gate) throw new Error(`${failure.kind} failures require a gate name`);
  return counter[failure.gate] ?? 0;
}

function attemptFailure(task: TaskRuntime, cfg: PolicyConfig): PolicyDecision {
  const attemptsAfter = task.attempts + 1;
  if (attemptsAfter < cfg.maxAttempts) return { action: 'retry-dev', consumeAttempt: true };
  return { action: task.replanned ? 'block' : 'replan', consumeAttempt: true };
}
