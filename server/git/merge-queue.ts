export type MergeStage = 'rebase' | 'gates' | 'push' | 'pr' | 'merge';

export interface MergeSteps {
  rebase(): Promise<{ ok: boolean; conflicts?: string[] }>;
  gates(): Promise<{ ok: boolean; detail?: string }>;
  push(): Promise<void>;
  ensurePr(): Promise<{ number: number }>;
  merge(number: number): Promise<{ merged: boolean; reason?: string }>;
  afterMerge?(): Promise<void>;
}

export type MergeOutcome = { ok: true; pr: number } | { ok: false; stage: MergeStage; conflicts?: string[]; detail?: string };

/**
 * Only the orchestrator writes `main`, one task at a time (spec §6 step 5): rebase on the current
 * main, re-run the gates, push, ensure the PR, merge guarded by the head commit. Development stays
 * parallel; merging is serial, so the head that was tested is the head that merges.
 */
export class MergeQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private current: string | null = null;
  private readonly pending: string[] = [];

  get holder(): string | null {
    return this.current;
  }

  get waiting(): readonly string[] {
    return [...this.pending];
  }

  enqueue(taskId: string, steps: MergeSteps): Promise<MergeOutcome> {
    this.pending.push(taskId);
    const run = async () => {
      this.pending.splice(this.pending.indexOf(taskId), 1);
      this.current = taskId;
      try {
        return await this.execute(steps);
      } finally {
        this.current = null;
      }
    };
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }

  private async execute(steps: MergeSteps): Promise<MergeOutcome> {
    let stage: MergeStage = 'rebase';
    try {
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
      const merge = await steps.merge(pr.number);
      if (!merge.merged) return { ok: false, stage, detail: merge.reason };
      await steps.afterMerge?.();
      return { ok: true, pr: pr.number };
    } catch (err) {
      return { ok: false, stage, detail: (err as Error).message };
    }
  }
}
