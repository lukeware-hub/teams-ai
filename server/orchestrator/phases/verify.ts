import type { FixTasksOutput } from '../../agents/outputs.js';
import type { Plan, PlanTask } from '../../contracts/plan.js';
import type { TestResult } from '../../evidence/junit.js';
import { buildEvidenceMatrix, readyForValidation, type EvidenceRow } from '../../evidence/matrix.js';
import type { GateResult } from '../../exec/gate-runner.js';
import { RunEvent } from '../../pipeline/run-state.js';
import type { StepOutcome } from '../../runner/step.js';
import { validatePlan } from '../../validators/plan.js';
import { OrchEvent } from '../events.js';
import { fixTasksPack } from '../steps.js';
import { checkoutMain, pauseForFailure, PAUSED_AUTH, type PhaseDeps } from './shared.js';

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

export async function runPhase4(deps: PhaseDeps, round: 1 | 2): Promise<Phase4Result> {
  if (!deps.plan || !deps.gates || !deps.tasks) throw new Error('Phase 4 needs plan, gates and tasks');
  const prior = deps.journal.events.find((e) => e.type === OrchEvent.VerificationPassed && e.data.round === round);
  if (prior) return { ok: true, matrix: prior.data.matrix as EvidenceRow[] };
  // Resumed after fix tasks were planned for this round: they are the answer, do not verify and plan again
  // (a second pass re-issued the same T900-fix-* ids and the reducer rejected them - 1387253335-001-r13).
  const plannedBefore = deps.journal.events.filter((e) => e.type === RunEvent.FixTasksPlanned && e.data.round === round);
  if (round === 1 && plannedBefore.length > 0) return { ok: false, reason: 'verification failed; fix tasks already planned', fixTasks: plannedBefore.flatMap((e) => e.data.tasks as PlanTask[]) };
  if (!deps.journal.events.some((e) => e.type === OrchEvent.PhaseStarted && e.data.phase === 4 && e.data.round === round)) await deps.journal.fact(OrchEvent.PhaseStarted, { phase: 4, round });
  await checkoutMain(deps);
  let results: GateResult[] = [], blocking: GateResult | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    ({ results, blockingFailure: blocking } = await deps.gates(deps.ws.repo, 'main'));
    if (!blocking || !['infra', 'environment', 'flaky-test'].includes(String(blocking.failure)) || attempt === 3) break;
  }
  for (const r of results) await deps.journal.fact(r.passed ? OrchEvent.GatePassed : OrchEvent.GateFailed, { phase: 4, round, gate: r.name, failure: r.failure, junit: r.junit ?? [] });
  const junit = dedupeJunit(results.flatMap((r) => r.junit ?? []));
  const matrix = buildEvidenceMatrix(deps.spec, deps.tasks(), junit);
  const failedTests = junit.filter((t) => t.status === 'failed').map((t) => t.id);
  const uncoveredAcs = matrix.filter((r) => r.status === 'missing').map((r) => r.criterion);
  if (!blocking && readyForValidation(matrix)) { await deps.journal.fact(OrchEvent.VerificationPassed, { round, matrix }); return { ok: true, matrix }; }
  await deps.journal.fact(OrchEvent.VerificationFailed, { round, failedTests, uncoveredAcs, matrix, gate: blocking?.name ?? null });
  if (round === 2) return { ok: false, reason: `verification failed in round 2: ${failedTests.length} failing tests, ${uncoveredAcs.length} uncovered criteria` };
  let feedback: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const out = await deps.runAgent<'fix-tasks'>({ kind: 'fix-tasks', role: 'sm', pack: fixTasksPack(deps.packBase(), { failedTests, tails: tail(results.map((r) => `${r.name}: ${r.stderrTail || r.stdoutTail}`).join('\n')), uncoveredAcs, plan: deps.plan, boundaries: deps.boundaries ? await deps.boundaries() : [], feedback }), cwd: deps.ws.repo, phase: 'phase4', taskId: null, attempt }) as StepOutcome<FixTasksOutput>;
    if (!out.ok) { if (await pauseForFailure(deps, out.failure)) return { ok: false, reason: PAUSED_AUTH }; feedback = out.errors.join('\n'); continue; }
    // Ids are assigned here and must stay unique across rounds and resumes.
    const existing = [...deps.journal.state.tasks.keys()].filter((id) => id.startsWith('T900-fix-')).length;
    const fixTasks = out.value.tasks.map((t, i) => ({ ...t, id: `T900-fix-${existing + i + 1}`, origin: 'fix' as const }));
    const errors = validatePlan({ ...deps.plan, tasks: [...deps.plan.tasks, ...fixTasks] }, deps.spec, { firstSpec: deps.firstSpec });
    if (errors.length) { feedback = errors.join('\n'); continue; }
    await deps.journal.fact(RunEvent.FixTasksPlanned, { tasks: fixTasks, round });
    return { ok: false, reason: 'verification failed; fix tasks planned', fixTasks };
  }
  return { ok: false, reason: `fix-tasks rejected twice: ${feedback ?? 'no answer'}` };
}
