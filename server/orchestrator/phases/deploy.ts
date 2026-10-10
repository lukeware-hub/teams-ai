import type { PlanTask } from '../../contracts/plan.js';
import { assignDeployPort, portHeldByOthers } from '../../deploy/service-links.js';
import { composeProject } from '../../deploy/docker-local.js';
import { runDeployment, type DeploymentIntent, type DeployStage } from '../../deploy/target.js';
import { e2eCommand, type E2eRow } from '../../exec/e2e.js';
import type { SmokeRow } from '../../exec/smoke.js';
import { RunEvent } from '../../pipeline/run-state.js';
import { Intent, OrchEvent } from '../events.js';
import { E2E_CONTRACT, SMOKE_CONTRACT } from '../steps.js';
import { checkoutMain, type PhaseDeps } from './shared.js';

/** Archive the deploy build exports for plans that carry an image-scan gate (plan 37). */
export const IMAGE_ARCHIVE = '.tools/image.tar';

export type Phase5Result = { ok: true; url: string; smoke: SmokeRow[]; healthcheck: string; e2e?: E2eRow[] } | { ok: false; reason: string; fixTask?: PlanTask };
export const MAX_DEPLOY_ATTEMPTS = 3;

/** The plan's port, unless a failed deploy moved it to a free one. */
const deployPort = (deps: PhaseDeps) => Number([...deps.journal.events].reverse().find((e) => e.type === OrchEvent.DeployPortReassigned)?.data.to ?? deps.plan!.deploy.port);

const PORT_TAKEN = /port is already allocated/;

/** Draws a free port in place of `from` and records it; null when none is left. */
async function reassignPort(deps: PhaseDeps, from: number): Promise<number | null> {
  if (!deps.workspacesRoot) return null;
  const { port } = await assignDeployPort(deps.workspacesRoot, deps.project.projectId, deps.exec, [from]);
  if (port !== null) await deps.journal.fact(OrchEvent.DeployPortReassigned, { from, to: port });
  return port;
}

export function deployIntent(deps: PhaseDeps, tag: string): DeploymentIntent {
  const p = deps.plan!;
  return { projectId: deps.project.projectId, image: p.deploy.image, tag, port: deployPort(deps), healthcheckPath: p.deploy.healthcheckPath, manifests: [...p.deploy.manifests], secretNames: deps.secretNames ? deps.secretNames() : [...new Set(deps.spec.externalDependencies.flatMap((d) => d.secretNames))], contextDir: deps.ws.repo, ...(p.delivery?.compose ? { compose: p.delivery.compose } : {}), ...(p.gates.some((g) => g.name === 'image-scan') ? { imageArchive: IMAGE_ARCHIVE } : {}) };
}
// Ids are assigned here and must stay unique across attempts and resumes (a resumed attempt re-issued
// T950-deploy-fix-1 and the reducer rejected it - 1387253335-001-r13).
/** Dependency manifests of the supported stacks: a smoke or e2e fix may need to add a test dependency. */
const MANIFESTS = ['package.json', 'go.mod', 'go.sum', 'requirements.txt', 'pyproject.toml', 'Cargo.toml', 'Cargo.lock'];

const fixTaskId = (deps: PhaseDeps) => `T950-deploy-fix-${[...deps.journal.state.tasks.keys()].filter((id) => id.startsWith('T950-deploy-fix-')).length + 1}`;
const fixTask = (deps: PhaseDeps, attempt: number, stage: DeployStage, detail: string, newPort: number | null = null): PlanTask => {
  const base = { id: fixTaskId(deps), title: `Fix deployment (${stage})`, criteriaRefs: [], dependsOn: [], origin: 'deploy-fix' as const };
  // A smoke failure is about the smoke tests, not the manifests: the Dev owns it and must know the contract.
  if (stage === 'smoke') {
    return { ...base, description: `Deploy attempt ${attempt} succeeded but the smoke suite did not prove the smoke criteria: ${detail}

Contract: ${SMOKE_CONTRACT}`, affectedPaths: ['tests/smoke/**', 'tests/smoke', 'smoke/**', '**/*smoke*_test.go', 'vitest.config.ts', ...MANIFESTS], owner: 'dev' };
  }
  if (stage === 'e2e') {
    const suite = deps.plan!.delivery?.e2eSuite;
    return { ...base, description: `Deploy attempt ${attempt} succeeded and smoke passed but the e2e suite did not prove the acceptance criteria: ${detail}

Contract: ${E2E_CONTRACT}`, affectedPaths: [...(suite ? [suite] : []), 'e2e/**', 'tests/e2e/**', ...MANIFESTS], owner: 'dev' };
  }
  const portHint = newPort === null ? '' : `\n\nThe host port is taken. Move the service to port ${newPort}: PORT=${newPort}, docker-compose publishes "${newPort}:${newPort}", and the Dockerfile, healthcheck and tests use ${newPort} too.`;
  return { ...base, description: `Deploy attempt ${attempt} failed at ${stage}: ${detail}${portHint}`, affectedPaths: [...deps.plan!.deploy.manifests, 'Dockerfile'], owner: 'devops' };
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
  if (done) return { ok: true, url: String(done.data.url), smoke: done.data.smoke as SmokeRow[], healthcheck: String(done.data.healthcheck), ...(done.data.e2e ? { e2e: done.data.e2e as E2eRow[] } : {}) };
  if (!deps.journal.events.some((e) => e.type === OrchEvent.PhaseStarted && e.data.phase === 5)) await deps.journal.fact(OrchEvent.PhaseStarted, { phase: 5 });
  const tag = await checkoutMain(deps); const intent = deployIntent(deps, tag); const key = `deploy-${attempt}`;
  const failed = async (stage: DeployStage, detail: string, rolledBack: boolean, rollbackHealthy: boolean | null, previous: string | null): Promise<Phase5Result> => {
    await deps.journal.fact(OrchEvent.DeployFailed, { attempt, stage, detail, rolledBack, rollbackHealthy, tag });
    if (rolledBack) await deps.journal.fact(OrchEvent.RollbackDone, { attempt, previous });
    if (attempt >= 3 || opts.fixTasks === false) return { ok: false, reason: `deploy failed on attempt ${attempt} at ${stage}: ${detail}` };
    // The plan is not the Dev's to edit, so a deploy-fix task could only come back empty and burn tokens.
    if ((stage === 'smoke' && detail === 'plan.commands.smoke missing') || (stage === 'e2e' && detail.startsWith('plan.commands.e2e missing'))) return { ok: false, reason: `deploy failed at ${stage}: ${detail}` };
    const newPort = stage === 'apply' && PORT_TAKEN.test(detail) ? await reassignPort(deps, intent.port) : null;
    const task = fixTask(deps, attempt, stage, detail, newPort); await deps.journal.fact(RunEvent.FixTasksPlanned, { tasks: [task] });
    return { ok: false, reason: `deploy failed at ${stage}; deploy-fix task planned`, fixTask: task };
  };
  let previous: string | null = null; let healthcheck = '';
  if (deps.journal.isConfirmed(Intent.DeployApply, key)) {
    const c = [...deps.journal.events].reverse().find((e) => e.kind === 'confirm' && e.intentId === `${Intent.DeployApply}:${key}`); previous = (c?.data.previous as string | null | undefined) ?? null;
    const h = await deps.target.verify(intent); if (!h.healthy) return failed('verify', h.detail, false, null, previous); healthcheck = h.detail;
  } else {
    // A run planned before the port registry may hold a port another project's container owns: move it before the bind fails.
    if (await portHeldByOthers(deps.exec, composeProject(deps.project.projectId), intent.port)) return failed('apply', `Bind for 0.0.0.0:${intent.port} failed: port is already allocated`, false, null, null);
    await deps.journal.intent(Intent.DeployApply, key, { attempt, image: intent.image, tag, intent });
    const r = await runDeployment(deps.target, intent, { smoke: async () => ({ ok: true, detail: 'journaled separately' }), baseUrl: '' });
    if (!r.ok) return failed(r.stage, r.detail, r.rolledBack, r.rollbackHealthy, null);
    previous = r.previous; await deps.journal.confirm(Intent.DeployApply, key, { previous }); await deps.journal.fact(OrchEvent.DeployApplied, { attempt, previous, tag });
    healthcheck = (await deps.target.verify(intent)).detail;
  }
  let url: string; let gateUrl: string | undefined; let gateNet: string | undefined; try { url = await (deps.target.serviceUrl ? deps.target.serviceUrl(intent) : ''); gateUrl = deps.target.gateServiceUrl ? await deps.target.gateServiceUrl(intent) : undefined; gateNet = deps.target.gateNetwork?.(intent); } catch (e) { return failed('verify', (e as Error).message, false, null, previous); }
  const s = await deps.smoke(deps.ws.repo, url, gateUrl, gateNet); if (!s.ok) { let rb = false; let rh: boolean | null = null; if (previous) { await deps.target.rollback(intent, previous); rb = true; rh = (await deps.target.verify(intent)).healthy; } else await deps.target.destroy(intent).catch(() => undefined); return failed('smoke', s.detail, rb, rh, previous); }
  // The e2e suite runs only against a deployment whose smoke already passed (roadmap R8.4). Legacy plans without commands.e2e skip it unless the run requires it.
  let e2eRows: E2eRow[] | undefined;
  if (deps.e2e && (e2eCommand(deps.plan) || deps.requireE2e)) {
    const e = await deps.e2e(deps.ws.repo, url, gateUrl, gateNet);
    if (!e.ok) { let rb = false; let rh: boolean | null = null; if (previous) { await deps.target.rollback(intent, previous); rb = true; rh = (await deps.target.verify(intent)).healthy; } else await deps.target.destroy(intent).catch(() => undefined); return failed('e2e', e.detail, rb, rh, previous); }
    e2eRows = e.rows;
  }
  await deps.journal.fact(OrchEvent.DeployVerified, { attempt, url, smoke: s.rows, healthcheck, tag, port: intent.port, healthcheckPath: intent.healthcheckPath, ...(deps.plan!.deploy.kind ? { kind: deps.plan!.deploy.kind } : {}), ...(deps.plan!.deploy.docsPath ? { docsPath: deps.plan!.deploy.docsPath } : {}), ...(e2eRows ? { e2e: e2eRows } : {}) }); return { ok: true, url, smoke: s.rows, healthcheck, ...(e2eRows ? { e2e: e2eRows } : {}) };
}
