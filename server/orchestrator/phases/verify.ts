import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FixTasksOutput } from '../../agents/outputs.js';
import { DELIVERY_PATH_FIELDS, type Plan, type PlanTask } from '../../contracts/plan.js';
import type { TestResult } from '../../evidence/junit.js';
import { buildEvidenceMatrix, readyForValidation, type EvidenceRow } from '../../evidence/matrix.js';
import type { GateResult } from '../../exec/gate-runner.js';
import { RunEvent } from '../../pipeline/run-state.js';
import type { StepOutcome } from '../../runner/step.js';
import { scaffoldId, validatePlan, validateServicesPlan } from '../../validators/plan.js';
import { missingReadmeSections } from '../../validators/docs.js';
import { unpinnedBaseImages } from '../../validators/pinned-image.js';
import { OrchEvent } from '../events.js';
import { fixTasksPack } from '../steps.js';
import { checkoutMain, pauseForFailure, PAUSED_AUTH, type PhaseDeps, type ServiceRepo } from './shared.js';

const WEIGHT: Record<TestResult['status'], number> = { skipped: 0, passed: 1, failed: 2 };
/** One result per test id, the strongest wins: the smoke suite is skipped under the unit gate and shares ids with the unit tests. */
export function dedupeJunit(all: TestResult[]): TestResult[] {
  const byId = new Map<string, TestResult>();
  for (const t of all) {
    const prev = byId.get(t.id);
    if (!prev || WEIGHT[t.status] > WEIGHT[prev.status]) byId.set(t.id, t);
  }
  return [...byId.values()];
}

export type Phase4Result = { ok: true; matrix: EvidenceRow[] } | { ok: false; reason: string; fixTasks?: PlanTask[] };
const tail = (s: string) => s.length > 2000 ? s.slice(-2000) : s;

interface MissingItem { field: string; target: string; detail?: string }

async function missingItems(repo: string, plan: Plan): Promise<MissingItem[]> {
  const missing: MissingItem[] = [];
  for (const field of DELIVERY_PATH_FIELDS) {
    const rel = plan.delivery?.[field];
    if (!rel) continue;
    const present = await fs.stat(path.join(repo, rel)).then(() => true, () => false);
    if (!present) missing.push({ field, target: rel });
  }
  // README sections are checked only when docs/README.md already exists on main: Phase 6 writes the docs
  // after Phase 4/5, so before that a missing file is the normal state and not a delivery failure. Once the
  // file exists (a rerun, `spec readme`, an earlier docs PR) its headings must carry the planned sections.
  const sections = plan.delivery?.readmeSections ?? [];
  const readme = sections.length ? await fs.readFile(path.join(repo, 'docs', 'README.md'), 'utf8').catch(() => null) : null;
  if (readme !== null) for (const section of missingReadmeSections(readme, sections)) missing.push({ field: 'readmeSections', target: section });
  // The lockfile's name is never assumed (roadmap R10.2): the SM names its own stack's file, this only checks
  // that the path it named is actually on main.
  if (plan.lockfilePath) {
    const present = await fs.stat(path.join(repo, plan.lockfilePath)).then(() => true, () => false);
    if (!present) missing.push({ field: 'lockfilePath', target: plan.lockfilePath });
  }
  // Not a missing file, but reported through the same fix-task path: the Dockerfile exists but a FROM line is
  // unpinned (roadmap R10.2).
  if (plan.delivery?.dockerfile) {
    const text = await fs.readFile(path.join(repo, plan.delivery.dockerfile), 'utf8').catch(() => null);
    if (text !== null) {
      const unpinned = unpinnedBaseImages(text);
      if (unpinned.length > 0) missing.push({ field: 'dockerfilePinning', target: plan.delivery.dockerfile, detail: `unpinned base image(s): ${unpinned.join(', ')}` });
    }
  }
  return missing;
}

/** Delivery files listed in the plan that are absent from the checked-out main (roadmap R8.1). */
export async function missingDelivery(repo: string, plan: Plan): Promise<string[]> {
  return (await missingItems(repo, plan)).map((m) => `${m.field}: ${m.target}`);
}

const DEVOPS_FIELDS = new Set(['dockerfile', 'compose', 'ciWorkflow', 'releaseWorkflow', 'dockerfilePinning']);

/** Deterministic fix tasks for a missing delivery: devops owns Dockerfile, compose and workflows; the dev owns the e2e suite, lockfile and README. */
function deliveryFixTasks(items: readonly MissingItem[], existing: number, dependsOn: string[]): PlanTask[] {
  const groups: Array<{ owner: 'dev' | 'devops'; items: MissingItem[] }> = [
    { owner: 'devops', items: items.filter((m) => DEVOPS_FIELDS.has(m.field)) },
    { owner: 'dev', items: items.filter((m) => !DEVOPS_FIELDS.has(m.field)) },
  ];
  return groups.filter((g) => g.items.length > 0).map((g, i) => {
    const paths = g.items.filter((m) => m.field !== 'readmeSections').map((m) => m.target);
    return {
      id: `T900-fix-${existing + i + 1}`,
      title: `Deliver missing ${g.owner === 'devops' ? 'infrastructure' : 'e2e suite and docs'} files`,
      description: `The delivery contract is not met on main. Provide: ${g.items.map((m) => `${m.field} ${m.target}${m.detail ? ` (${m.detail})` : ''}`).join('; ')}. Use the plan's delivery paths exactly.`,
      criteriaRefs: [],
      dependsOn,
      affectedPaths: paths.length ? paths : ['docs/README.md'],
      owner: g.owner,
      origin: 'fix' as const,
    };
  });
}

/** Fix tasks join the plan they fix and must keep it valid: one repository's plan, or the whole services plan. */
function fixTaskErrors(deps: PhaseDeps, fixTasks: readonly PlanTask[]): string[] {
  const services = deps.services;
  if (!services) return validatePlan({ ...deps.plan!, tasks: [...deps.plan!.tasks, ...fixTasks] }, deps.spec, { firstSpec: deps.firstSpec });
  const newServices = new Set(services.repos.filter((r) => r.firstSpec).map((r) => r.service!));
  return validateServicesPlan({ ...services.plan, tasks: [...services.plan.tasks, ...fixTasks] }, deps.spec, { services: Object.keys(services.plan.services), newServices });
}

export async function runPhase4(deps: PhaseDeps, round: 1 | 2): Promise<Phase4Result> {
  const repos: ServiceRepo[] = deps.services?.repos ?? (deps.plan && deps.gates ? [{ service: null, plan: deps.plan, ws: deps.ws, firstSpec: deps.firstSpec, gates: deps.gates }] : []);
  if (repos.length === 0 || !deps.tasks) throw new Error('Phase 4 needs plan, gates and tasks');
  const prior = deps.journal.events.find((e) => e.type === OrchEvent.VerificationPassed && e.data.round === round);
  if (prior) return { ok: true, matrix: prior.data.matrix as EvidenceRow[] };
  // Resumed after fix tasks were planned for this round: they are the answer, do not verify and plan again
  // (a second pass re-issued the same T900-fix-* ids and the reducer rejected them - 1387253335-001-r13).
  const plannedBefore = deps.journal.events.filter((e) => e.type === RunEvent.FixTasksPlanned && e.data.round === round);
  if (round === 1 && plannedBefore.length > 0) return { ok: false, reason: 'verification failed; fix tasks already planned', fixTasks: plannedBefore.flatMap((e) => e.data.tasks as PlanTask[]) };
  if (!deps.journal.events.some((e) => e.type === OrchEvent.PhaseStarted && e.data.phase === 4 && e.data.round === round)) await deps.journal.fact(OrchEvent.PhaseStarted, { phase: 4, round });
  const missing: Array<{ repo: ServiceRepo; items: MissingItem[] }> = [];
  for (const repo of repos) {
    await checkoutMain({ ...deps, ws: repo.ws });
    const items = await missingItems(repo.ws.repo, repo.plan);
    if (items.length > 0) missing.push({ repo, items });
  }
  if (missing.length > 0) {
    const absent = missing.flatMap(({ repo, items }) => items.map((m) => `${repo.service ? `${repo.service}: ` : ''}${m.field}: ${m.target}`));
    const reason = `delivery contract not met on main, missing: ${absent.join(', ')}`;
    await deps.journal.fact(OrchEvent.VerificationFailed, { round, failedTests: [], uncoveredAcs: [], matrix: [], gate: 'delivery', missingDelivery: absent });
    if (round === 2) return { ok: false, reason };
    // Round 1 spends the existing round budget on one automatic fix round; round 2 is the verdict.
    let existing = [...deps.journal.state.tasks.keys()].filter((id) => id.startsWith('T900-fix-')).length;
    const fixTasks = missing.flatMap(({ repo, items }) => {
      const scaffold = scaffoldId(repo.service);
      const tasks = deliveryFixTasks(items, existing, repo.firstSpec && repo.plan.tasks.some((t) => t.id === scaffold) ? [scaffold] : []);
      existing += tasks.length;
      return repo.service ? tasks.map((t) => ({ ...t, service: repo.service! })) : tasks;
    });
    const errors = fixTaskErrors(deps, fixTasks);
    if (errors.length) return { ok: false, reason: `${reason}; fix tasks rejected: ${errors.join('; ')}` };
    await deps.journal.fact(RunEvent.FixTasksPlanned, { tasks: fixTasks, round });
    return { ok: false, reason: `${reason}; fix tasks planned`, fixTasks };
  }
  const results: GateResult[] = [];
  let blocking: GateResult | null = null;
  let failing: ServiceRepo | undefined;
  for (const repo of repos) {
    let own: GateResult[] = [];
    let fail: GateResult | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      ({ results: own, blockingFailure: fail } = await repo.gates(repo.ws.repo, 'main'));
      if (!fail || !['infra', 'environment', 'flaky-test'].includes(String(fail.failure)) || attempt === 3) break;
    }
    for (const r of own) await deps.journal.fact(r.passed ? OrchEvent.GatePassed : OrchEvent.GateFailed, { phase: 4, round, gate: r.name, failure: r.failure, junit: r.junit ?? [], ...(repo.service ? { service: repo.service } : {}) });
    results.push(...own);
    if (fail && !blocking) [blocking, failing] = [fail, repo];
  }
  const junit = dedupeJunit(results.flatMap((r) => r.junit ?? []));
  const matrix = buildEvidenceMatrix(deps.spec, deps.tasks(), junit);
  const failedTests = junit.filter((t) => t.status === 'failed').map((t) => t.id);
  const uncoveredAcs = matrix.filter((r) => r.status === 'missing').map((r) => r.criterion);
  if (!blocking && readyForValidation(matrix)) { await deps.journal.fact(OrchEvent.VerificationPassed, { round, matrix }); return { ok: true, matrix }; }
  await deps.journal.fact(OrchEvent.VerificationFailed, { round, failedTests, uncoveredAcs, matrix, gate: blocking?.name ?? null });
  if (round === 2) return { ok: false, reason: `verification failed in round 2: ${failedTests.length} failing tests, ${uncoveredAcs.length} uncovered criteria` };
  let feedback: string | null = null;
  const services = deps.services;
  // The SM plans across every service: their tasks and test gates, from the repository that failed.
  const plan = services ? { tasks: services.plan.tasks, gates: repos.flatMap((r) => r.plan.gates) } : deps.plan!;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const out = await deps.runAgent<'fix-tasks'>({ kind: 'fix-tasks', role: 'sm', pack: fixTasksPack(deps.packBase(), { failedTests, tails: tail(results.map((r) => `${r.name}: ${r.stderrTail || r.stdoutTail}`).join('\n')), uncoveredAcs, plan, ...(services ? { services: Object.keys(services.plan.services) } : {}), boundaries: deps.boundaries ? await deps.boundaries() : [], feedback }), cwd: (failing ?? repos[0]!).ws.repo, phase: 'phase4', taskId: null, attempt }) as StepOutcome<FixTasksOutput>;
    if (!out.ok) { if (await pauseForFailure(deps, out.failure)) return { ok: false, reason: PAUSED_AUTH }; feedback = out.errors.join('\n'); continue; }
    // Ids are assigned here and must stay unique across rounds and resumes.
    const existing = [...deps.journal.state.tasks.keys()].filter((id) => id.startsWith('T900-fix-')).length;
    const fixTasks = out.value.tasks.map((t, i) => ({ ...t, id: `T900-fix-${existing + i + 1}`, origin: 'fix' as const }));
    const errors = fixTaskErrors(deps, fixTasks);
    if (errors.length) { feedback = errors.join('\n'); continue; }
    await deps.journal.fact(RunEvent.FixTasksPlanned, { tasks: fixTasks, round });
    return { ok: false, reason: 'verification failed; fix tasks planned', fixTasks };
  }
  return { ok: false, reason: `fix-tasks rejected twice: ${feedback ?? 'no answer'}` };
}
