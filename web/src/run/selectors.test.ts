import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StoredEvent } from '../api.js';
import { evidence, pausedUntil, phases, runState, taskDetail, tokens } from './selectors.js';

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
