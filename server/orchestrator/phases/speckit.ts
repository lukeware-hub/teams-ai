import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PlanTask } from '../../contracts/plan.js';
import type { ConvergeOutput } from '../../agents/outputs.js';
import { git } from '../../git/git.js';
import { RunEvent } from '../../pipeline/run-state.js';
import { Intent, OrchEvent } from '../events.js';
import { SPECKIT_ALLOW, convergePack } from '../steps.js';
import { PAUSED_AUTH, commitAndMergeDocs, docsCommitKey, docsWorktree, freshDocsWorktree, pauseForFailure, type DocsPhase, type PhaseDeps } from './shared.js';
import { smFixTasks } from './verify.js';

/** `done`: nothing to do or the code converges; `appended`: gaps to build; `paused`: a login or quota stop; `failed`: the round stops the run. */
export type SpecKitRound = { kind: 'done' } | { kind: 'appended'; appended: string[] } | { kind: 'paused' } | { kind: 'failed'; reason: string };

type Verdict = { status: 'converged' | 'tasks-appended'; appended: string[] };

/** Round one commits in docs phase 8, round two in phase 9: each round is one docs change. */
const ROUND_PHASE: Record<1 | 2, DocsPhase> = { 1: 8, 2: 9 };

/** Ticks the ids the orchestrator merged; an id already ticked, or one tasks.md does not list, changes nothing. */
export function tickTasks(text: string, ids: readonly string[]): string {
  const done = new Set(ids);
  return text
    .split('\n')
    .map((line) => {
      const open = /^(\s*- \[) \] (T\d+)\b/.exec(line);
      return open && done.has(open[2]!) ? `${open[1]}X] ${open[2]}${line.slice(open[0].length)}` : line;
    })
    .join('\n');
}

const exists = (file: string): Promise<boolean> => fs.access(file).then(() => true, () => false);

/** Paths the worktree changed or created, ignored ones included. */
async function changedPaths(worktree: string, exec: PhaseDeps['exec']): Promise<string[]> {
  return (await git(worktree, ['ls-files', '--modified', '--others'], exec)).split('\n').filter((l) => l !== '');
}

/** The Spec Kit tasks of the merged plan tasks become [X] in tasks.md; the orchestrator, not the Dev, writes that mark. */
async function markMerged(deps: PhaseDeps, file: string): Promise<void> {
  const ids = [...deps.tasks!()].filter((t) => t.state === 'merged').flatMap((t) => t.def.speckitTasks ?? []);
  await fs.writeFile(file, tickTasks(await fs.readFile(file, 'utf8'), ids));
}

/** One round: marks the merged tasks, lets the convergence agent append the gaps, and commits both as one docs change. */
export async function runSpecKitRound(deps: PhaseDeps, round: 1 | 2): Promise<SpecKitRound> {
  const feature = deps.packBase().speckitFeature;
  if (!feature || deps.services || !deps.tasks) return { kind: 'done' };
  const phase = ROUND_PHASE[round];
  const branch = `docs/${deps.spec.specId}-speckit-${round}`;
  const tasksRel = path.posix.join(feature, 'tasks.md');
  // The verdict is journaled before its commit, so a round whose commit is confirmed reads the verdict it committed.
  const prior = deps.journal.events.filter((e) => e.type === OrchEvent.SpecKitConverged && e.data.round === round).at(-1);
  let verdict: Verdict;
  let worktree: string;
  if (prior && deps.journal.isConfirmed(Intent.DocsCommit, docsCommitKey(deps, phase))) {
    worktree = await docsWorktree(deps, branch, { keepCommits: true });
    verdict = { status: prior.data.status as Verdict['status'], appended: prior.data.appended as string[] };
  } else {
    if (!(await exists(path.join(deps.ws.repo, tasksRel)))) {
      await deps.journal.fact(OrchEvent.SpecKitSkipped, { round, reason: `${tasksRel} is missing` });
      return { kind: 'done' };
    }
    worktree = await freshDocsWorktree(deps, branch, phase);
    const file = path.join(worktree, tasksRel);
    await markMerged(deps, file);
    let answer: ConvergeOutput | null = null;
    let error = 'converge step failed';
    for (let attempt = 1; attempt <= 2; attempt++) {
      const out = await deps.runAgent<'converge'>({ kind: 'converge', role: 'dev', pack: convergePack(deps.packBase(), { feature }), cwd: worktree, phase: 'phase4', taskId: null, attempt, extraAllow: SPECKIT_ALLOW, extraEnv: { SPECIFY_FEATURE_DIRECTORY: feature } });
      if (out.ok) { answer = out.value as ConvergeOutput; break; }
      if (await pauseForFailure(deps, out.failure)) return { kind: 'paused' };
      error = out.errors.join('\n');
    }
    if (!answer) return { kind: 'failed', reason: `converge rejected twice: ${error}` };
    const stray = (await changedPaths(worktree, deps.exec)).filter((f) => f !== tasksRel);
    if (stray.length > 0) return { kind: 'failed', reason: `converge changed files outside tasks.md: ${stray.join(', ')}` };
    const appended = answer.status === 'tasks-appended' ? answer.appended : [];
    const text = await fs.readFile(file, 'utf8');
    const unlisted = appended.filter((id) => !new RegExp(`^\\s*- \\[ \\] ${id}\\b`, 'm').test(text));
    if (unlisted.length > 0) return { kind: 'failed', reason: `converge named ids that tasks.md does not list as open: ${unlisted.join(', ')}` };
    verdict = { status: answer.status, appended };
    await deps.journal.fact(OrchEvent.SpecKitConverged, { round, ...verdict });
  }
  const merged = await commitAndMergeDocs(deps, phase, branch, worktree, `docs(${deps.spec.specId}): Spec Kit tasks and convergence, round ${round}`);
  if (!merged.ok) return { kind: 'failed', reason: merged.reason };
  return verdict.status === 'converged' ? { kind: 'done' } : { kind: 'appended', appended: verdict.appended };
}

export type SpecKitGaps = { kind: 'planned'; tasks: PlanTask[] } | { kind: 'paused' } | { kind: 'failed'; reason: string };

/** Fix tasks that build the gaps convergence appended, each listing its ids in speckitTasks; a resumed round finds them already planned. */
export async function planSpecKitGaps(deps: PhaseDeps, round: 1 | 2, appended: readonly string[]): Promise<SpecKitGaps> {
  const planned = deps.journal.events.find((e) => e.type === RunEvent.FixTasksPlanned && e.data.speckitRound === round);
  if (planned) return { kind: 'planned', tasks: planned.data.tasks as PlanTask[] };
  const feature = deps.packBase().speckitFeature!;
  // The round's docs merged, so the main checkout holds the appended lines.
  const lines = (await fs.readFile(path.join(deps.ws.repo, feature, 'tasks.md'), 'utf8')).split('\n');
  const convergence = appended.map((id) => lines.find((l) => new RegExp(`^\\s*- \\[ \\] ${id}\\b`).test(l)) ?? id).join('\n');
  const out = await smFixTasks(deps, [], { failedTests: [], tails: '', uncoveredAcs: [], cwd: deps.ws.repo, convergence, speckitTasks: appended });
  if ('reason' in out) return out.reason === PAUSED_AUTH ? { kind: 'paused' } : { kind: 'failed', reason: out.reason };
  await deps.journal.fact(RunEvent.FixTasksPlanned, { tasks: out.tasks, speckitRound: round });
  return { kind: 'planned', tasks: out.tasks };
}
