import { describe, expect, it } from 'vitest';
import { runMetrics } from '../../server/orchestrator/metrics.js';
import type { StoredEvent } from '../../server/store/event-store.js';

let seq = 0;
const ev = (type: string, data: Record<string, unknown>, at = '2026-11-05T10:00:00.000Z', runId = 'r1'): StoredEvent => ({ seq: ++seq, at, runId, specHash: 'h', type, kind: 'fact', data });
const step = (taskId: string | null, kind: string, attempt: number, costUsd: number, runId = 'r1') => ev('STEP_FINISHED', { taskId, kind, attempt, costUsd }, undefined, runId);
const merged = (taskId: string, runId = 'r1') => ev('TASK_STATE_CHANGED', { taskId, to: 'merged' }, undefined, runId);

describe('runMetrics', () => {
  it('sums the cost and the share spent on fix and deploy-fix tasks', () => {
    const m = runMetrics([step('T1-a', 'dev', 1, 6), step('T900-fix-1', 'dev', 1, 3), step('T950-deploy-fix-1', 'dev', 1, 1), step(null, 'report', 1, 0)]);
    expect(m.costUsd).toBe(10);
    expect(m.fixCostUsd).toBe(4);
    expect(m.fixCostShare).toBeCloseTo(0.4);
  });

  it('counts attempts per task and the tasks merged on the first attempt', () => {
    const m = runMetrics([step('T1-a', 'dev', 1, 1), merged('T1-a'), step('T2-b', 'dev', 1, 1), step('T2-b', 'dev', 2, 1), step('T2-b', 'dev', 3, 1), merged('T2-b'), step('T3-c', 'dev', 1, 1), step('T3-c', 'dev', 2, 1)]);
    expect(m.tasks).toBe(3);
    expect(m.attemptsPerTask).toBeCloseTo(2);
    expect(m.firstTryRate).toBeCloseTo(1 / 3);
  });

  it('keeps the same task id of two runs apart', () => {
    const m = runMetrics([step('T1-a', 'dev', 1, 1, 'r1'), merged('T1-a', 'r1'), step('T1-a', 'dev', 1, 1, 'r2'), step('T1-a', 'dev', 2, 1, 'r2')]);
    expect(m.tasks).toBe(2);
    expect(m.firstTryRate).toBeCloseTo(0.5);
  });

  it('gives the review reject rate, the runs and the elapsed time', () => {
    const m = runMetrics([
      ev('RUN_STARTED', {}, '2026-11-05T10:00:00.000Z', 'r1'),
      ev('REVIEW_CHANGES', { taskId: 'T1' }), ev('REVIEW_CHANGES', { taskId: 'T1' }), ev('REVIEW_APPROVED', { taskId: 'T1' }), ev('REVIEW_APPROVED', { taskId: 'T2' }),
      ev('RUN_STARTED', {}, '2026-11-05T11:00:00.000Z', 'r2'),
      ev('RUN_FINISHED', { result: 'done' }, '2026-11-05T12:30:00.000Z', 'r2'),
    ]);
    expect(m.runs).toBe(2);
    expect(m.reviewRejectRate).toBeCloseTo(0.5);
    expect(m.wallMs).toBe(2.5 * 3_600_000);
  });

  it('returns zeros and nulls for no events, never dividing by zero', () => {
    expect(runMetrics([])).toEqual({ runs: 0, costUsd: 0, fixCostUsd: 0, fixCostShare: null, tasks: 0, attemptsPerTask: null, firstTryRate: null, reviewRejectRate: null, wallMs: 0 });
  });
});
