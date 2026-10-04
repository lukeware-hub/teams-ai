import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { OutputOf, StepKind } from '../../agents/outputs.js';
import { Plan } from '../../contracts/plan.js';
import type { Project } from '../../contracts/project.js';
import type { Spec } from '../../contracts/spec.js';
import type { GateResult } from '../../exec/gate-runner.js';
import type { Decider } from '../../decide/decider.js';
import type { EvidenceTask } from '../../evidence/matrix.js';
import type { DeployTarget } from '../../deploy/target.js';
import type { SmokeRow } from '../../exec/smoke.js';
import type { Exec } from '../../exec/command.js';
import { commitAll, createWorktree, fetch as gitFetch, git } from '../../git/git.js';
import type { MergeQueue } from '../../git/merge-queue.js';
import type { StepOutcome } from '../../runner/step.js';
import { Intent, OrchEvent, type Journal } from '../events.js';
import { docsMergeSteps, type MergeStepsDeps } from '../merge-steps.js';
import type { AgentStepRequest, PackBase } from '../steps.js';
import { worktreeDir, type Workspace } from '../workspace.js';

export interface PhaseDeps {
  journal: Journal;
  ws: Workspace;
  spec: Spec;
  project: Project;
  specHash: string;
  firstSpec: boolean;
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
  smoke?: (contextDir: string, serviceUrl: string, gateServiceUrl?: string) => Promise<{ ok: boolean; rows: SmokeRow[]; detail: string }>;
  secretNames?: () => string[];
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
export async function readDocs(repo: string, specId: string, exec?: Exec): Promise<{ techSpecText: string | null; plan: Plan | null }> {
  const show = async (rel: string) => {
    try {
      return await git(repo, ['show', `origin/main:${rel}`], exec);
    } catch {
      return null;
    }
  };
  const techSpecText = await show(`${specDir(specId)}/tech-spec.md`);
  const planText = await show(`${specDir(specId)}/plan.json`);
  return { techSpecText, plan: planText === null ? null : Plan.parse(JSON.parse(planText)) };
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

export const docsCommitKey = (deps: PhaseDeps, phase: 0 | 1 | 2 | 6) => `${deps.spec.specId}-${phase}`;

export async function commitAndMergeDocs(deps: PhaseDeps, phase: 0 | 1 | 2 | 6, branch: string, worktree: string, title: string): Promise<PhaseResult> {
  const key = docsCommitKey(deps, phase);
  if (!deps.journal.isConfirmed(Intent.DocsCommit, key)) {
    const baseSha = await git(worktree, ['rev-parse', 'HEAD'], deps.exec);
    await deps.journal.intent(Intent.DocsCommit, key, { worktree, branch, message: title, baseSha });
    const sha = (await commitAll(worktree, title, {}, deps.exec)) ?? (await git(worktree, ['rev-parse', 'HEAD'], deps.exec));
    await deps.journal.confirm(Intent.DocsCommit, key, { sha });
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
  await git(deps.ws.repo, ['checkout', '-q', '--detach', 'origin/main'], deps.exec);
  return (await git(deps.ws.repo, ['rev-parse', '--short', 'HEAD'], deps.exec)).trim();
}
