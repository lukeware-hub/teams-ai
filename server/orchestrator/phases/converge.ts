import type { ConvergeOutput } from '../../agents/outputs.js';
import type { PlanTask } from '../../contracts/plan.js';
import { git } from '../../git/git.js';
import { RunEvent } from '../../pipeline/run-state.js';
import { OrchEvent } from '../events.js';
import { convergePack } from '../steps.js';
import { docsWorktree, PAUSED_AUTH, pauseForFailure, type PhaseDeps } from './shared.js';
import { smFixTasks } from './verify.js';

/** `done`: the code meets the plan; `gaps`: the review found what to build; `paused`: a login or quota stop; `failed`: the round stops the run. */
export type ReviewRound = { kind: 'done' } | { kind: 'gaps'; gaps: string[] } | { kind: 'paused' } | { kind: 'failed'; reason: string };

/** Paths the review changed: a review changes none. */
async function changedPaths(worktree: string, exec: PhaseDeps['exec']): Promise<string[]> {
  return (await git(worktree, ['ls-files', '--modified', '--others'], exec)).split('\n').filter((l) => l !== '');
}

/** One read-only review of the merged code against the implementation plan. Its verdict is journaled; nothing is committed. */
export async function runPlanReview(deps: PhaseDeps, round: 1 | 2): Promise<ReviewRound> {
  const planFile = deps.packBase().planFile;
  if (!planFile || deps.services || !deps.tasks) return { kind: 'done' };
  // A verdict already journaled is read, so a resumed run never asks the same review again.
  const prior = deps.journal.events.filter((e) => e.type === OrchEvent.SpecKitConverged && e.data.round === round).at(-1);
  if (prior) return prior.data.status === 'converged' ? { kind: 'done' } : { kind: 'gaps', gaps: (prior.data.gaps as string[] | undefined) ?? [] };
  const worktree = await docsWorktree(deps, `review-${deps.spec.specId}-${round}`);
  let answer: ConvergeOutput | null = null;
  let error = 'review step failed';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const out = await deps.runAgent<'converge'>({ kind: 'converge', role: 'dev', pack: convergePack(deps.packBase(), { plan: planFile }), cwd: worktree, phase: 'phase4', taskId: null, attempt });
    if (out.ok) {
      answer = out.value as ConvergeOutput;
      break;
    }
    if (await pauseForFailure(deps, out.failure)) return { kind: 'paused' };
    error = out.errors.join('\n');
  }
  if (!answer) return { kind: 'failed', reason: `review rejected twice: ${error}` };
  const changed = await changedPaths(worktree, deps.exec);
  if (changed.length > 0) return { kind: 'failed', reason: `the review changed files: ${changed.join(', ')}` };
  const gaps = answer.status === 'gaps' ? answer.gaps : [];
  await deps.journal.fact(OrchEvent.SpecKitConverged, { round, status: answer.status, gaps });
  return gaps.length === 0 ? { kind: 'done' } : { kind: 'gaps', gaps };
}

export type GapTasks = { kind: 'planned'; tasks: PlanTask[] } | { kind: 'paused' } | { kind: 'failed'; reason: string };

/** Fix tasks that build the gaps a review found; a resumed round finds them already planned. */
export async function planGapTasks(deps: PhaseDeps, round: 1 | 2, gaps: readonly string[]): Promise<GapTasks> {
  const planned = deps.journal.events.find((e) => e.type === RunEvent.FixTasksPlanned && e.data.speckitRound === round);
  if (planned) return { kind: 'planned', tasks: planned.data.tasks as PlanTask[] };
  const out = await smFixTasks(deps, [], { failedTests: [], tails: '', uncoveredAcs: [], cwd: deps.ws.repo, convergence: gaps.join('\n') });
  if ('reason' in out) return out.reason === PAUSED_AUTH ? { kind: 'paused' } : { kind: 'failed', reason: out.reason };
  await deps.journal.fact(RunEvent.FixTasksPlanned, { tasks: out.tasks, speckitRound: round });
  return { kind: 'planned', tasks: out.tasks };
}
