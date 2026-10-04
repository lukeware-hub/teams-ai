import type { HandoffSummary } from '../knowledge/context-pack.js';
import { applyEvent, emptyRunState, type RunState } from '../pipeline/run-state.js';
import { EventStore, unconfirmedIntents, type EventInput, type StoredEvent } from '../store/event-store.js';

export const OrchEvent = {
  RunStarted: 'RUN_STARTED',
  PhaseStarted: 'PHASE_STARTED',
  PhaseFailed: 'PHASE_FAILED',
  TechSpecWritten: 'TECH_SPEC_WRITTEN',
  CoverageChecked: 'COVERAGE_CHECKED',
  DocsMerged: 'DOCS_MERGED',
  StepStarted: 'STEP_STARTED',
  StepFinished: 'STEP_FINISHED',
  DevCommitted: 'DEV_COMMITTED',
  GatePassed: 'GATE_PASSED',
  GateFailed: 'GATE_FAILED',
  ReviewApproved: 'REVIEW_APPROVED',
  ReviewChanges: 'REVIEW_CHANGES',
  SecurityApproved: 'SECURITY_APPROVED',
  SecurityChanges: 'SECURITY_CHANGES',
  ReviewProfileChosen: 'REVIEW_PROFILE_CHOSEN',
  ScopeDriftScored: 'SCOPE_DRIFT_SCORED',
  PlanChosen: 'PLAN_CHOSEN',
  SpecGapAnswered: 'SPEC_GAP_ANSWERED',
  DecisionMade: 'DECISION_MADE',
  MergeLockAcquired: 'MERGE_LOCK_ACQUIRED',
  PrCreated: 'PR_CREATED',
  PrMerged: 'PR_MERGED',
  TaskBlocked: 'TASK_BLOCKED',
  BudgetExceeded: 'BUDGET_EXCEEDED',
  RunFinished: 'RUN_FINISHED',
  RepoBootstrapped: 'REPO_BOOTSTRAPPED',
  /** The delta handed to the next Dev attempt (gate failures, findings, conflicts, spec-gap answer). */
  Feedback: 'FEEDBACK',
  VerificationPassed: 'VERIFICATION_PASSED',
  VerificationFailed: 'VERIFICATION_FAILED',
  DeployApplied: 'DEPLOY_APPLIED',
  DeployFailed: 'DEPLOY_FAILED',
  RollbackDone: 'ROLLBACK_DONE',
  DeployVerified: 'DEPLOY_VERIFIED',
  ReportReady: 'REPORT_READY',
} as const;

export const Intent = {
  WorktreeCreate: 'WORKTREE_CREATE',
  Commit: 'COMMIT',
  DocsCommit: 'DOCS_COMMIT',
  Push: 'PUSH',
  PrCreate: 'PR_CREATE',
  PrMerge: 'PR_MERGE',
  WorktreeRemove: 'WORKTREE_REMOVE',
  RepoCreate: 'REPO_CREATE',
  DeployApply: 'DEPLOY_APPLY',
} as const;
export type IntentType = (typeof Intent)[keyof typeof Intent];

/**
 * Thrown by the journal test hook right after an intent is appended. Marked fatal so no retry
 * layer (task runner, merge queue) turns it into a failure: the process must die here.
 */
export class CrashInjected extends Error {
  readonly fatal = true;
}

export type RunResult = 'complete' | 'blocked' | 'deadlocked' | 'drained' | 'phase-failed' | 'awaiting-validation' | 'verification-failed' | 'deploy-failed' | 'done';

/** Deterministic so reconcile can match an intent to its confirm across restarts (spec §7.2). */
export function intentId(type: IntentType, key: string): string {
  return `${type}:${key}`;
}

const REDUCED = new Set([
  'TASK_PLANNED',
  'TASK_STATE_CHANGED',
  'ATTEMPT_CONSUMED',
  'INFRA_RETRY',
  'FLAKY_RETRY',
  'TASK_REPLANNED',
  'RUN_PAUSED',
  'RUN_RESUMED',
  'RUN_BUDGET_EXHAUSTED',
  'RUN_STOP_REQUESTED',
  // Phase 4 fix tasks: without this the event reached the log but never the live state, so runFix() saw
  // no task to schedule and the run ended without a RUN_FINISHED (1387253335-001-r13).
  'FIX_TASKS_PLANNED',
]);

/** The single write path for run state: append to the log, then reduce. Replay and live execution share it. */
export class Journal {
  readonly state: RunState;
  private readonly log: StoredEvent[];
  private stepSeq: number;
  private appendQueue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly store: EventStore,
    events: StoredEvent[],
  ) {
    this.log = events;
    this.state = emptyRunState();
    for (const e of events) this.reduce(e);
    this.stepSeq = events.filter((e) => e.type === OrchEvent.StepStarted).length;
  }

  static async open(opts: { file: string; runId: string; specHash: string; clock?: () => Date }): Promise<Journal> {
    const store = await EventStore.open(opts);
    const events = await store.readAll();
    return new Journal(store, events);
  }

  get events(): readonly StoredEvent[] {
    return this.log;
  }

  private reduce(e: StoredEvent): void {
    if (e.kind === 'fact' && REDUCED.has(e.type)) applyEvent(this.state, { type: e.type, data: e.data });
  }

  /**
   * Validate, persist and apply form one critical section per journal. Interleaved, two appends validate
   * against the same pre-state and both reach the log; the second reduce then throws after its line is on
   * disk, and no later open can replay the log.
   */
  private append(input: EventInput): Promise<StoredEvent> {
    const run = this.appendQueue.then(() => this.appendSerialized(input));
    // A rejected append must not poison the ones queued behind it.
    this.appendQueue = run.catch(() => undefined);
    return run;
  }

  private async appendSerialized(input: EventInput): Promise<StoredEvent> {
    // Reduce on a copy first: an event the reducer rejects must never reach the log, or every
    // later open would throw while replaying it.
    if ((input.kind ?? 'fact') === 'fact' && REDUCED.has(input.type)) {
      applyEvent(structuredClone(this.state), { type: input.type, data: input.data ?? {} });
    }
    const stored = await this.store.append(input);
    this.log.push(stored);
    this.reduce(stored);
    if (stored.type === OrchEvent.StepStarted) {
      this.stepSeq = Math.max(this.stepSeq, this.log.filter((e) => e.type === OrchEvent.StepStarted).length);
    }
    return stored;
  }

  fact(type: string, data: Record<string, unknown> = {}): Promise<StoredEvent> {
    return this.append({ type, kind: 'fact', data });
  }

  intent(type: IntentType, key: string, data: Record<string, unknown> = {}): Promise<StoredEvent> {
    return this.append({ type, kind: 'intent', intentId: intentId(type, key), data });
  }

  confirm(type: IntentType, key: string, data: Record<string, unknown> = {}): Promise<StoredEvent> {
    return this.append({ type, kind: 'confirm', intentId: intentId(type, key), data });
  }

  unconfirmed(): StoredEvent[] {
    return unconfirmedIntents(this.log);
  }

  isConfirmed(type: IntentType, key: string): boolean {
    const id = intentId(type, key);
    return this.log.some((e) => e.kind === 'confirm' && e.intentId === id);
  }

  /** Next step number without allocating it (status displays). */
  nextStepSeq(): number {
    return this.stepSeq + 1;
  }

  /** Allocates the next step number synchronously, so concurrent steps never share an id or a directory. */
  allocStepSeq(): number {
    this.stepSeq += 1;
    return this.stepSeq;
  }

  /** Handoff summaries of merged tasks, rebuilt from PR_MERGED facts so they survive a restart. */
  handoffs(): HandoffSummary[] {
    return this.log.filter((e) => e.type === OrchEvent.PrMerged && e.data.handoff).map((e) => e.data.handoff as HandoffSummary);
  }

  lastFeedback(taskId: string): string | null {
    for (let i = this.log.length - 1; i >= 0; i--) {
      const e = this.log[i]!;
      if (e.type === OrchEvent.Feedback && e.data.taskId === taskId) return String(e.data.text);
    }
    return null;
  }

  assumptions(): string[] {
    return this.log.filter((e) => e.type === OrchEvent.SpecGapAnswered).map((e) => String(e.data.assumption));
  }

  close(): Promise<void> {
    // Appends issued before close still land first, as they did when they shared the store's queue.
    return this.appendQueue.then(() => this.store.close());
  }
}
