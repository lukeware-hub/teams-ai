import type { PlanTask } from '../../contracts/plan.js';
import { runDeployment, type DeploymentIntent, type DeployStage } from '../../deploy/target.js';
import type { SmokeRow } from '../../exec/smoke.js';
import { RunEvent } from '../../pipeline/run-state.js';
import { Intent, OrchEvent } from '../events.js';
import { SMOKE_CONTRACT } from '../steps.js';
import { checkoutMain, type PhaseDeps } from './shared.js';

export type Phase5Result = { ok: true; url: string; smoke: SmokeRow[]; healthcheck: string } | { ok: false; reason: string; fixTask?: PlanTask };
export const MAX_DEPLOY_ATTEMPTS = 3;

export function deployIntent(deps: PhaseDeps, tag: string): DeploymentIntent {
  const p = deps.plan!;
  return { projectId: deps.project.projectId, image: p.deploy.image, tag, port: p.deploy.port, healthcheckPath: p.deploy.healthcheckPath, manifests: [...p.deploy.manifests], secretNames: deps.secretNames ? deps.secretNames() : [...new Set(deps.spec.externalDependencies.flatMap((d) => d.secretNames))], contextDir: deps.ws.repo };
}
// Ids are assigned here and must stay unique across attempts and resumes (a resumed attempt re-issued
// T950-deploy-fix-1 and the reducer rejected it - 1387253335-001-r13).
const fixTaskId = (deps: PhaseDeps) => `T950-deploy-fix-${[...deps.journal.state.tasks.keys()].filter((id) => id.startsWith('T950-deploy-fix-')).length + 1}`;
const fixTask = (deps: PhaseDeps, attempt: number, stage: DeployStage, detail: string): PlanTask => {
  const base = { id: fixTaskId(deps), title: `Fix deployment (${stage})`, criteriaRefs: [], dependsOn: [], origin: 'deploy-fix' as const };
  // A smoke failure is about the smoke tests, not the manifests: the Dev owns it and must know the contract.
  if (stage === 'smoke') {
    return { ...base, description: `Deploy attempt ${attempt} succeeded but the smoke suite did not prove the smoke criteria: ${detail}

Contract: ${SMOKE_CONTRACT}`, affectedPaths: ['tests/smoke/**', 'tests/smoke', 'vitest.config.ts', 'package.json'], owner: 'dev' };
  }
  return { ...base, description: `Deploy attempt ${attempt} failed at ${stage}: ${detail}`, affectedPaths: [...deps.plan!.deploy.manifests, 'Dockerfile'], owner: 'devops' };
};

/** Resuming a new process restarts postPhases()'s attempt loop at 1; without this it replayed attempt 1's
 * already-resolved failure on every resume (new fix task, wasted tokens, never reaching later attempts -
 * 1387253335-001-r13). Each root deploy-fix task (not its `-rN` replan children) that reached a terminal
 * state stands for one attempt cycle that is done; the next attempt starts after all of them. */
export function deployStartAttempt(deps: PhaseDeps): 1 | 2 | 3 {
  const done = [...deps.journal.state.tasks.entries()].filter(([id, t]) => /^T950-deploy-fix-\d+$/.test(id) && ['merged', 'blocked'].includes(t.state)).length;
  return Math.min(1 + done, 3) as 1 | 2 | 3;
}

/** `fixTasks: false` (deploy-only runs): a failure is reported, never turned into agent work. */
export async function runPhase5(deps: PhaseDeps, attempt: 1 | 2 | 3, opts: { fixTasks?: boolean } = {}): Promise<Phase5Result> {
  if (!deps.plan || !deps.target || !deps.smoke) throw new Error('Phase 5 needs plan, target and smoke');
  const done = deps.journal.events.find((e) => e.type === OrchEvent.DeployVerified && e.data.attempt === attempt);
  if (done) return { ok: true, url: String(done.data.url), smoke: done.data.smoke as SmokeRow[], healthcheck: String(done.data.healthcheck) };
  if (!deps.journal.events.some((e) => e.type === OrchEvent.PhaseStarted && e.data.phase === 5)) await deps.journal.fact(OrchEvent.PhaseStarted, { phase: 5 });
  const tag = await checkoutMain(deps); const intent = deployIntent(deps, tag); const key = `deploy-${attempt}`;
  const failed = async (stage: DeployStage, detail: string, rolledBack: boolean, rollbackHealthy: boolean | null, previous: string | null): Promise<Phase5Result> => {
    await deps.journal.fact(OrchEvent.DeployFailed, { attempt, stage, detail, rolledBack, rollbackHealthy, tag });
    if (rolledBack) await deps.journal.fact(OrchEvent.RollbackDone, { attempt, previous });
    if (attempt >= 3 || opts.fixTasks === false) return { ok: false, reason: `deploy failed on attempt ${attempt} at ${stage}: ${detail}` };
    // The plan is not the Dev's to edit, so a deploy-fix task could only come back empty and burn tokens.
    if (stage === 'smoke' && detail === 'plan.commands.smoke missing') return { ok: false, reason: `deploy failed at ${stage}: ${detail}` };
    const task = fixTask(deps, attempt, stage, detail); await deps.journal.fact(RunEvent.FixTasksPlanned, { tasks: [task] });
    return { ok: false, reason: `deploy failed at ${stage}; deploy-fix task planned`, fixTask: task };
  };
  let previous: string | null = null; let healthcheck = '';
  if (deps.journal.isConfirmed(Intent.DeployApply, key)) {
    const c = [...deps.journal.events].reverse().find((e) => e.kind === 'confirm' && e.intentId === `${Intent.DeployApply}:${key}`); previous = (c?.data.previous as string | null | undefined) ?? null;
    const h = await deps.target.verify(intent); if (!h.healthy) return failed('verify', h.detail, false, null, previous); healthcheck = h.detail;
  } else {
    await deps.journal.intent(Intent.DeployApply, key, { attempt, image: intent.image, tag, intent });
    const r = await runDeployment(deps.target, intent, { smoke: async () => ({ ok: true, detail: 'journaled separately' }), baseUrl: '' });
    if (!r.ok) return failed(r.stage, r.detail, r.rolledBack, r.rollbackHealthy, null);
    previous = r.previous; await deps.journal.confirm(Intent.DeployApply, key, { previous }); await deps.journal.fact(OrchEvent.DeployApplied, { attempt, previous, tag });
    healthcheck = (await deps.target.verify(intent)).detail;
  }
  let url: string; try { url = await (deps.target.serviceUrl ? deps.target.serviceUrl(intent) : ''); } catch (e) { return failed('verify', (e as Error).message, false, null, previous); }
  const s = await deps.smoke(deps.ws.repo, url); if (!s.ok) { let rb = false; let rh: boolean | null = null; if (previous) { await deps.target.rollback(intent, previous); rb = true; rh = (await deps.target.verify(intent)).healthy; } return failed('smoke', s.detail, rb, rh, previous); }
  await deps.journal.fact(OrchEvent.DeployVerified, { attempt, url, smoke: s.rows, healthcheck, tag }); return { ok: true, url, smoke: s.rows, healthcheck };
}
