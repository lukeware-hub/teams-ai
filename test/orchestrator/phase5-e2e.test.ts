import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execCommand } from '../../server/exec/command.js';
import { Journal, OrchEvent } from '../../server/orchestrator/events.js';
import { runPhase5, type PhaseDeps } from '../../server/orchestrator/phases/index.js';
import { makeFrozenSpec, makePlan, makePlanTask, makeProject } from '../fixtures/contracts.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const spec = makeFrozenSpec();
const HASH = spec.specHash!;
const project = makeProject();
const plan = makePlan(spec, { commands: { ...makePlan(spec).commands, e2e: 'npx vitest run e2e/api.e2e.test.ts' }, delivery: { e2eSuite: 'e2e/api.e2e.test.ts' } });
let remote: Remote;
let journal: Journal;

beforeEach(async () => {
  remote = await makeRemote({ 'docs/project.json': JSON.stringify(project), 'docs/specs/spec-001/spec.json': JSON.stringify(spec) });
  journal = await Journal.open({ file: path.join(remote.root, 'events.ndjson'), runId: 'r1', specHash: HASH });
});
afterEach(async () => {
  await journal.close();
  await remote.cleanup();
});

const ROWS = [{ acId: 'AC-001', testId: 'e2e::[AC-001] ok', status: 'passed' as const }];
function setup(o: { smokeOk: boolean; e2eOk: boolean; e2eDetail?: string; plan?: typeof plan; requireE2e?: boolean }) {
  const order: string[] = [];
  const ws = { projectId: 'shop', root: remote.root, repo: remote.repo, worktrees: path.join(remote.root, 'wt'), graph: '', knowledgeDb: '', secrets: path.join(remote.root, 'secrets'), runs: remote.root };
  const target = { name: 'docker-local' as const, validate: async () => [], build: async () => undefined, apply: async () => ({ previous: null }), verify: async () => ({ healthy: true, detail: 'HTTP 200' }), currentImage: async () => null, rollback: async () => undefined, destroy: async () => undefined, serviceUrl: async () => 'http://127.0.0.1:3000', gateServiceUrl: async () => 'http://app:3000', gateNetwork: () => 'proj_default' };
  const e2eArgs: unknown[][] = [];
  const deps = {
    journal, ws, spec, project, specHash: HASH, firstSpec: true, exec: execCommand, plan: o.plan ?? plan, target, requireE2e: o.requireE2e,
    smoke: async () => { order.push('smoke'); return { ok: o.smokeOk, rows: [], detail: 'smoke detail', result: null }; },
    e2e: async (...a: unknown[]) => { order.push('e2e'); e2eArgs.push(a); return { ok: o.e2eOk, rows: ROWS, detail: o.e2eDetail ?? 'AC-001: failed' }; },
  } as unknown as PhaseDeps;
  return { deps, order, e2eArgs };
}

describe('Phase 5 e2e gate', () => {
  it('runs e2e after smoke against the gate url and network, and records the rows', async () => {
    const { deps, order, e2eArgs } = setup({ smokeOk: true, e2eOk: true });
    const r = await runPhase5(deps, 1);
    expect(r.ok).toBe(true);
    expect(order).toEqual(['smoke', 'e2e']);
    expect(e2eArgs[0]!.slice(1)).toEqual(['http://127.0.0.1:3000', 'http://app:3000', 'proj_default']);
    expect(r.ok ? r.e2e : null).toEqual(ROWS);
    expect(journal.events.find((e) => e.type === OrchEvent.DeployVerified)?.data.e2e).toEqual(ROWS);
  });

  it('records the port, health path, kind and docs path of the service for the validation page', async () => {
    const withLinks = { ...plan, deploy: { ...plan.deploy, kind: 'api' as const, docsPath: '/docs' } };
    const { deps } = setup({ smokeOk: true, e2eOk: true, plan: withLinks });
    await runPhase5(deps, 1);
    expect(journal.events.find((e) => e.type === OrchEvent.DeployVerified)?.data).toMatchObject({ port: plan.deploy.port, healthcheckPath: plan.deploy.healthcheckPath, kind: 'api', docsPath: '/docs' });
  });

  it('leaves kind and docs path out when the plan does not name them', async () => {
    const { deps } = setup({ smokeOk: true, e2eOk: true });
    await runPhase5(deps, 1);
    const data = journal.events.find((e) => e.type === OrchEvent.DeployVerified)!.data;
    expect(data).toMatchObject({ port: plan.deploy.port });
    expect('kind' in data).toBe(false);
    expect('docsPath' in data).toBe(false);
  });

  it('never runs e2e when smoke fails', async () => {
    const { deps, order } = setup({ smokeOk: false, e2eOk: true });
    const r = await runPhase5(deps, 1);
    expect(r.ok).toBe(false);
    expect(order).toEqual(['smoke']);
  });

  it('a failing e2e blocks with a reason and plans a deploy-fix task for the dev on the e2e suite', async () => {
    const { deps } = setup({ smokeOk: true, e2eOk: false });
    const r = await runPhase5(deps, 1);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.reason).toBe('deploy failed at e2e; deploy-fix task planned');
    const task = r.ok ? null : r.fixTask;
    expect(task).toMatchObject({ origin: 'deploy-fix', owner: 'dev' });
    expect(task?.affectedPaths).toContain('e2e/api.e2e.test.ts');
    expect(task?.description).toContain('AC-001: failed');
    expect(journal.events.some((e) => e.type === OrchEvent.DeployFailed && e.data.stage === 'e2e')).toBe(true);
    expect(journal.events.some((e) => e.type === OrchEvent.DeployVerified)).toBe(false);
  });

  it('stops planning fix tasks at the attempt budget', async () => {
    const { deps } = setup({ smokeOk: true, e2eOk: false });
    const r = await runPhase5(deps, 3);
    expect(r.ok ? '' : r.reason).toContain('deploy failed on attempt 3 at e2e');
    expect(r.ok ? null : r.fixTask).toBeUndefined();
  });

  it('a missing e2e command plans no fix task (the Dev cannot edit the plan)', async () => {
    const { deps } = setup({ smokeOk: true, e2eOk: false, e2eDetail: 'plan.commands.e2e missing', plan: makePlan(spec), requireE2e: true });
    const r = await runPhase5(deps, 1);
    expect(r.ok ? null : r.fixTask).toBeUndefined();
  });

  it('legacy plan without commands.e2e skips the e2e run', async () => {
    const { deps, order } = setup({ smokeOk: true, e2eOk: false, plan: makePlan(spec) });
    expect((await runPhase5(deps, 1)).ok).toBe(true);
    expect(order).toEqual(['smoke']);
  });

  it('runs a Playwright UI check after e2e only for a front-owned screen', async () => {
    const frontPlan = makePlan(spec, {
      commands: plan.commands,
      delivery: plan.delivery,
      tasks: [makePlanTask({ id: 'T2-screen', owner: 'front', affectedPaths: ['web/src/**'] })],
    });
    const { deps } = setup({ smokeOk: true, e2eOk: true, plan: frontPlan });
    const ui: unknown[] = [];
    deps.packBase = () => ({ spec, project, specHash: HASH, assumptions: [], budgetTokens: 8000 });
    deps.runAgent = (async (req) => {
      ui.push(req);
      return { ok: true, value: { specHash: HASH, decision: 'approve', criteria: [], findings: [] }, summary: { found: true, isError: false, subtype: 'success', numTurns: 1, durationMs: 1, costUsd: 0, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, sessionId: null, resultText: null, structuredOutput: null, structuredSource: null, terminalReason: null, apiErrorStatus: null, rateLimit: null, compactions: 0 } };
    }) as PhaseDeps['runAgent'];
    const r = await runPhase5(deps, 1);
    expect(r.ok).toBe(true);
    expect(ui).toHaveLength(1);
    expect(ui[0]).toMatchObject({ kind: 'ui-check', role: 'test', extraEnv: { SERVICE_URL: 'http://127.0.0.1:3000' } });
    expect(journal.events.some((e) => e.type === OrchEvent.UiChecked)).toBe(true);
  });

  it('a failing UI check plans a front deploy-fix and does not replace the HTTP e2e rows', async () => {
    const frontPlan = makePlan(spec, {
      commands: plan.commands,
      delivery: plan.delivery,
      tasks: [makePlanTask({ id: 'T2-screen', owner: 'front', affectedPaths: ['web/src/**'] })],
    });
    const { deps } = setup({ smokeOk: true, e2eOk: true, plan: frontPlan });
    deps.packBase = () => ({ spec, project, specHash: HASH, assumptions: [], budgetTokens: 8000 });
    deps.runAgent = (async () => ({
      ok: true,
      value: { specHash: HASH, decision: 'changes', criteria: [], findings: [{ file: 'web/src/App.tsx', line: 1, severity: 'important', problem: 'contrast', fix: 'raise contrast' }] },
      summary: { found: true, isError: false, subtype: 'success', numTurns: 1, durationMs: 1, costUsd: 0, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, sessionId: null, resultText: null, structuredOutput: null, structuredSource: null, terminalReason: null, apiErrorStatus: null, rateLimit: null, compactions: 0 },
    })) as PhaseDeps['runAgent'];
    const r = await runPhase5(deps, 1);
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.fixTask).toMatchObject({ owner: 'front', origin: 'deploy-fix' });
    expect(journal.events.some((e) => e.type === OrchEvent.DeployFailed && e.data.stage === 'ui')).toBe(true);
    expect(journal.events.some((e) => e.type === OrchEvent.DeployVerified)).toBe(false);
  });

  it('a UI check that does not run keeps the deploy up, rolls nothing back and plans no fix task', async () => {
    const frontPlan = makePlan(spec, {
      commands: plan.commands,
      delivery: plan.delivery,
      tasks: [makePlanTask({ id: 'T2-screen', owner: 'front', affectedPaths: ['web/src/**'] })],
    });
    const { deps } = setup({ smokeOk: true, e2eOk: true, plan: frontPlan });
    const calls: string[] = [];
    deps.target!.rollback = async () => { calls.push('rollback'); };
    deps.target!.destroy = async () => { calls.push('destroy'); };
    deps.packBase = () => ({ spec, project, specHash: HASH, assumptions: [], budgetTokens: 8000 });
    deps.runAgent = (async () => ({ ok: false, failure: 'environment', errors: ['ui-check timed out'], sandboxDisabled: false, summary: { found: true, isError: true, subtype: 'success', numTurns: 1, durationMs: 1, costUsd: 0, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, sessionId: null, resultText: null, structuredOutput: null, structuredSource: null, terminalReason: null, apiErrorStatus: null, rateLimit: null, compactions: 0 } })) as PhaseDeps['runAgent'];
    const r = await runPhase5(deps, 1);
    expect(r.ok ? '' : r.reason).toBe('UI check did not run; the deploy stays up: ui-check timed out');
    expect(r.ok ? null : r.fixTask).toBeUndefined();
    expect(calls).toEqual([]);
    expect(journal.events.some((e) => e.type === OrchEvent.DeployFailed)).toBe(false);
  });

  it('journals a skill request from the UI check', async () => {
    const frontPlan = makePlan(spec, {
      commands: plan.commands,
      delivery: plan.delivery,
      tasks: [makePlanTask({ id: 'T2-screen', owner: 'front', affectedPaths: ['web/src/**'] })],
    });
    const { deps } = setup({ smokeOk: true, e2eOk: true, plan: frontPlan });
    deps.packBase = () => ({ spec, project, specHash: HASH, assumptions: [], budgetTokens: 8000 });
    deps.runAgent = (async () => ({ ok: true, value: { specHash: HASH, decision: 'approve', criteria: [], findings: [], skillRequest: { capability: 'check contrast', reason: 'no contrast tool mounted' } }, summary: { found: true, isError: false, subtype: 'success', numTurns: 1, durationMs: 1, costUsd: 0, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, sessionId: null, resultText: null, structuredOutput: null, structuredSource: null, terminalReason: null, apiErrorStatus: null, rateLimit: null, compactions: 0 } })) as PhaseDeps['runAgent'];
    await runPhase5(deps, 1);
    expect(journal.events.some((e) => e.type === OrchEvent.SkillRequested && e.data.role === 'test' && e.data.capability === 'check contrast')).toBe(true);
  });

  it('retries a UI check that errors once before it counts as not run', async () => {
    const frontPlan = makePlan(spec, {
      commands: plan.commands,
      delivery: plan.delivery,
      tasks: [makePlanTask({ id: 'T2-screen', owner: 'front', affectedPaths: ['web/src/**'] })],
    });
    const { deps } = setup({ smokeOk: true, e2eOk: true, plan: frontPlan });
    deps.packBase = () => ({ spec, project, specHash: HASH, assumptions: [], budgetTokens: 8000 });
    const calls: boolean[] = [];
    deps.runAgent = (async () => {
      calls.push(true);
      if (calls.length === 1) return { ok: false, failure: 'environment', errors: ['ui-check timed out'], sandboxDisabled: false, summary: { found: true, isError: true, subtype: 'success', numTurns: 1, durationMs: 1, costUsd: 0, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, sessionId: null, resultText: null, structuredOutput: null, structuredSource: null, terminalReason: null, apiErrorStatus: null, rateLimit: null, compactions: 0 } };
      return { ok: true, value: { specHash: HASH, decision: 'approve', criteria: [], findings: [] }, summary: { found: true, isError: false, subtype: 'success', numTurns: 1, durationMs: 1, costUsd: 0, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, sessionId: null, resultText: null, structuredOutput: null, structuredSource: null, terminalReason: null, apiErrorStatus: null, rateLimit: null, compactions: 0 } };
    }) as PhaseDeps['runAgent'];
    const r = await runPhase5(deps, 1);
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });
});
