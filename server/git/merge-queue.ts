export type MergeStage = 'rebase' | 'gates' | 'push' | 'pr' | 'merge';

export interface MergeSteps {
  /** PR number if this branch already merged (crash between merge and confirm); the queue then does nothing. */
  alreadyMerged(): Promise<number | null>;
  /** Rebase onto the current main; `baseSha` is the main commit the branch now sits on. */
  rebase(): Promise<{ ok: boolean; conflicts?: string[]; baseSha?: string }>;
  gates(): Promise<{ ok: boolean; detail?: string }>;
  push(): Promise<void>;
  ensurePr(): Promise<{ number: number }>;
  /** Sha of main on the remote right before merging; must equal `baseSha` or the merge is refused. */
  remoteMainSha(): Promise<string>;
  merge(number: number): Promise<{ merged: boolean; reason?: string }>;
  afterMerge?(): Promise<void>;
}

export type MergeOutcome =
  | { ok: true; pr: number; already?: true; warning?: string }
  | { ok: false; stage: MergeStage; conflicts?: string[]; detail?: string };

/**
 * Only the orchestrator writes `main`, one task at a time (spec §6 step 5): rebase on the current
 * main, re-run the gates, push, ensure the PR, check main did not move, merge guarded by the head
 * commit. `--match-head-commit` only pins the PR head, so the main check is what guarantees that
 * the combination that merges is the one the gates ran on.
 */
export class MergeQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private current: string | null = null;
  private readonly pending: string[] = [];
  private readonly inflight = new Map<string, Promise<MergeOutcome>>();

  get holder(): string | null {
    return this.current;
  }

  get waiting(): readonly string[] {
    return [...this.pending];
  }

  enqueue(taskId: string, steps: MergeSteps): Promise<MergeOutcome> {
    const existing = this.inflight.get(taskId);
    if (existing) return existing;
    this.pending.push(taskId);
    const run = async () => {
      this.pending.splice(this.pending.indexOf(taskId), 1);
      this.current = taskId;
      try {
        return await this.execute(steps);
      } finally {
        this.current = null;
        this.inflight.delete(taskId);
      }
    };
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    this.inflight.set(taskId, result);
    return result;
  }

  private async execute(steps: MergeSteps): Promise<MergeOutcome> {
    let stage: MergeStage = 'rebase';
    try {
      const merged = await steps.alreadyMerged();
      if (merged !== null) return { ok: true, pr: merged, already: true };
      const rebase = await steps.rebase();
      if (!rebase.ok) return { ok: false, stage, conflicts: rebase.conflicts ?? [] };
      stage = 'gates';
      const gates = await steps.gates();
      if (!gates.ok) return { ok: false, stage, detail: gates.detail };
      stage = 'push';
      await steps.push();
      stage = 'pr';
      const pr = await steps.ensurePr();
      stage = 'merge';
      const remote = await steps.remoteMainSha();
      if (rebase.baseSha !== undefined && remote !== rebase.baseSha) {
        return { ok: false, stage, detail: `main moved: rebased on ${rebase.baseSha}, remote is ${remote}` };
      }
      const merge = await steps.merge(pr.number);
      if (!merge.merged) return { ok: false, stage, detail: merge.reason };
      // The PR is in main now; a failing follow-up (graph update, cleanup) must not look like a failed merge.
      try {
        await steps.afterMerge?.();
      } catch (err) {
        return { ok: true, pr: pr.number, warning: `afterMerge: ${(err as Error).message}` };
      }
      return { ok: true, pr: pr.number };
    } catch (err) {
      // A fatal error (an injected crash in tests) must reach the caller; every other failure is a stage outcome.
      if ((err as { fatal?: boolean }).fatal === true) throw err;
      return { ok: false, stage, detail: (err as Error).message };
    }
  }
}
