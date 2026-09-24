import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { OutputOf } from '../../agents/outputs.js';
import { Plan } from '../../contracts/plan.js';
import type { StepOutcome } from '../../runner/step.js';
import { canonicalJson } from '../../contracts/hash.js';
import { RunEvent } from '../../pipeline/run-state.js';
import { validatePlan } from '../../validators/plan.js';
import { Intent, OrchEvent } from '../events.js';
import { planPack } from '../steps.js';
import { PAUSED_AUTH, commitAndMergeDocs, docsCommitKey, docsWorktree, pauseForFailure, readDocs, specDir, type PhaseDeps, type PhaseResult } from './shared.js';

/** Spec (orchestrator) §4.3. */
export async function runPhase2(deps: PhaseDeps, techSpecText: string): Promise<PhaseResult & { plan?: Plan }> {
  const existing = await readDocs(deps.ws.repo, deps.spec.specId, deps.exec);
  if (existing.plan !== null) {
    await journalTasks(deps, existing.plan);
    return { ok: true, plan: existing.plan };
  }
  const branch = `docs/${deps.spec.specId}-plan`;
  if (deps.journal.isConfirmed(Intent.DocsCommit, docsCommitKey(deps, 2))) {
    const worktree = await docsWorktree(deps, branch, { keepCommits: true });
    // Read before the merge: the docs merge removes the worktree afterwards.
    const plan = Plan.parse(JSON.parse(await fs.readFile(path.join(worktree, `${specDir(deps.spec.specId)}/plan.json`), 'utf8')));
    const merged = await commitAndMergeDocs(deps, 2, branch, worktree, `docs(${deps.spec.specId}): plan`);
    if (!merged.ok) return merged;
    await journalTasks(deps, plan);
    return { ok: true, plan };
  }
  await deps.journal.fact(OrchEvent.PhaseStarted, { phase: 2 });
  const worktree = await docsWorktree(deps, branch);
  const max = deps.maxPhaseAttempts ?? 3;
  let feedback: string | null = null;
  for (let attempt = 1; attempt <= max; attempt++) {
    const out: StepOutcome<OutputOf<'plan'>> = await deps.runAgent<'plan'>({
      kind: 'plan',
      role: 'sm',
      pack: planPack(deps.packBase(), { techSpecText, godNodes: await deps.godNodes(), feedback, firstSpec: deps.firstSpec }),
      cwd: worktree,
      phase: 'phase2',
      taskId: null,
      attempt,
      semantic: [((p: Plan) => validatePlan(p, deps.spec, { firstSpec: deps.firstSpec })) as never],
    });
    if (!out.ok) {
      if (out.failure === 'quota' || out.failure === 'auth') {
        if (await pauseForFailure(deps, out.failure)) return { ok: false, reason: PAUSED_AUTH };
        attempt -= 1;
        continue;
      }
      feedback = `Previous plan was rejected (${out.failure}):\n${out.errors.join('\n')}`;
      continue;
    }
    const plan = out.value as Plan;
    const rel = `${specDir(deps.spec.specId)}/plan.json`;
    await fs.mkdir(path.dirname(path.join(worktree, rel)), { recursive: true });
    await fs.writeFile(path.join(worktree, rel), `${JSON.stringify(JSON.parse(canonicalJson(plan)), null, 2)}\n`);
    const merged = await commitAndMergeDocs(deps, 2, branch, worktree, `docs(${deps.spec.specId}): plan`);
    if (!merged.ok) return merged;
    await journalTasks(deps, plan);
    return { ok: true, plan };
  }
  const reason = `Phase 2 exhausted ${max} attempts; last feedback: ${feedback ?? 'none'}`;
  await deps.journal.fact(OrchEvent.PhaseFailed, { phase: 2, reason });
  return { ok: false, reason };
}

async function journalTasks(deps: PhaseDeps, plan: Plan): Promise<void> {
  for (const task of plan.tasks) {
    if (!deps.journal.state.tasks.has(task.id)) await deps.journal.fact(RunEvent.TaskPlanned, { task });
  }
}
