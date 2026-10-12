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
async function setup(answers: PlanTask[][]): Promise<PhaseDeps> {
  remote = await makeRemote({ 'README.md': '#\n' });
  journal = await Journal.open({ file: path.join(remote.root, 'events.ndjson'), runId: 'r1', specHash: HASH });
  await journal.fact(OrchEvent.TaskBlocked, { taskId: 'T2', reason: 'the Dev found no way to reach the payment API' });
  await journal.fact(OrchEvent.TaskBlocked, { taskId: 'T3', reason: 'a dependency is blocked' });
  packs = [];
  return {
    journal, ws: { repo: remote.repo }, spec, exec: execCommand, firstSpec: false, plan: makePlan(spec, { tasks: [t1, t2, t3] }),
    tasks: () => [{ def: t1, state: 'merged' }, { def: t2, state: 'blocked' }, { def: t3, state: 'blocked' }],
    gates: async () => ({ results: [gate], blockingFailure: null }),
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

  it('ends round 2 failed with the blocked criterion counted, so nothing is deployed', async () => {
    const res = await runPhase4(await setup([]), 2);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('verification failed in round 2: 0 failing tests, 1 uncovered criteria');
  });
});
