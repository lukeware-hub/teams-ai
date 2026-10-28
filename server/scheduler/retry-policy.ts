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
  | 'auth'
  | 'aborted';

export interface Failure {
  kind: FailureKind;
  gate?: string;
  schemaRetriesUsed?: number;
  /** Tokens the task has used so far, counted by the orchestrator. */
  spentTokens?: number;
  /** The failure is identical to the one before it. */
  repeated?: boolean;
}

export interface PolicyConfig {
  maxAttempts: number;
  maxInfraRetriesPerGate: number;
  maxFlakyRetriesPerGate: number;
  maxSchemaRetriesPerStep: number;
  /** Set: attempts continue while the task's tokens stay under it. Unset: `maxAttempts` applies. */
  taskTokenBudget?: number;
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
 * With `taskTokenBudget` set, attempts continue while the task is under the budget;
 * a repeated identical failure or a spent budget ends them at once.
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
      return attemptFailure(failure, task, cfg);
    case 'infra':
    case 'environment':
      if (gateRetries(task.infraRetries, failure) < cfg.maxInfraRetriesPerGate) {
        return { action: 'rerun-gate', consumeAttempt: false };
      }
      return attemptFailure(failure, task, cfg);
    case 'flaky-test':
      if (gateRetries(task.flakyRetries, failure) < cfg.maxFlakyRetriesPerGate) {
        return { action: 'rerun-gate', consumeAttempt: false };
      }
      return attemptFailure(failure, task, cfg);
    case 'code':
    case 'dependency':
    case 'timeout':
    case 'aborted':
    case 'budget':
    case 'review-changes':
    case 'rebase-conflict':
      return attemptFailure(failure, task, cfg);
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

function attemptFailure(failure: Failure, task: TaskRuntime, cfg: PolicyConfig): PolicyDecision {
  if (cfg.taskTokenBudget !== undefined) {
    if (!failure.repeated && (failure.spentTokens ?? 0) < cfg.taskTokenBudget) return { action: 'retry-dev', consumeAttempt: true };
    return spentAttempts(task);
  }
  if (task.attempts + 1 < cfg.maxAttempts) return { action: 'retry-dev', consumeAttempt: true };
  return spentAttempts(task);
}

function spentAttempts(task: TaskRuntime): PolicyDecision {
  return { action: task.replanned ? 'block' : 'replan', consumeAttempt: true };
}
