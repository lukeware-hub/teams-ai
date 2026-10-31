import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PlanTask } from '../../server/contracts/plan.js';
import { execCommand } from '../../server/exec/command.js';
import type { GateResult } from '../../server/exec/gate-runner.js';
import { Journal, OrchEvent } from '../../server/orchestrator/events.js';
import { runPhase4, type PhaseDeps } from '../../server/orchestrator/phases/index.js';
import type { AgentStepRequest } from '../../server/orchestrator/steps.js';
import type { ResultSummary } from '../../server/runner/stream-events.js';
import { makeFrozenSpec, makePlan, makePlanTask, makeProject } from '../fixtures/contracts.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const spec = makeFrozenSpec();
const HASH = spec.specHash!;
const summary: ResultSummary = { found: true, isError: false, subtype: 'success', numTurns: 1, durationMs: 1, costUsd: 0, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, sessionId: null, resultText: null, structuredOutput: null, structuredSource: null, terminalReason: null, apiErrorStatus: null, rateLimit: null, compactions: 0 };
const t1 = makePlanTask({ id: 'T1', criteriaRefs: ['AC-001'] });
const t2 = makePlanTask({ id: 'T2', criteriaRefs: ['AC-002'] });
const t3 = makePlanTask({ id: 'T3', criteriaRefs: ['AC-002'], dependsOn: ['T2'] });
// Only AC-001 has a passed test: every task of AC-002 blocked.
const gate: GateResult = { name: 'unit-test', blocking: true, passed: true, exitCode: 0, timedOut: false, durationMs: 1, stdoutTail: '', stderrTail: '', junit: [{ id: 't::[AC-001] works', name: '[AC-001] works', classname: 't', status: 'passed', acIds: ['AC-001'] }], failure: null };
const fix = (over: Partial<PlanTask> = {}) => makePlanTask({ id: 'T99', criteriaRefs: ['AC-002'], ...over });

let remote: Remote;
let journal: Journal;
let packs: string[];
afterEach(async () => {
  await journal.close();
  await remote.cleanup();
});

/** A run whose T2 blocked and took T3 with it; the SM answers each fix-tasks step with the next list. */
async function setup(answers: PlanTask[][], over: Partial<{ delivery: Record<string, unknown>; junit: GateResult['junit']; blocking: GateResult }> = {}): Promise<PhaseDeps> {
  remote = await makeRemote({ 'README.md': '#\n' });
  journal = await Journal.open({ file: path.join(remote.root, 'events.ndjson'), runId: 'r1', specHash: HASH });
  await journal.fact(OrchEvent.TaskBlocked, { taskId: 'T2', reason: 'the Dev found no way to reach the payment API' });
  await journal.fact(OrchEvent.TaskBlocked, { taskId: 'T3', reason: 'a dependency is blocked' });
  packs = [];
  return {
    journal, ws: { repo: remote.repo }, spec, exec: execCommand, firstSpec: false, plan: makePlan(spec, { tasks: [t1, t2, t3], ...(over.delivery ? { delivery: over.delivery } : {}) } as never),
    tasks: () => [{ def: t1, state: 'merged' }, { def: t2, state: 'blocked' }, { def: t3, state: 'blocked' }],
    gates: async () => ({ results: [{ ...gate, junit: over.junit ?? gate.junit }, ...(over.blocking ? [over.blocking] : [])], blockingFailure: over.blocking ?? null }),
    packBase: () => ({ spec, project: makeProject(), specHash: HASH, assumptions: [], budgetTokens: 8000 }),
    runAgent: async (req: AgentStepRequest<'fix-tasks'>) => { packs.push(String(req.pack.feedback)); return { ok: true, value: { specHash: HASH, tasks: answers.shift()! }, summary }; },
  } as unknown as PhaseDeps;
}

describe('Phase 4 with blocked work', () => {
  it('fails round 1 when every task of a criterion is blocked, and asks the SM for a fix task for it', async () => {
    const res = await runPhase4(await setup([[fix()]]), 1);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.fixTasks?.map((t) => [t.id, t.criteriaRefs])).toEqual([['T900-fix-1', ['AC-002']]]);
    const failed = journal.events.find((e) => e.type === OrchEvent.VerificationFailed)!.data;
    expect(failed.uncoveredAcs).toEqual(['AC-002']);
    // The report still says why the criterion has no evidence.
    expect((failed.matrix as Array<{ criterion: string; status: string }>).map((r) => [r.criterion, r.status])).toEqual([['AC-001', 'passed'], ['AC-002', 'blocked']]);
    expect(packs[0]).toContain('Criteria without passed evidence:\n- AC-002');
  });

  it('passes a criterion whose test passed even though its task blocked afterwards, since tests come first', async () => {
    const junit = [...gate.junit!, { id: 't::[AC-002] works', name: '[AC-002] works', classname: 't', status: 'passed' as const, acIds: ['AC-002'] }];
    const res = await runPhase4(await setup([], { junit }), 1);
    expect(res.ok).toBe(true);
  });

  it('repairs a blocked criterion in the delivery round too, since round 2 is the verdict', async () => {
    const delivery = { dockerfile: 'Dockerfile', compose: 'docker-compose.yml', ciWorkflow: '.github/workflows/ci.yml', releaseWorkflow: '.github/workflows/release.yml', e2eSuite: 'e2e/run.test.ts', readmeSections: ['Run'] };
    const res = await runPhase4(await setup([[fix()]], { delivery }), 1);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.fixTasks?.map((t) => [t.id, t.owner, t.criteriaRefs])).toEqual([['T900-fix-1', 'devops', []], ['T900-fix-2', 'dev', []], ['T900-fix-3', 'dev', ['AC-002']]]);
    expect(packs[0]).toContain('Criteria without passed evidence:\n- AC-002');
    // The SM sees the delivery fixes of the same round, so it can depend on them and keep off their paths.
    expect(packs[0]).toContain('- T900-fix-1');
  });

  it('keeps the delivery fixes and records why the SM repair was refused twice', async () => {
    const delivery = { dockerfile: 'Dockerfile', compose: 'docker-compose.yml', ciWorkflow: '.github/workflows/ci.yml', releaseWorkflow: '.github/workflows/release.yml', e2eSuite: 'e2e/run.test.ts', readmeSections: ['Run'] };
    const unknown = fix({ dependsOn: ['T404'] });
    const res = await runPhase4(await setup([[unknown], [unknown]], { delivery }), 1);
    if (!res.ok) expect(res.fixTasks?.map((t) => t.id)).toEqual(['T900-fix-1', 'T900-fix-2']);
    const planned = journal.events.find((e) => e.type === 'FIX_TASKS_PLANNED')!.data;
    expect(String(planned.smRejected)).toMatch(/^fix-tasks rejected twice/);
  });

  it('names the gate that failed when every criterion passed, so the reason is no missing evidence', async () => {
    const junit = [...gate.junit!, { id: 't::[AC-002] works', name: '[AC-002] works', classname: 't', status: 'passed' as const, acIds: ['AC-002'] }];
    const lint: GateResult = { name: 'lint', blocking: true, passed: false, exitCode: 1, timedOut: false, durationMs: 1, stdoutTail: '', stderrTail: 'semi', junit: [], failure: 'code' };
    const res = await runPhase4(await setup([], { junit, blocking: lint }), 2);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('verification failed in round 2: 0 failing tests, 0 uncovered criteria; gate lint failed');
  });

  it('records the exit code, the time and the end of the output of a failed gate, so the record says why it failed', async () => {
    const junit = [...gate.junit!, { id: 't::[AC-002] works', name: '[AC-002] works', classname: 't', status: 'passed' as const, acIds: ['AC-002'] }];
    const install: GateResult = { name: 'install', blocking: true, passed: false, exitCode: 1, timedOut: false, durationMs: 7, stdoutTail: 'fetching modules', stderrTail: `${'x'.repeat(5000)}\ngo: go.mod requires go >= 1.27.3`, junit: [], failure: 'code' };
    await runPhase4(await setup([], { junit, blocking: install }), 2);
    const fact = journal.events.find((e) => e.type === OrchEvent.GateFailed && e.data.gate === 'install')!;
    expect(fact.data).toMatchObject({ exitCode: 1, durationMs: 7, timedOut: false });
    expect(String(fact.data.stderrTail)).toContain('go.mod requires go >= 1.27.3');
    expect(String(fact.data.stderrTail).length).toBeLessThanOrEqual(2000);
    expect(fact.data.stdoutTail).toBe('fetching modules');
    expect(journal.events.find((e) => e.type === OrchEvent.GatePassed)!.data).not.toHaveProperty('stderrTail');
  });

  it('shows the SM every blocked task with its reason', async () => {
    await runPhase4(await setup([[fix()]]), 1);
    expect(packs[0]).toContain('Blocked tasks (their work never reached main; a fix task redoes what a criterion still needs and never depends on them):\n- T2: the Dev found no way to reach the payment API\n- T3: a dependency is blocked');
  });

  it('accepts a fix task that names a blocked dependency on the first answer, since the run drops that dependency', async () => {
    const res = await runPhase4(await setup([[fix({ dependsOn: ['T3'] })]]), 1);
    expect(res.ok).toBe(false);
    expect(packs).toHaveLength(1);
    if (!res.ok) expect(res.fixTasks?.map((t) => t.id)).toEqual(['T900-fix-1']);
  });

  it('ends round 2 failed with the blocked criterion counted, so nothing is deployed', async () => {
    const res = await runPhase4(await setup([]), 2);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('verification failed in round 2: 0 failing tests, 1 uncovered criteria');
  });
});
