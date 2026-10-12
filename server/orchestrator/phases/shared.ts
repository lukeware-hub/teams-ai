import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { OutputOf, StepKind } from '../../agents/outputs.js';
import { parseAnyPlan, Plan, type AnyPlan, type ServicesPlan, type ServiceView } from '../../contracts/plan.js';
import { Preplan } from '../../contracts/preplan.js';
import type { Project } from '../../contracts/project.js';
import type { Spec } from '../../contracts/spec.js';
import type { GateResult } from '../../exec/gate-runner.js';
import type { Decider } from '../../decide/decider.js';
import type { EvidenceTask } from '../../evidence/matrix.js';
import type { DeployTarget } from '../../deploy/target.js';
import type { E2eRow } from '../../exec/e2e.js';
import type { SmokeRow } from '../../exec/smoke.js';
import type { Exec } from '../../exec/command.js';
import { commitAll, createWorktree, fetch as gitFetch, git, removeWorktree, withRepoLock } from '../../git/git.js';
import type { MergeQueue } from '../../git/merge-queue.js';
import type { StepOutcome } from '../../runner/step.js';
import type { DocsInput } from '../../validators/docs.js';
import { Intent, OrchEvent, type Journal } from '../events.js';
import { docsMergeSteps, type MergeStepsDeps } from '../merge-steps.js';
import type { AgentStepRequest, PackBase } from '../steps.js';
import { worktreeDir, type Workspace } from '../workspace.js';

/** What a services run's smoke or e2e suite runs with: its service's plan, the criteria it answers for, the other services' addresses. */
export interface GateScope {
  service: string;
  plan: Plan;
  spec: Spec;
  urls: Record<string, string>;
}

/** A service's view with what Phase 4 runs it with: its workspace, its gates and whether its repository is new. */
export interface ServiceRepo extends ServiceView {
  ws: Workspace;
  firstSpec: boolean;
  gates: NonNullable<PhaseDeps['gates']>;
}

export interface PhaseDeps {
  journal: Journal;
  /** The folder holding every project's workspace; Phase 2 reads the other projects' deploy ports from it. */
  workspacesRoot?: string;
  ws: Workspace;
  spec: Spec;
  project: Project;
  specHash: string;
  firstSpec: boolean;
  /** Phase 2 requires `plan.delivery` from the SM (roadmap R8.1). */
  requireDelivery?: boolean;
  /** Phase 2 requires the prescribed security gates (roadmap R8.5). */
  requireSecurityTooling?: boolean;
  requireE2e?: boolean;
  /** Phase 2 requires a coverage gate clearing the line-coverage floor (roadmap R10.2). */
  requireCoverage?: boolean;
  exec: Exec;
  runAgent: <K extends StepKind>(req: AgentStepRequest<K>) => Promise<StepOutcome<OutputOf<K>>>;
  mergeQueue: MergeQueue;
  mergeDeps: MergeStepsDeps;
  packBase: () => PackBase;
  godNodes: () => Promise<ReadonlyArray<{ label: string; edges: number }>>;
  maxPhaseAttempts?: number;
  /**
   * Quota/auth failures are not phase attempts (POC spec §12). The Run pauses on the breaker and
   * answers `resumed`, or `auth` when a human must log in again.
   */
  pause?: (failure: 'quota' | 'auth') => Promise<'resumed' | 'auth'>;
  plan?: Plan;
  gates?: (worktree: string, branch: string) => Promise<{ results: GateResult[]; blockingFailure: GateResult | null }>;
  tasks?: () => Iterable<EvidenceTask>;
  decider?: Pick<Decider, 'decide'>;
  confidential?: boolean;
  boundaries?: () => Promise<readonly string[]>;
  target?: DeployTarget;
  smoke?: (contextDir: string, serviceUrl: string, gateServiceUrl?: string, gateNetwork?: string, scope?: GateScope) => Promise<{ ok: boolean; rows: SmokeRow[]; detail: string }>;
  /** Post-deploy e2e suite (roadmap R8.4); same arguments as `smoke`. */
  e2e?: (contextDir: string, serviceUrl: string, gateServiceUrl?: string, gateNetwork?: string, scope?: GateScope) => Promise<{ ok: boolean; rows: E2eRow[]; detail: string }>;
  secretNames?: () => string[];
  /** A services plan and its repositories; absent means the project repository with `plan` and `gates`. */
  services?: { plan: ServicesPlan; repos: ServiceRepo[] };
  /** The service whose repository `ws` is; absent for the project repository. */
  service?: string;
}

export const PAUSED_AUTH = 'paused:auth';

/** True when the caller must return `paused:auth`; false when the step may simply run again. */
export async function pauseForFailure(deps: PhaseDeps, failure: string): Promise<boolean> {
  if (failure !== 'quota' && failure !== 'auth') return false;
  const r = deps.pause ? await deps.pause(failure) : failure === 'auth' ? 'auth' : 'resumed';
  return r === 'auth';
}

export type PhaseResult = { ok: true } | { ok: false; reason: string };

export const specDir = (specId: string) => path.posix.join('docs', 'specs', specId);

/** What main already carries for this spec; lets a resumed run skip finished phases. */
export async function readDocs(repo: string, specId: string, exec?: Exec): Promise<{ techSpecText: string | null; plan: AnyPlan | null; preplan: Preplan | null }> {
  const show = async (rel: string) => {
    try {
      // Queued behind whatever else holds the repo lock (afterMerge's checkout and reset, a fetch), never beside it.
      return await withRepoLock(repo, () => git(repo, ['show', `origin/main:${rel}`], exec));
    } catch {
      return null;
    }
  };
  const techSpecText = await show(`${specDir(specId)}/tech-spec.md`);
  const planText = await show(`${specDir(specId)}/plan.json`);
  // A backlog item's preplan.json is reviewed context for Phase 2, never the plan itself (R11.4); absent for single-spec projects.
  const preplanText = await show(`${specDir(specId)}/preplan.json`);
  return { techSpecText, plan: planText === null ? null : parseAnyPlan(JSON.parse(planText)), preplan: preplanText === null ? null : Preplan.parse(JSON.parse(preplanText)) };
}

/** A plan written for an earlier version of the spec: a refined spec must be planned again, never delivered with the old plan. */
export const planIsStale = (plan: AnyPlan | null, specHash: string): boolean => plan !== null && plan.specHash !== specHash;

/** Acceptance criteria the pre-plan's tasks cover that no real-plan task covers: a deviation worth surfacing, not a rejection. */
export function preplanDeviation(preplan: Preplan, plan: Pick<Plan, 'tasks'>): string[] {
  const covered = new Set(plan.tasks.flatMap((t) => t.criteriaRefs));
  const expected = new Set(preplan.tasks.flatMap((t) => t.criteriaRefs));
  return [...expected].filter((id) => !covered.has(id));
}

export async function docsWorktree(deps: PhaseDeps, branch: string, opts: { keepCommits?: boolean } = {}): Promise<string> {
  const dir = worktreeDir(deps.ws, branch);
  const key = `docs-${branch}`;
  await gitFetch(deps.ws.repo, deps.exec);
  const confirmed = deps.journal.isConfirmed(Intent.WorktreeCreate, key);
  if (!confirmed) await deps.journal.intent(Intent.WorktreeCreate, key, { worktree: dir, branch });
  // A docs branch left by a crashed attempt is discarded (reset), unless its commit is already confirmed.
  await createWorktree(deps.ws.repo, dir, branch, 'origin/main', deps.exec, { reset: !opts.keepCommits });
  if (!confirmed) await deps.journal.confirm(Intent.WorktreeCreate, key, {});
  return dir;
}

/** The shared docs a docs worktree holds, which earlier specs wrote; a missing file reads as empty. */
export async function currentDocs(worktree: string): Promise<DocsInput> {
  const read = (file: string) => fs.readFile(path.join(worktree, 'docs', file), 'utf8').catch(() => '');
  return { readme: await read('README.md'), runbook: await read('RUNBOOK.md'), apiDocs: await read('API.md') };
}

export const docsCommitKey = (deps: PhaseDeps, phase: 0 | 1 | 2 | 6 | 7) => `${deps.spec.specId}-${phase}${deps.service ? `-${deps.service}` : ''}`;

/** Commits the docs and returns the head sha with the files the commit touched (none when there was nothing to commit). */
export async function commitDocs(worktree: string, message: string, exec: Exec): Promise<{ sha: string; files: string[] }> {
  const committed = await commitAll(worktree, message, {}, exec);
  if (!committed) return { sha: await git(worktree, ['rev-parse', 'HEAD'], exec), files: [] };
  const files = (await git(worktree, ['show', '--name-only', '--format=', committed], exec)).split('\n').filter((f) => f !== '');
  return { sha: committed, files };
}

export async function commitAndMergeDocs(deps: PhaseDeps, phase: 0 | 1 | 2 | 6 | 7, branch: string, worktree: string, title: string): Promise<PhaseResult> {
  const key = docsCommitKey(deps, phase);
  if (!deps.journal.isConfirmed(Intent.DocsCommit, key)) {
    const baseSha = await git(worktree, ['rev-parse', 'HEAD'], deps.exec);
    await deps.journal.intent(Intent.DocsCommit, key, { worktree, branch, message: title, baseSha });
    await deps.journal.confirm(Intent.DocsCommit, key, await commitDocs(worktree, title, deps.exec));
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    const out = await deps.mergeQueue.enqueue(`docs-${phase}-${attempt}`, docsMergeSteps(deps.mergeDeps, branch, worktree, title));
    if (out.ok) {
      await deps.journal.fact(OrchEvent.DocsMerged, { phase, pr: out.pr, branch });
      return { ok: true };
    }
    if (attempt === 2) {
      const reason = `docs merge failed at ${out.stage}: ${out.detail ?? (out.conflicts ?? []).join(', ')}`;
      await deps.journal.fact(OrchEvent.PhaseFailed, { phase, reason });
      return { ok: false, reason };
    }
  }
  return { ok: false, reason: 'unreachable' };
}

export async function trackedAndUntracked(dir: string, exec: Exec): Promise<Set<string>> {
  const tracked = (await git(dir, ['ls-files'], exec)).split('\n').filter((f) => f !== '');
  const status = (await git(dir, ['status', '--porcelain', '--untracked-files=all'], exec)).split('\n').filter((l) => l !== '').map((l) => l.slice(3).trim());
  return new Set([...tracked, ...status]);
}

export async function readInWorktree(worktree: string, rel: string): Promise<string> {
  return fs.readFile(path.join(worktree, rel), 'utf8');
}

export async function checkoutMain(deps: PhaseDeps): Promise<string> {
  await gitFetch(deps.ws.repo, deps.exec);
  // checkout rewrites the index and work tree of ws.repo, so it shares the repo lock with afterMerge. The rev-parse that
  // names the result stays inside it, or another locked move of HEAD could slip in between. gitFetch takes the
  // (non-reentrant) lock itself, hence the call above is outside.
  return withRepoLock(deps.ws.repo, async () => {
    await git(deps.ws.repo, ['checkout', '-q', '--detach', 'origin/main'], deps.exec);
    return (await git(deps.ws.repo, ['rev-parse', '--short', 'HEAD'], deps.exec)).trim();
  });
}

/**
 * Runs `fn` with a private, detached checkout of origin/main as its directory and removes the checkout afterwards.
 * Agent steps that only read the repository (SM, decider escalation) run here, not in the main checkout of ws.repo:
 * afterMerge rewrites that one (checkout + reset --hard) while the steps of other tasks are in flight, and an agent
 * reading it then sees a tree that changes under it. The snapshot is out of afterMerge's reach.
 *
 * The repo lock covers only the git commands that touch the repository's bookkeeping, never `fn`: an agent step
 * lasts minutes, and every fetch, worktree add and merge of every task queues behind that lock. The lock is not
 * reentrant and removeWorktree takes it itself, so it is called bare; so is `fn`.
 */
export async function withMainSnapshot<T>(ws: Workspace, exec: Exec, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = path.posix.join(ws.worktrees, `snapshot__${randomUUID().slice(0, 8)}`);
  try {
    await withRepoLock(ws.repo, () => git(ws.repo, ['worktree', 'add', '--detach', dir, 'origin/main'], exec));
    return await fn(dir);
  } finally {
    // A leftover costs disk only, and must not turn a finished agent step into a failure or hide the step's own error.
    await removeWorktree(ws.repo, dir, exec).catch(() => undefined);
  }
}
