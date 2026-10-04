import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StoredEvent } from '../api.js';
import { deployOutcome, evidence, explainStop, lastDeployFailure, pausedUntil, phases, runState, stopSummary, taskDetail, tokens } from './selectors.js';

// jsdom gives import.meta.url an http: scheme; vitest runs with cwd = web/
const events: StoredEvent[] = readFileSync(path.resolve('../test/fixtures/runs/hello-run.ndjson'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));

describe('run selectors', () => {
  it('reduces task state with the orchestrator reducer', () => {
    const s = runState(events);
    expect(s.status).toBe('paused:quota');
    expect(s.order).toEqual(['T1', 'T2']);
    expect(s.tasks.get('T1')).toMatchObject({ state: 'merged', attempts: 1 });
    expect(s.tasks.get('T2')).toMatchObject({ state: 'ready', attempts: 0 });
  });
  it('phases 1 and 2 are done, 3 is running', () => {
    expect(phases(events).map((p) => [p.phase, p.result])).toEqual([
      [1, 'done'],
      [2, 'done'],
      [3, 'running'],
    ]);
  });
  it('paused until comes from the last quota pause', () => {
    expect(pausedUntil(events)).toBe('2026-09-24T10:30:00.000Z');
    expect(pausedUntil([...events, { ...events[0]!, seq: 999, type: 'RUN_RESUMED', data: {} }])).toBeNull();
  });
  it('task detail groups steps, gates and review by attempt and finds the PR', () => {
    const d = taskDetail(events, 'T1');
    expect(d.attempts.map((a) => a.attempt)).toEqual([1, 2]);
    expect(d.attempts[0]!.steps.map((s) => [s.stepId, s.kind, s.ok, s.tier])).toEqual([['s00003', 'dev', true, 'small']]);
    expect(d.attempts[0]!.gates.map((g) => [g.gate, g.passed])).toEqual([
      ['unit-test', true],
      ['lint', false],
    ]);
    expect(d.attempts[1]!.review).toEqual({ profile: 'standard', risk: 'low', drift: 'none', findings: [] });
    expect(d.pr).toEqual({ number: 3, url: 'https://github.com/o/r/pull/3' });
    expect(d.merged).toBe(true);
    expect(d.blockedReason).toBeNull();
    expect(taskDetail(events, 'T2').attempts).toEqual([]);
  });
  it('task detail carries the security findings of the attempt', () => {
    const sec = { file: 'src/a.ts', line: 3, severity: 'medium', category: 'cors', problem: 'open cors', fix: 'restrict origins' };
    const withSec = [...events, { ...events[0]!, seq: 9000, type: 'SECURITY_APPROVED', data: { taskId: 'T1', findings: [sec] } } as StoredEvent];
    const attempts = taskDetail(withSec, 'T1').attempts;
    expect(attempts.at(-1)!.security).toEqual({ findings: [sec] });
    expect(taskDetail(events, 'T1').attempts[0]!.security).toBeNull();
  });
  it('tokens by phase, by role, with system1 from decisions', () => {
    const t = tokens(events);
    expect(t.byRole.dev).toMatchObject({ inputTokens: 4100, outputTokens: 900, costUsd: 0.6, steps: 2 });
    expect(t.byRole.system1).toMatchObject({ inputTokens: 50, outputTokens: 5, steps: 1 });
    expect(t.byPhase.phase3.steps).toBe(3);
    expect(t.byPhase.decide.steps).toBe(1);
    expect(t.byPhase.phase.steps).toBe(2);
    expect(t.total.costUsd).toBeCloseTo(1.00001, 5);
  });
  it('evidence takes the latest gate round per task', () => {
    expect(evidence(events, ['AC-001', 'AC-002'])).toEqual([
      { acId: 'AC-001', tests: [{ id: 'sum::[AC-001] adds', status: 'passed', taskId: 'T1' }] },
      { acId: 'AC-002', tests: [] },
    ]);
  });
});

it('phases 4-6 end on their own events', () => {
  const evs = (list: Array<[string, Record<string, unknown>]>) => list.map(([type, data], i) => ({ seq: i + 1, at: '2026-09-24T10:00:00.000Z', runId: 'r', specHash: 'h', type, kind: 'fact' as const, data }));
  const out = phases(evs([['PHASE_STARTED', { phase: 4, round: 1 }], ['VERIFICATION_FAILED', { round: 1 }], ['PHASE_STARTED', { phase: 4, round: 2 }], ['VERIFICATION_PASSED', { round: 2 }], ['PHASE_STARTED', { phase: 5 }], ['DEPLOY_FAILED', { attempt: 1, stage: 'apply' }], ['DEPLOY_VERIFIED', { attempt: 2, url: 'http://x' }], ['PHASE_STARTED', { phase: 6 }], ['REPORT_READY', {}]]));
  expect(out.map((p) => [p.phase, p.result])).toEqual([[4, 'running'], [4, 'done'], [5, 'done'], [6, 'done']]);
  expect(deployOutcome(evs([['DEPLOY_FAILED', { attempt: 1, stage: 'apply', detail: 'busy' }], ['DEPLOY_VERIFIED', { attempt: 2, url: 'http://x' }]]))).toEqual({ attempts: 2, verified: { url: 'http://x' }, lastFailure: null });
});

describe('stopped run explanations', () => {
  const evs = (list: Array<[string, Record<string, unknown>]>) => list.map(([type, data], i) => ({ seq: i + 1, at: '2026-09-24T10:00:00.000Z', runId: 'r', specHash: 'h', type, kind: 'fact' as const, data }));

  it('explainStop names the cause and the owner, and returns null for unknown reasons', () => {
    expect(explainStop('Dev reported done but produced no changes against origin/main. Implement the task or return spec-gap.')).toMatchObject({ owner: 'Sistema', title: expect.stringContaining('não alterou') });
    expect(explainStop('plan.commands.smoke missing')).toMatchObject({ owner: 'Plano', hint: expect.stringContaining('commands.smoke') });
    expect(explainStop('Review requested changes:\nuse a constant')).toMatchObject({ owner: 'Sistema' });
    expect(explainStop('spec-gap rounds exhausted (3); last question: which currency?')).toMatchObject({ owner: 'Você' });
    expect(explainStop('something nobody has seen before')).toBeNull();
  });

  it('lastDeployFailure is the latest failure unless a later deploy verified', () => {
    const failed = evs([['DEPLOY_FAILED', { attempt: 1, stage: 'smoke', detail: 'plan.commands.smoke missing', rolledBack: true, rollbackHealthy: true }]]);
    expect(lastDeployFailure(failed)).toMatchObject({ attempt: 1, stage: 'smoke', rolledBack: true, rollbackHealthy: true });
    const recovered = evs([['DEPLOY_FAILED', { attempt: 1, stage: 'apply', detail: 'busy' }], ['DEPLOY_VERIFIED', { attempt: 2, url: 'http://x' }]]);
    expect(lastDeployFailure(recovered)).toBeNull();
  });

  it('stopSummary explains a deploy-failed run with its stage, rollback and owner', () => {
    const failure = { attempt: 1, stage: 'smoke', detail: 'plan.commands.smoke missing', rolledBack: true, rollbackHealthy: true };
    const s = stopSummary({ status: 'deploy-failed', reason: 'deploy failed at smoke: plan.commands.smoke missing', causes: [], deployFailure: failure });
    expect(s).toMatchObject({ owner: 'Plano', action: 'redeploy' });
    expect(s!.what).toContain('smoke');
    expect(s!.rollback).toContain('saudável');
    expect(s!.raw).toContain('plan.commands.smoke missing');
  });

  it('stopSummary covers blocked runs and ignores healthy ones', () => {
    const blocked = stopSummary({ status: 'blocked', reason: null, causes: [{ taskId: 'T2', reason: 'Task token budget exceeded: 9 tokens used, cap 5. Finish with a smaller change set.' }, { taskId: 'T3', reason: 'Task token budget exceeded: 9 tokens used, cap 5. Finish with a smaller change set.' }], deployFailure: null });
    expect(blocked!.what).toContain('2 tarefas');
    expect(blocked!.owner).toBe('Sistema');
    expect(stopSummary({ status: 'awaiting-validation', reason: null, causes: [], deployFailure: null })).toBeNull();
    expect(stopSummary({ status: 'running', reason: null, causes: [], deployFailure: null })).toBeNull();
  });

  it('phase 5 is failed on the first DEPLOY_FAILED with no later verification', () => {
    const out = phases(evs([['PHASE_STARTED', { phase: 5 }], ['DEPLOY_FAILED', { attempt: 1, stage: 'smoke', detail: 'plan.commands.smoke missing' }], ['PHASE_STARTED', { phase: 6 }]]));
    expect(out.find((p) => p.phase === 5)).toMatchObject({ result: 'failed', reason: 'plan.commands.smoke missing' });
  });
});
