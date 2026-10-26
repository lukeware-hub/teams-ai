import { parseAnyPlan, servicePlans, type Plan, type PlanTask, type ServiceView } from '../../contracts/plan.js';
import { specShare } from '../../contracts/spec.js';
import { assignDeployPort, portHeldByOthers, portKey, registeredPorts } from '../../deploy/port-registry.js';
import { composeProject, serviceComposeProject, sharedNetwork } from '../../deploy/docker-local.js';
import { runDeployment, type DeploymentIntent, type DeployStage } from '../../deploy/target.js';
import { e2eCommand, type E2eRow } from '../../exec/e2e.js';
import { serviceUrlEnv, type SmokeRow } from '../../exec/smoke.js';
import { RunEvent } from '../../pipeline/run-state.js';
import { TERMINAL_STATES } from '../../pipeline/task-state.js';
import { Intent, OrchEvent } from '../events.js';
import { E2E_CONTRACT, SMOKE_CONTRACT, uiCheckPack } from '../steps.js';
import { MISSING_VARIABLE } from '../../environment/service.js';
import { checkoutMain, withMainSnapshot, type GateScope, type PhaseDeps, type ServiceRepo } from './shared.js';
import { serviceWorkspace, type Workspace } from '../workspace.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ReviewOutput } from '../../agents/outputs.js';
import type { StoredEvent } from '../../store/event-store.js';
import { runArtifact } from './artifact.js';

/** `retryEnvironment`: a missing variable was created, so the same attempt runs again without a fix task. */
export type Phase5Result = { ok: true; url: string; smoke: SmokeRow[]; healthcheck: string; e2e?: E2eRow[] } | { ok: false; reason: string; fixTask?: PlanTask; retryEnvironment?: true };
export const MAX_DEPLOY_ATTEMPTS = 3;
/** How many times one attempt may run again because the environment step created what the failure said was missing. */
export const MAX_ENV_RERUNS = 2;

/** The plan's port, unless a failed deploy moved it to a free one. */
const deployPort = (deps: PhaseDeps) => Number([...deps.journal.events].reverse().find((e) => e.type === OrchEvent.DeployPortReassigned)?.data.to ?? deps.plan!.deploy.port);

const PORT_TAKEN = /port is already allocated/;
/** The start of a service whose container is gone: its daemon was recreated, so only a build brings it back. */
const NO_CONTAINER = /no container found/;

/** Draws a free port in place of `from`, never one of `avoid`, and records it; null when none is left. */
async function reassignPort(deps: PhaseDeps, from: number, service: string | null = null, avoid: readonly number[] = []): Promise<number | null> {
  if (!deps.workspacesRoot) return null;
  const { port } = await assignDeployPort(deps.workspacesRoot, portKey(deps.project.projectId, service), deps.exec, [from, ...avoid]);
  if (port !== null) await deps.journal.fact(OrchEvent.DeployPortReassigned, { from, to: port, ...(service ? { service } : {}) });
  return port;
}

/** A missing suite command is the plan's, which no agent edits: a deploy-fix task could only come back empty and burn tokens. */
const planGap = (stage: DeployStage, detail: string) => (stage === 'smoke' && detail === 'plan.commands.smoke missing') || (stage === 'e2e' && detail.startsWith('plan.commands.e2e missing'));

export function deployIntent(deps: PhaseDeps, tag: string): DeploymentIntent {
  const p = deps.plan!;
  if (p.deploy.image === undefined || p.deploy.healthcheckPath === undefined) throw new Error('deployIntent needs a container plan: a mobile plan has no image or healthcheck');
  return { projectId: deps.project.projectId, image: p.deploy.image, tag, port: deployPort(deps), healthcheckPath: p.deploy.healthcheckPath, manifests: [...p.deploy.manifests], secretNames: deps.secretNames ? deps.secretNames() : [...new Set(deps.spec.externalDependencies.flatMap((d) => d.secretNames))], contextDir: deps.ws.repo, ...(p.delivery?.compose ? { compose: p.delivery.compose } : {}) };
}

/** A service's port: the plan's, unless a failed deploy of that service moved it. */
const servicePort = (deps: PhaseDeps, repo: Pick<ServiceRepo, 'service' | 'plan'>) => Number([...deps.journal.events].reverse().find((e) => e.type === OrchEvent.DeployPortReassigned && e.data.service === repo.service)?.data.to ?? repo.plan.deploy.port);

/** A service deploys like a single plan, as its own compose project on the project's shared network. */
function serviceIntent(deps: PhaseDeps, repo: Pick<ServiceRepo, 'service' | 'plan' | 'ws'>, tag: string): DeploymentIntent {
  const service = repo.service!;
  return { ...deployIntent({ ...deps, plan: repo.plan, ws: repo.ws }, tag), port: servicePort(deps, repo), shared: { composeProject: serviceComposeProject(deps.project.projectId, service), network: sharedNetwork(deps.project.projectId), alias: service } };
}
/** The view of a service as the first spec on the project's main that declares it; null when none does. */
export async function declaredService(projectRepo: string, service: string): Promise<ServiceView | null> {
  const specs = await fs.readdir(path.join(projectRepo, 'docs', 'specs')).catch(() => [] as string[]);
  for (const spec of specs.sort()) {
    const text = await fs.readFile(path.join(projectRepo, 'docs', 'specs', spec, 'plan.json'), 'utf8').catch(() => null);
    if (text === null) continue;
    try {
      const view = servicePlans(parseAnyPlan(JSON.parse(text))).find((v) => v.service === service);
      if (view) return view;
    } catch {
      continue; // a plan that does not parse declares nothing here
    }
  }
  return null;
}
/** Dependency manifests of the supported stacks: a smoke or e2e fix may need to add a test dependency. */
const MANIFESTS = ['package.json', 'go.mod', 'go.sum', 'requirements.txt', 'pyproject.toml', 'Cargo.toml', 'Cargo.lock'];

/** What the deploy did after a failure (a teardown or a rollback): it says nothing about the failure itself. */
const OUTCOME = /; (?:first deploy failed|teardown of the failed first deploy|rollback (?:failed|verify failed)|after rollback)[\s\S]*$/;

/** First line with text of a deploy failure detail, without the outcome: the failing criteria, the stage or the docker cause. */
const headline = (detail: string): string => (detail.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '').replace(OUTCOME, '').slice(0, 300);

/** At most ten files, then how many more. */
const fileList = (files: readonly string[]): string => (files.length > 10 ? `${files.slice(0, 10).join(', ')} and ${files.length - 10} more` : files.join(', '));

/**
 * Every earlier deploy failure of the run with the fix task planned after it and what that fix changed, so a fix task
 * builds on the ones before it; when the previous fix merged and the same failure came back, it says to look elsewhere.
 */
function deployHistory(deps: PhaseDeps, attempt: number, stage: DeployStage, detail: string, service: string | null): string {
  const failures = new Map<number, { stage: string; detail: string; service: string | null; fix: string | null }>();
  let last: number | null = null;
  for (const e of deps.journal.events) {
    if (e.type === OrchEvent.DeployFailed) {
      // A resumed run can deploy an attempt it had already reached: that failure and its fix belong to no earlier attempt.
      last = Number(e.data.attempt) < attempt ? Number(e.data.attempt) : null;
      if (last !== null) failures.set(last, { stage: String(e.data.stage), detail: String(e.data.detail), service: (e.data.service as string | undefined) ?? null, fix: null });
    } else if (e.type === RunEvent.FixTasksPlanned && last !== null) {
      const fix = (e.data.tasks as PlanTask[]).find((t) => t.origin === 'deploy-fix');
      if (fix) failures.get(last)!.fix = fix.id;
    }
  }
  if (failures.size === 0) return '';
  const tasks = deps.journal.state.tasks;
  // A replanned fix lives on in its replacements: their states and their last commit are its outcome.
  const outcome = (id: string): { text: string; merged: boolean } => {
    const root = tasks.get(id);
    const parts = root?.state === 'superseded' && root.replacedBy.length > 0 ? root.replacedBy : [id];
    const states = parts.map((p) => tasks.get(p)?.state ?? 'planned');
    const commit = [...deps.journal.events].reverse().find((e) => e.type === OrchEvent.DevCommitted && parts.includes(String(e.data.taskId)));
    const who = parts[0] === id ? `${id} ${states[0]}` : `${id} replaced by ${parts.map((p, i) => `${p} ${states[i]}`).join(', ')}`;
    const what = commit ? `: ${String(commit.data.summary).slice(0, 300)} (files: ${fileList(commit.data.changedFiles as string[])})` : '';
    return { text: `${who}${what}`, merged: states.every((s) => s === 'merged') };
  };
  const lines = [...failures.entries()].sort(([a], [b]) => a - b).map(([n, f]) => `- attempt ${n} failed at ${f.stage}${f.service ? ` (service ${f.service})` : ''}: ${headline(f.detail)}${f.fix ? `\n  then ${outcome(f.fix).text}` : ''}`);
  const previous = failures.get(attempt - 1);
  const repeated = previous?.fix && outcome(previous.fix).merged && previous.stage === stage && previous.service === service && headline(previous.detail) === headline(detail);
  const note = repeated ? `\nThe fix of attempt ${attempt - 1} (${previous!.fix}) did not change this failure: look for another cause before changing the same lines again.` : '';
  return `\n\nEarlier deploy attempts of this run:\n${lines.join('\n')}${note}`;
}

// Ids are assigned here and must stay unique across attempts and resumes (a resumed attempt re-issued
// T950-deploy-fix-1 and the reducer rejected it - 1387253335-001-r13).
const fixTaskId = (deps: PhaseDeps) => `T950-deploy-fix-${[...deps.journal.state.tasks.keys()].filter((id) => id.startsWith('T950-deploy-fix-')).length + 1}`;
const fixTask = (deps: PhaseDeps, attempt: number, stage: DeployStage, detail: string, newPort: number | null = null, service: string | null = null): PlanTask => {
  const base = { id: fixTaskId(deps), title: `Fix deployment (${stage})`, criteriaRefs: [], dependsOn: [], origin: 'deploy-fix' as const };
  const history = deployHistory(deps, attempt, stage, detail, service);
  // A smoke failure is about the smoke tests, not the manifests: the Dev owns it and must know the contract.
  if (stage === 'smoke') {
    // The e2e suite runs next against the same service; fixing a request only in smoke failed the next attempt at e2e (live).
    const suite = deps.plan!.delivery?.e2eSuite;
    const e2e = suite ? `\n\nThe e2e suite (${suite}) runs right after smoke against the same service and usually makes the same requests: fix the same defect there too.` : '';
    return { ...base, description: `Deploy attempt ${attempt} succeeded but the smoke suite did not prove the smoke criteria: ${detail}${e2e}

Contract: ${SMOKE_CONTRACT}${history}`, affectedPaths: ['tests/smoke/**', 'tests/smoke', 'smoke/**', '**/*smoke*_test.go', 'vitest.config.ts', ...(suite ? [suite] : []), ...MANIFESTS], owner: 'dev' };
  }
  if (stage === 'e2e') {
    const suite = deps.plan!.delivery?.e2eSuite;
    return { ...base, description: `Deploy attempt ${attempt} succeeded and smoke passed but the e2e suite did not prove the acceptance criteria: ${detail}

Contract: ${E2E_CONTRACT}${history}`, affectedPaths: [...(suite ? [suite] : []), 'e2e/**', 'tests/e2e/**', ...MANIFESTS], owner: 'dev' };
  }
  if (stage === 'ui') {
    const screens = deps.plan!.tasks.filter((t) => t.owner === 'front').flatMap((t) => t.affectedPaths);
    return { ...base, title: `Fix UI check`, description: `Deploy attempt ${attempt} succeeded and the HTTP e2e suite passed but the browser check of a front-owned screen failed: ${detail}${history}`, affectedPaths: screens.length > 0 ? screens : ['web/**', 'src/**'], owner: 'front' };
  }
  const portHint = newPort === null ? '' : `\n\nThe host port is taken. Move the service to port ${newPort}: PORT=${newPort}, docker-compose publishes "${newPort}:${newPort}", and the Dockerfile, healthcheck and tests use ${newPort} too.`;
  return { ...base, description: `Deploy attempt ${attempt} failed at ${stage}: ${detail}${portHint}${history}`, affectedPaths: [...deps.plan!.deploy.manifests, 'Dockerfile'], owner: 'devops' };
};

/**
 * True when the screen of this service was already checked and passed, and no front task merged after that check:
 * a deploy that only failed for infrastructure reasons does not change the screen, so the check is not repeated.
 */
export function uiAlreadyChecked(events: readonly StoredEvent[], frontIds: readonly string[], service: string | null): boolean {
  let last = -1;
  events.forEach((e, i) => { if (e.type === OrchEvent.UiChecked && (e.data.service ?? null) === service) last = i; });
  if (last < 0 || events[last]!.data.decision === 'changes') return false;
  return !events.slice(last + 1).some((e) => e.type === RunEvent.TaskStateChanged && e.data.to === 'merged' && frontIds.includes(String(e.data.taskId)));
}

/** `defect` is a UI finding for the front Dev; `error` means the check never ran, so nothing is rolled back. */
async function runUiCheck(deps: PhaseDeps, opts: { url: string; plan: Plan; ws: Workspace; attempt: number; service?: string | null }): Promise<{ defect: string | null; error: string | null }> {
  const fronts = opts.plan.tasks.filter((t) => t.owner === 'front');
  // The first front task names the step; the pack carries every front task.
  const [front] = fronts;
  if (!front) return { defect: null, error: null };
  // Front tasks include the deploy-fix tasks of a failed UI check, which are not in the plan.
  const frontIds = [...deps.journal.state.tasks].filter(([, t]) => t.def.owner === 'front').map(([id]) => id);
  if (uiAlreadyChecked(deps.journal.events, frontIds, opts.service ?? null)) return { defect: null, error: null };
  // A check that fails (timeout, rate limit, sandbox) runs once more; the snapshot keeps its edits out of the checkout.
  const check = (cwd: string) => deps.runAgent<'ui-check'>({
    kind: 'ui-check',
    role: 'test',
    pack: uiCheckPack(deps.packBase(), fronts, { serviceUrl: opts.url }),
    cwd,
    phase: 'phase5',
    taskId: front.id,
    attempt: opts.attempt,
    extraEnv: { SERVICE_URL: opts.url },
  });
  const outcome = await withMainSnapshot(opts.ws, deps.exec, async (cwd) => {
    const first = await check(cwd);
    return first.ok ? first : check(cwd);
  });
  if (!outcome.ok) return { defect: null, error: outcome.errors.join('\n') };
  const value = outcome.value as ReviewOutput;
  await deps.journal.fact(OrchEvent.UiChecked, { taskId: front.id, decision: value.decision, findings: value.findings, ...(opts.service ? { service: opts.service } : {}) });
  if (value.skillRequest) await deps.journal.fact(OrchEvent.SkillRequested, { taskId: front.id, role: 'test', ...value.skillRequest });
  if (value.decision !== 'changes') return { defect: null, error: null };
  return { defect: value.findings.map((f) => `- ${f.file}${f.line === null ? '' : `:${f.line}`} [${f.severity}] ${f.problem}`).join('\n') || 'UI check requested changes', error: null };
}

/** Resuming a new process restarts postPhases()'s attempt loop at 1; without this it replayed attempt 1's
 * already-resolved failure on every resume (new fix task, wasted tokens, never reaching later attempts -
 * 1387253335-001-r13). Each root deploy-fix task (not its `-rN` replan children) that reached a terminal
 * state stands for one attempt cycle that is done; the next attempt starts after all of them. */
export function deployStartAttempt(deps: PhaseDeps): 1 | 2 | 3 {
  const tasks = deps.journal.state.tasks;
  // A replanned fix finishes its attempt once every replacement ended; until then the attempt is still open.
  const ended = (t: { state: string; replacedBy: string[] }) => ['merged', 'blocked'].includes(t.state) || (t.state === 'superseded' && t.replacedBy.length > 0 && t.replacedBy.every((r) => TERMINAL_STATES.has(tasks.get(r)?.state ?? 'planned')));
  const done = [...tasks.entries()].filter(([id, t]) => /^T950-deploy-fix-\d+$/.test(id) && ended(t)).length;
  return Math.min(1 + done, 3) as 1 | 2 | 3;
}

/** `fixTasks: false` (deploy-only runs): a failure is reported, never turned into agent work. */
export async function runPhase5(deps: PhaseDeps, attempt: 1 | 2 | 3, opts: { fixTasks?: boolean; envRerun?: number } = {}): Promise<Phase5Result> {
  if (!deps.plan || !deps.target || !deps.smoke) throw new Error('Phase 5 needs plan, target and smoke');
  const done = deps.journal.events.find((e) => e.type === OrchEvent.DeployVerified && e.data.attempt === attempt);
  if (done) return { ok: true, url: String(done.data.url), smoke: done.data.smoke as SmokeRow[], healthcheck: String(done.data.healthcheck), ...(done.data.e2e ? { e2e: done.data.e2e as E2eRow[] } : {}) };
  if (!deps.journal.events.some((e) => e.type === OrchEvent.PhaseStarted && e.data.phase === 5)) await deps.journal.fact(OrchEvent.PhaseStarted, { phase: 5 });
  const tag = await checkoutMain(deps);
  if (deps.plan!.deploy.kind === 'mobile') return runArtifact(deps, attempt);
  let intent = deployIntent(deps, tag); const envRerun = opts.envRerun ?? 0; const key = `deploy-${attempt}${envRerun > 0 ? `-e${envRerun}` : ''}`;
  await deps.environment?.prepare({ service: null, dir: deps.ws.repo, plan: deps.plan }, null);
  const failed = async (stage: DeployStage, detail: string, rolledBack: boolean, rollbackHealthy: boolean | null, previous: string | null): Promise<Phase5Result> => {
    await deps.journal.fact(OrchEvent.DeployFailed, { attempt, stage, detail, rolledBack, rollbackHealthy, tag });
    if (rolledBack) await deps.journal.fact(OrchEvent.RollbackDone, { attempt, previous });
    // A variable the failure says is missing is made up by the environment step and the same attempt runs again: no fix task could provide it.
    if (envRerun < MAX_ENV_RERUNS && deps.environment && MISSING_VARIABLE.test(detail) && (await deps.environment.prepare({ service: null, dir: deps.ws.repo, plan: deps.plan! }, detail))) return { ok: false, reason: `deploy failed at ${stage}: a missing variable was created, retrying`, retryEnvironment: true };
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
    if (await portHeldByOthers(deps.exec, composeProject(deps.project.projectId), intent.port)) {
      // No agent follows a deploy-only run, and the compose is published on whatever port the intent holds: take a free one.
      const moved = opts.fixTasks === false ? await reassignPort(deps, intent.port) : null;
      if (moved === null) return failed('apply', `Bind for 0.0.0.0:${intent.port} failed: port is already allocated`, false, null, null);
      intent = { ...intent, port: moved };
    }
    await deps.journal.intent(Intent.DeployApply, key, { attempt, image: intent.image, tag, intent });
    const r = await runDeployment(deps.target, intent, { smoke: async () => ({ ok: true, detail: 'journaled separately' }), baseUrl: '' });
    if (!r.ok) return failed(r.stage, r.detail, r.rolledBack, r.rollbackHealthy, null);
    previous = r.previous; await deps.journal.confirm(Intent.DeployApply, key, { previous }); await deps.journal.fact(OrchEvent.DeployApplied, { attempt, previous, tag });
    healthcheck = (await deps.target.verify(intent)).detail;
  }
  let url: string; let gateUrl: string | undefined; let gateNet: string | undefined; try { url = await (deps.target.serviceUrl ? deps.target.serviceUrl(intent) : ''); gateUrl = deps.target.gateServiceUrl ? await deps.target.gateServiceUrl(intent) : undefined; gateNet = deps.target.gateNetwork?.(intent); } catch (e) { return failed('verify', (e as Error).message, false, null, previous); }
  await deps.environment?.mint({ [deps.project.projectId]: gateUrl ?? url });
  const s = await deps.smoke(deps.ws.repo, url, gateUrl, gateNet); if (!s.ok) { let rb = false; let rh: boolean | null = null; if (previous) { await deps.target.rollback(intent, previous); rb = true; rh = (await deps.target.verify(intent)).healthy; } else await deps.target.destroy(intent).catch(() => undefined); return failed('smoke', s.detail, rb, rh, previous); }
  // The e2e suite runs only against a deployment whose smoke already passed (roadmap R8.4). Legacy plans without commands.e2e skip it unless the run requires it.
  let e2eRows: E2eRow[] | undefined;
  if (deps.e2e && (e2eCommand(deps.plan) || deps.requireE2e)) {
    const e = await deps.e2e(deps.ws.repo, url, gateUrl, gateNet);
    if (!e.ok) { let rb = false; let rh: boolean | null = null; if (previous) { await deps.target.rollback(intent, previous); rb = true; rh = (await deps.target.verify(intent)).healthy; } else await deps.target.destroy(intent).catch(() => undefined); return failed('e2e', e.detail, rb, rh, previous); }
    e2eRows = e.rows;
  }
  const ui = await runUiCheck(deps, { url, plan: deps.plan!, ws: deps.ws, attempt });
  if (ui.error !== null) return { ok: false, reason: `UI check did not run; the deploy stays up: ${ui.error}` };
  if (ui.defect !== null) { let rb = false; let rh: boolean | null = null; if (previous) { await deps.target.rollback(intent, previous); rb = true; rh = (await deps.target.verify(intent)).healthy; } else await deps.target.destroy(intent).catch(() => undefined); return failed('ui', ui.defect, rb, rh, previous); }
  await deps.journal.fact(OrchEvent.DeployVerified, { attempt, url, smoke: s.rows, healthcheck, tag, port: intent.port, healthcheckPath: intent.healthcheckPath, ...(deps.plan!.deploy.kind ? { kind: deps.plan!.deploy.kind } : {}), ...(deps.plan!.deploy.docsPath ? { docsPath: deps.plan!.deploy.docsPath } : {}), ...(e2eRows ? { e2e: e2eRows } : {}) }); return { ok: true, url, smoke: s.rows, healthcheck, ...(e2eRows ? { e2e: e2eRows } : {}) };
}

/**
 * R12.4: the platform first, then every service on the shared network, then each service's smoke and e2e suites with the
 * other services' addresses. A failure rolls back every service this attempt applied; the fix goes to the failing service.
 */
export async function runServicesPhase5(deps: PhaseDeps, attempt: 1 | 2 | 3, opts: { fixTasks?: boolean; envRerun?: number } = {}): Promise<{ ok: true } | { ok: false; reason: string; fixTask?: PlanTask; retryEnvironment?: true }> {
  const envRerun = opts.envRerun ?? 0;
  const { journal, target, services } = deps;
  if (!services || !target || !deps.smoke) throw new Error('Phase 5 needs the services, target and smoke');
  if (journal.events.some((e) => e.type === OrchEvent.DeployVerified && e.data.attempt === attempt)) return { ok: true };
  if (!journal.events.some((e) => e.type === OrchEvent.PhaseStarted && e.data.phase === 5)) await journal.fact(OrchEvent.PhaseStarted, { phase: 5 });
  // Every service is checked out and has a compose file before any is applied: nothing is left half deployed.
  const tags: string[] = [];
  for (const repo of services.repos) tags.push(await checkoutMain({ ...deps, ws: repo.ws }));
  const intents = services.repos.map((repo, i) => serviceIntent(deps, repo, tags[i]!));
  for (const repo of services.repos) await deps.environment?.prepare({ service: repo.service, dir: repo.ws.repo, plan: repo.plan }, null);
  const applied: Array<{ repo: ServiceRepo; intent: DeploymentIntent; previous: string | null; healthcheck: string }> = [];
  const failed = async (stage: DeployStage | 'platform', detail: string, repo: ServiceRepo | null, own: { intent?: DeploymentIntent; rolledBack?: boolean; rollbackHealthy?: boolean | null; fixable?: boolean } = {}) => {
    // Every applied service goes back to its previous image, or away when this was its first deploy; a failed rollback is said.
    const restored: string[] = own.rolledBack && repo ? [repo.service!] : [];
    const broken: string[] = [];
    for (const a of [...applied].reverse()) {
      try {
        if (a.previous) {
          await target.rollback(a.intent, a.previous);
          restored.push(a.repo.service!);
        } else await target.destroy(a.intent);
      } catch (err) {
        broken.push(`${a.repo.service}: ${(err as Error).message}`);
      }
    }
    const rolledBack = restored.length > 0 && broken.length === 0;
    await journal.fact(OrchEvent.DeployFailed, { attempt, stage, detail: `${detail}${broken.length > 0 ? `; rollback failed for ${broken.join('; ')}` : ''}`, rolledBack, rollbackHealthy: broken.length > 0 ? false : own.rollbackHealthy ?? null, ...(repo ? { service: repo.service } : {}) });
    if (rolledBack) await journal.fact(OrchEvent.RollbackDone, { attempt, services: restored });
    // A variable the failure says is missing is made up by the environment step and the same attempt runs again: no fix task could provide it.
    if (repo && envRerun < MAX_ENV_RERUNS && deps.environment && MISSING_VARIABLE.test(detail) && (await deps.environment.prepare({ service: repo.service, dir: repo.ws.repo, plan: repo.plan }, detail))) return { ok: false as const, reason: `deploy failed at ${stage} (${repo.service}): a missing variable was created, retrying`, retryEnvironment: true as const };
    // The platform comes from the docs, never from the code: no task could fix it.
    if (!repo || attempt >= 3 || opts.fixTasks === false) return { ok: false as const, reason: `deploy failed on attempt ${attempt} at ${stage}${repo ? ` (${repo.service})` : ''}: ${detail}` };
    if (own.fixable === false || planGap(stage as DeployStage, detail)) return { ok: false as const, reason: `deploy failed at ${stage} (${repo.service}): ${detail}` };
    // A taken port moves only now that a fix task follows, and never onto the port of another service of the plan.
    const newPort = stage === 'apply' && own.intent && PORT_TAKEN.test(detail) ? await reassignPort(deps, own.intent.port, repo.service!, services.repos.map((r) => servicePort(deps, r))) : null;
    const task = { ...fixTask({ ...deps, plan: repo.plan }, attempt, stage as DeployStage, detail, newPort, repo.service!), service: repo.service! };
    await journal.fact(RunEvent.FixTasksPlanned, { tasks: [task] });
    return { ok: false as const, reason: `deploy failed at ${stage} (${repo.service}); deploy-fix task planned`, fixTask: task };
  };
  // Without a compose file a service would take the project's single container: a plan gap, not code to fix.
  const bare = services.repos.find((_, i) => !intents[i]!.compose);
  if (bare) return failed('validate', `services.${bare.service}.delivery.compose is missing: each service deploys as its own compose project`, bare, { fixable: false });
  const platform = await (target.startPlatform ? target.startPlatform(deps.project.projectId, deps.project.platform ?? []) : Promise.resolve({ ok: true, detail: '' })).catch((err: Error) => ({ ok: false, detail: err.message }));
  if (!platform.ok) return failed('platform', platform.detail, null);
  for (const [i, repo] of services.repos.entries()) {
    const intent = intents[i]!;
    const key = `deploy-${repo.service}-${attempt}${envRerun > 0 ? `-e${envRerun}` : ''}`;
    if (journal.isConfirmed(Intent.DeployApply, key)) {
      const previous = ([...journal.events].reverse().find((e) => e.kind === 'confirm' && e.intentId === `${Intent.DeployApply}:${key}`)?.data.previous as string | null | undefined) ?? null;
      // A resumed run proves the service still answers before its suites run, as runPhase5 does.
      const health = await target.verify(intent);
      if (!health.healthy) return failed('verify', health.detail, repo, { intent });
      applied.push({ repo, intent, previous, healthcheck: health.detail });
      continue;
    }
    await journal.intent(Intent.DeployApply, key, { attempt, service: repo.service, image: intent.image, tag: tags[i], intent });
    const r = await runDeployment(target, intent, { smoke: async () => ({ ok: true, detail: 'journaled separately' }), baseUrl: '' });
    if (!r.ok) return failed(r.stage, r.detail, repo, { intent, rolledBack: r.rolledBack, rollbackHealthy: r.rollbackHealthy });
    await journal.confirm(Intent.DeployApply, key, { previous: r.previous });
    await journal.fact(OrchEvent.DeployApplied, { attempt, service: repo.service, previous: r.previous, tag: tags[i] });
    applied.push({ repo, intent, previous: r.previous, healthcheck: (await target.verify(intent)).detail });
  }
  const addresses: Array<(typeof applied)[number] & { url: string; gateUrl: string; network: string | undefined }> = [];
  for (const a of applied) {
    try {
      const url = target.serviceUrl ? await target.serviceUrl(a.intent) : '';
      addresses.push({ ...a, url, gateUrl: target.gateServiceUrl ? await target.gateServiceUrl(a.intent) : url, network: target.gateNetwork?.(a.intent) });
    } catch (err) {
      return failed('verify', (err as Error).message, a.repo, { intent: a.intent });
    }
  }
  // A service this spec does not change still runs from an earlier spec: its registered port reaches it on the shared network.
  const registry = deps.workspacesRoot ? await registeredPorts(deps.workspacesRoot) : {};
  const untouchedServices = (deps.project.services ?? []).filter((s) => !services.repos.some((r) => r.service === s) && registry[portKey(deps.project.projectId, s)]);
  const untouched = untouchedServices.map((s) => [serviceUrlEnv(s), `http://${s}:${registry[portKey(deps.project.projectId, s)]}`] as const);
  // They may have stopped since their own spec (a restart of the host): start them again, and say so when one cannot, so the failure reads as the environment's.
  const started = await Promise.all(untouchedServices.map(async (s) => [s, await (target.ensureRunning?.(deps.project.projectId, s) ?? { ok: true, detail: '' })] as const));
  // A service whose container is gone is built again from the plan of its spec; without one the start failure stands.
  const restore = async (service: string): Promise<{ ok: boolean; detail: string } | null> => {
    const view = await declaredService(deps.ws.repo, service);
    if (!view) return null;
    const ws = serviceWorkspace(deps.ws, service);
    try {
      const tag = await checkoutMain({ ...deps, ws });
      // Consumers address the service on the port the registry holds, so the rebuilt one keeps it.
      const intent = { ...serviceIntent(deps, { service, plan: view.plan, ws }, tag), port: registry[portKey(deps.project.projectId, service)] ?? view.plan.deploy.port };
      await deps.environment?.prepare({ service, dir: ws.repo, plan: view.plan }, null);
      await target.apply(intent);
      const health = await target.verify(intent);
      return { ok: health.healthy, detail: health.healthy ? 'running' : health.detail };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  };
  const revived: Array<readonly [string, { ok: boolean; detail: string }]> = [];
  for (const [s, r] of started) revived.push([s, r.ok || !NO_CONTAINER.test(r.detail) ? r : ((await restore(s)) ?? r)]);
  const down = revived.filter(([, r]) => !r.ok).map(([s, r]) => `${s}: ${r.detail}`);
  const withEnvironment = (detail: string) => (down.length > 0 ? `${detail}\n\nenvironment: a service of an earlier spec is not running (${down.join('; ')})` : detail);
  // A service of another spec that never published has no address; a suite that fails reaching it needs that spec, not a fix task.
  const unpublished = (deps.project.services ?? []).filter((s) => !services.repos.some((r) => r.service === s) && !registry[portKey(deps.project.projectId, s)]);
  // The name counts only where it is an address (a URL host, a failed DNS lookup, host:port) or its variable: a short name such as `api` also sits in every /api/ path.
  const unreachable = (detail: string) => unpublished.filter((s) => new RegExp(`(?:\\/\\/|lookup\\s+|host\\s+|ENOTFOUND\\s+|EAI_AGAIN\\s+|getaddrinfo\\s+)${s}(?![\\w-])|(?<![\\w/-])${s}:\\d+`).test(detail) || detail.includes(serviceUrlEnv(s)));
  const suiteFailed = (stage: 'smoke' | 'e2e', detail: string, repo: ServiceRepo) => {
    const missing = unreachable(detail);
    return missing.length > 0 ? failed(stage, `environment: ${missing.join(', ')} of another spec was never published, so the suites cannot reach it; deliver that spec first\n\n${detail}`, null) : failed(stage, withEnvironment(detail), repo);
  };
  // The services this run deployed and the ones earlier specs left running: the only addresses a minted value may be asked from.
  await deps.environment?.mint({ ...Object.fromEntries(untouchedServices.map((s) => [s, `http://${s}:${registry[portKey(deps.project.projectId, s)]}`])), ...Object.fromEntries(addresses.map((a) => [a.repo.service!, a.gateUrl])) });
  const smoke: SmokeRow[] = [];
  const e2e: E2eRow[] = [];
  for (const a of addresses) {
    const urls = Object.fromEntries([...untouched, ...addresses.filter((o) => o !== a).map((o) => [serviceUrlEnv(o.repo.service!), o.gateUrl] as const)]);
    const scope: GateScope = { service: a.repo.service!, plan: a.repo.plan, spec: specShare(deps.spec, a.repo.plan.tasks), urls };
    const s = await deps.smoke(a.repo.ws.repo, a.url, a.gateUrl, a.network, scope);
    if (!s.ok) return suiteFailed('smoke', s.detail, a.repo);
    smoke.push(...s.rows.map((r) => ({ ...r, service: a.repo.service! })));
    if (deps.e2e && (e2eCommand(a.repo.plan) || deps.requireE2e)) {
      const e = await deps.e2e(a.repo.ws.repo, a.url, a.gateUrl, a.network, scope);
      if (!e.ok) return suiteFailed('e2e', e.detail, a.repo);
      e2e.push(...e.rows);
    }
    const ui = await runUiCheck(deps, { url: a.url, plan: a.repo.plan, ws: a.repo.ws, attempt, service: a.repo.service });
    if (ui.error !== null) return { ok: false as const, reason: `UI check did not run (${a.repo.service}); the deploy stays up: ${ui.error}` };
    if (ui.defect !== null) return failed('ui', ui.defect, a.repo);
  }
  // The first service stands in the fields Phase 6 and the validation page read; R12.5 shows every service.
  const [first] = addresses;
  const card = (a: (typeof addresses)[number]) => ({ service: a.repo.service, url: a.url, port: a.intent.port, healthcheck: a.healthcheck, healthcheckPath: a.intent.healthcheckPath, ...(a.repo.plan.deploy.kind ? { kind: a.repo.plan.deploy.kind } : {}), ...(a.repo.plan.deploy.docsPath ? { docsPath: a.repo.plan.deploy.docsPath } : {}) });
  const { service: _primary, ...primary } = card(first!);
  await journal.fact(OrchEvent.DeployVerified, { attempt, ...primary, smoke, ...(e2e.length ? { e2e } : {}), services: addresses.map(card) });
  return { ok: true };
}
