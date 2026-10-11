import type { PlanTask } from '../../contracts/plan.js';
import { specShare } from '../../contracts/spec.js';
import { assignDeployPort, portHeldByOthers, portKey } from '../../deploy/port-registry.js';
import { composeProject, serviceComposeProject, sharedNetwork } from '../../deploy/docker-local.js';
import { runDeployment, type DeploymentIntent, type DeployStage } from '../../deploy/target.js';
import { e2eCommand, type E2eRow } from '../../exec/e2e.js';
import { serviceUrlEnv, type SmokeRow } from '../../exec/smoke.js';
import { RunEvent } from '../../pipeline/run-state.js';
import { Intent, OrchEvent } from '../events.js';
import { E2E_CONTRACT, SMOKE_CONTRACT } from '../steps.js';
import { checkoutMain, type GateScope, type PhaseDeps, type ServiceRepo } from './shared.js';

/** Archive the deploy build exports for plans that carry an image-scan gate (plan 37). */
export const IMAGE_ARCHIVE = '.tools/image.tar';

export type Phase5Result = { ok: true; url: string; smoke: SmokeRow[]; healthcheck: string; e2e?: E2eRow[] } | { ok: false; reason: string; fixTask?: PlanTask };
export const MAX_DEPLOY_ATTEMPTS = 3;

/** The plan's port, unless a failed deploy moved it to a free one. */
const deployPort = (deps: PhaseDeps) => Number([...deps.journal.events].reverse().find((e) => e.type === OrchEvent.DeployPortReassigned)?.data.to ?? deps.plan!.deploy.port);

const PORT_TAKEN = /port is already allocated/;

/** Draws a free port in place of `from` and records it; null when none is left. */
async function reassignPort(deps: PhaseDeps, from: number, service: string | null = null): Promise<number | null> {
  if (!deps.workspacesRoot) return null;
  const { port } = await assignDeployPort(deps.workspacesRoot, portKey(deps.project.projectId, service), deps.exec, [from]);
  if (port !== null) await deps.journal.fact(OrchEvent.DeployPortReassigned, { from, to: port, ...(service ? { service } : {}) });
  return port;
}

/** A missing suite command is the plan's, which no agent edits: a deploy-fix task could only come back empty and burn tokens. */
const planGap = (stage: DeployStage, detail: string) => (stage === 'smoke' && detail === 'plan.commands.smoke missing') || (stage === 'e2e' && detail.startsWith('plan.commands.e2e missing'));

export function deployIntent(deps: PhaseDeps, tag: string): DeploymentIntent {
  const p = deps.plan!;
  return { projectId: deps.project.projectId, image: p.deploy.image, tag, port: deployPort(deps), healthcheckPath: p.deploy.healthcheckPath, manifests: [...p.deploy.manifests], secretNames: deps.secretNames ? deps.secretNames() : [...new Set(deps.spec.externalDependencies.flatMap((d) => d.secretNames))], contextDir: deps.ws.repo, ...(p.delivery?.compose ? { compose: p.delivery.compose } : {}), ...(p.gates.some((g) => g.name === 'image-scan') ? { imageArchive: IMAGE_ARCHIVE } : {}) };
}

/** A service's port: the plan's, unless a failed deploy of that service moved it. */
const servicePort = (deps: PhaseDeps, repo: ServiceRepo) => Number([...deps.journal.events].reverse().find((e) => e.type === OrchEvent.DeployPortReassigned && e.data.service === repo.service)?.data.to ?? repo.plan.deploy.port);

/** A service deploys like a single plan, as its own compose project on the project's shared network. */
function serviceIntent(deps: PhaseDeps, repo: ServiceRepo, tag: string): DeploymentIntent {
  const service = repo.service!;
  return { ...deployIntent({ ...deps, plan: repo.plan, ws: repo.ws }, tag), port: servicePort(deps, repo), shared: { composeProject: serviceComposeProject(deps.project.projectId, service), network: sharedNetwork(deps.project.projectId), alias: service } };
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
    if (planGap(stage, detail)) return { ok: false, reason: `deploy failed at ${stage}: ${detail}` };
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

/**
 * R12.4: the platform first, then every service on the shared network, then each service's smoke and e2e suites with the
 * other services' addresses. A failure rolls back every service this attempt applied; the fix goes to the failing service.
 */
export async function runServicesPhase5(deps: PhaseDeps, attempt: 1 | 2 | 3, opts: { fixTasks?: boolean } = {}): Promise<{ ok: true } | { ok: false; reason: string; fixTask?: PlanTask }> {
  const { journal, target, services } = deps;
  if (!services || !target || !deps.smoke) throw new Error('Phase 5 needs the services, target and smoke');
  if (journal.events.some((e) => e.type === OrchEvent.DeployVerified && e.data.attempt === attempt)) return { ok: true };
  if (!journal.events.some((e) => e.type === OrchEvent.PhaseStarted && e.data.phase === 5)) await journal.fact(OrchEvent.PhaseStarted, { phase: 5 });
  const applied: Array<{ repo: ServiceRepo; intent: DeploymentIntent; previous: string | null; healthcheck: string }> = [];
  const failed = async (stage: DeployStage | 'platform', detail: string, repo: ServiceRepo | null, newPort: number | null = null) => {
    // Every applied service goes back to its previous image, or away when this was its first deploy.
    for (const a of [...applied].reverse()) await (a.previous ? target.rollback(a.intent, a.previous) : target.destroy(a.intent)).catch(() => undefined);
    await journal.fact(OrchEvent.DeployFailed, { attempt, stage, detail, rolledBack: applied.length > 0, rollbackHealthy: null, ...(repo ? { service: repo.service } : {}) });
    // The platform comes from the docs, never from the code: no task could fix it.
    if (!repo || attempt >= 3 || opts.fixTasks === false) return { ok: false as const, reason: `deploy failed on attempt ${attempt} at ${stage}${repo ? ` (${repo.service})` : ''}: ${detail}` };
    if (planGap(stage as DeployStage, detail)) return { ok: false as const, reason: `deploy failed at ${stage} (${repo.service}): ${detail}` };
    const task = { ...fixTask({ ...deps, plan: repo.plan }, attempt, stage as DeployStage, detail, newPort), service: repo.service! };
    await journal.fact(RunEvent.FixTasksPlanned, { tasks: [task] });
    return { ok: false as const, reason: `deploy failed at ${stage} (${repo.service}); deploy-fix task planned`, fixTask: task };
  };
  const platform = target.startPlatform ? await target.startPlatform(deps.project.projectId, deps.project.platform ?? []) : { ok: true, detail: '' };
  if (!platform.ok) return failed('platform', platform.detail, null);
  for (const repo of services.repos) {
    const tag = await checkoutMain({ ...deps, ws: repo.ws });
    const intent = serviceIntent(deps, repo, tag);
    const key = `deploy-${repo.service}-${attempt}`;
    let previous: string | null = null;
    if (journal.isConfirmed(Intent.DeployApply, key)) {
      previous = ([...journal.events].reverse().find((e) => e.kind === 'confirm' && e.intentId === `${Intent.DeployApply}:${key}`)?.data.previous as string | null | undefined) ?? null;
    } else {
      await journal.intent(Intent.DeployApply, key, { attempt, service: repo.service, image: intent.image, tag, intent });
      const r = await runDeployment(target, intent, { smoke: async () => ({ ok: true, detail: 'journaled separately' }), baseUrl: '' });
      if (!r.ok) return failed(r.stage, r.detail, repo, r.stage === 'apply' && PORT_TAKEN.test(r.detail) ? await reassignPort(deps, intent.port, repo.service) : null);
      previous = r.previous;
      await journal.confirm(Intent.DeployApply, key, { previous });
      await journal.fact(OrchEvent.DeployApplied, { attempt, service: repo.service, previous, tag });
    }
    applied.push({ repo, intent, previous, healthcheck: (await target.verify(intent)).detail });
  }
  const addresses = await Promise.all(applied.map(async (a) => ({ ...a, url: await target.serviceUrl!(a.intent), gateUrl: await target.gateServiceUrl!(a.intent), network: target.gateNetwork?.(a.intent) })));
  const smoke: SmokeRow[] = [];
  const e2e: E2eRow[] = [];
  for (const a of addresses) {
    const urls = Object.fromEntries(addresses.filter((o) => o !== a).map((o) => [serviceUrlEnv(o.repo.service!), o.gateUrl]));
    const scope: GateScope = { service: a.repo.service!, plan: a.repo.plan, spec: specShare(deps.spec, a.repo.plan.tasks), urls };
    const s = await deps.smoke(a.repo.ws.repo, a.url, a.gateUrl, a.network, scope);
    if (!s.ok) return failed('smoke', s.detail, a.repo);
    smoke.push(...s.rows);
    if (deps.e2e && (e2eCommand(a.repo.plan) || deps.requireE2e)) {
      const e = await deps.e2e(a.repo.ws.repo, a.url, a.gateUrl, a.network, scope);
      if (!e.ok) return failed('e2e', e.detail, a.repo);
      e2e.push(...e.rows);
    }
  }
  // The first service stands in the fields Phase 6 and the validation page read; R12.5 shows every service.
  const [first] = addresses;
  const card = (a: (typeof addresses)[number]) => ({ service: a.repo.service, url: a.url, port: a.intent.port, healthcheck: a.healthcheck, healthcheckPath: a.intent.healthcheckPath, ...(a.repo.plan.deploy.kind ? { kind: a.repo.plan.deploy.kind } : {}), ...(a.repo.plan.deploy.docsPath ? { docsPath: a.repo.plan.deploy.docsPath } : {}) });
  const { service: _primary, ...primary } = card(first!);
  await journal.fact(OrchEvent.DeployVerified, { attempt, ...primary, smoke, ...(e2e.length ? { e2e } : {}), services: addresses.map(card) });
  return { ok: true };
}
