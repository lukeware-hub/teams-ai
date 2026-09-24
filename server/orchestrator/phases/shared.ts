import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { OutputOf, StepKind } from '../../agents/outputs.js';
import { Plan } from '../../contracts/plan.js';
import type { Project } from '../../contracts/project.js';
import type { Spec } from '../../contracts/spec.js';
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

export async function docsWorktree(deps: PhaseDeps, branch: string): Promise<string> {
  const dir = worktreeDir(deps.ws, branch);
  const key = `docs-${branch}`;
  await gitFetch(deps.ws.repo, deps.exec);
  const confirmed = deps.journal.isConfirmed(Intent.WorktreeCreate, key);
  if (!confirmed) await deps.journal.intent(Intent.WorktreeCreate, key, { worktree: dir, branch });
  await createWorktree(deps.ws.repo, dir, branch, 'origin/main', deps.exec, { reset: true });
  if (!confirmed) await deps.journal.confirm(Intent.WorktreeCreate, key, {});
  return dir;
}

export async function commitAndMergeDocs(deps: PhaseDeps, phase: 1 | 2, branch: string, worktree: string, title: string): Promise<PhaseResult> {
  const key = `${deps.spec.specId}-${phase}`;
  await deps.journal.intent(Intent.DocsCommit, key, { worktree, branch, message: title });
  const sha = (await commitAll(worktree, title, {}, deps.exec)) ?? (await git(worktree, ['rev-parse', 'HEAD'], deps.exec));
  await deps.journal.confirm(Intent.DocsCommit, key, { sha });
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
