import { describe, expect, it } from 'vitest';
import { autonomyMetrics, refineMetrics, type JournalEvent } from '../../scripts/refine-metrics.js';

const ev = (type: string, at: string, data: Record<string, unknown> = {}): JournalEvent => ({ type, at, data });

describe('refineMetrics', () => {
  it('counts the reviews of a document, the replayed ones and the seconds each took', () => {
    const out = refineMetrics([
      ev('REFINE_CYCLE_STARTED', '2026-11-03T10:00:00Z', { cycle: 1 }),
      ev('REFINE_STAGE_REVIEWED', '2026-11-03T10:00:30Z', { file: 'flow.md' }),
      ev('REFINE_CYCLE_STARTED', '2026-11-03T10:01:00Z', { cycle: 2 }),
      ev('REFINE_STAGE_REVIEWED', '2026-11-03T10:01:01Z', { file: 'flow.md', replayed: true }),
    ]);
    expect(out.reviews['flow.md']).toEqual({ count: 2, replayed: 1, seconds: [30, 1] });
  });

  it('adds the calls, tokens and cost of each role', () => {
    const out = refineMetrics([
      ev('STEP_STARTED', 'x', { stepId: 's1', role: 'po' }),
      ev('STEP_FINISHED', 'x', { stepId: 's1', usage: { inputTokens: 100, outputTokens: 20 }, costUsd: 0.05 }),
      ev('STEP_STARTED', 'x', { stepId: 's2', role: 'po' }),
      ev('STEP_FINISHED', 'x', { stepId: 's2', usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.01 }),
    ]);
    expect(out.agents.po).toEqual({ calls: 2, tokens: 135, costUsd: expect.closeTo(0.06, 5) });
  });

  it('tells what the owner did by hand from what the agents did alone', () => {
    const out = refineMetrics([
      ev('QUESTION_ANSWERED', 'x'),
      ev('QUESTION_SKIPPED', 'x'),
      ev('PATCH_ACCEPTED', 'x', { auto: true }),
      ev('PATCH_ACCEPTED', 'x', { auto: true }),
      ev('PATCH_ACCEPTED', 'x'),
      ev('PATCH_REJECTED', 'x'),
      ev('REFINE_STAGE_ADVANCED', 'x'),
    ]);
    expect(out.owner).toEqual({ answers: 1, skips: 1, acceptedByOwner: 1, rejected: 1, stagesContinued: 1 });
    expect(out.agentsAlone).toEqual({ acceptedPatches: 2 });
  });
});

describe('autonomyMetrics', () => {
  it('counts the owner decisions, folds one click into one action and leaves out what the agents did', () => {
    const out = autonomyMetrics([
      ev('REFINE_CREATED', '2026-11-08T10:00:00Z'),
      ev('QUESTION_ANSWERED', '2026-11-08T10:01:00Z'),
      ev('QUESTION_ANSWERED', '2026-11-08T10:01:05Z', { by: 'po' }),
      ev('PATCH_ACCEPTED', '2026-11-08T10:02:00Z'),
      ev('PATCH_ACCEPTED', '2026-11-08T10:02:00.500Z'),
      ev('PATCH_ACCEPTED', '2026-11-08T10:03:00Z', { auto: true }),
      ev('REFINE_STAGE_ADVANCED', '2026-11-08T10:04:00Z'),
    ]);
    expect(out.ownerActions).toEqual({ value: 4, events: 5, target: 110, met: true });
  });

  it('leaves out what happens while the team works alone', () => {
    const out = autonomyMetrics([
      ev('TEAM_AUTOPILOT_STARTED', '2026-11-08T10:00:00Z'),
      ev('QUESTION_SKIPPED', '2026-11-08T10:01:00Z'),
      ev('TEAM_AUTOPILOT_STOPPED', '2026-11-08T10:02:00Z'),
      ev('QUESTION_SKIPPED', '2026-11-08T10:03:00Z'),
    ]);
    expect(out.ownerActions.value).toBe(1);
  });

  it('counts as idle the time no agent worked, and apart the time after a failure', () => {
    const out = autonomyMetrics([
      ev('STEP_STARTED', '2026-11-08T10:00:00Z', { stepId: 's1' }),
      ev('STEP_STARTED', '2026-11-08T10:30:00Z', { stepId: 's2' }),
      ev('STEP_FINISHED', '2026-11-08T11:00:00Z', { stepId: 's1' }),
      ev('STEP_FINISHED', '2026-11-08T11:00:00Z', { stepId: 's2' }),
      ev('REFINE_CYCLE_FAILED', '2026-11-08T11:00:00Z', { kind: 'timeout' }),
      ev('REFINE_CYCLE_STARTED', '2026-11-08T13:00:00Z'),
      ev('STEP_STARTED', '2026-11-08T13:00:00Z', { stepId: 's3' }),
      ev('STEP_FINISHED', '2026-11-08T14:00:00Z', { stepId: 's3' }),
      ev('REFINE_QUOTA_WAITING', '2026-11-08T14:00:00Z', { until: '2026-11-08T15:00:00Z' }),
      ev('QUESTION_ANSWERED', '2026-11-08T17:00:00Z'),
    ]);
    expect(out.idleHours).toEqual({ value: 4, afterFailure: 2, target: 6, met: true });
  });

  it('counts a failure as solved alone only when the team resumed it, and a resume by the owner as an owner action', () => {
    const out = autonomyMetrics([
      ev('PLANS_FAILED', '2026-11-08T10:00:00Z', { kind: 'schema' }),
      ev('PLANS_STARTED', '2026-11-08T10:10:00Z'),
      ev('TEAM_AUTOPILOT_STARTED', '2026-11-08T11:00:00Z'),
      ev('REFINE_CYCLE_FAILED', '2026-11-08T11:01:00Z', { kind: 'timeout' }),
      ev('REFINE_CYCLE_STARTED', '2026-11-08T11:02:00Z'),
      ev('TEAM_AUTOPILOT_STOPPED', '2026-11-08T11:30:00Z'),
      ev('REFINE_DOC_GRAPH_FAILED', '2026-11-08T12:00:00Z'),
    ]);
    expect(out.failures).toEqual({ total: 3, solvedAlone: 1, share: 1 / 3, target: 0.95, met: false });
    expect(out.ownerActions.value).toBe(1);
  });

  it('counts a failure the heal driver retried as solved alone, and its retry as no owner action', () => {
    const out = autonomyMetrics([
      ev('REFINE_CYCLE_FAILED', '2026-11-08T10:00:00Z', { kind: 'interrupted' }),
      ev('REFINE_HEAL_RETRIED', '2026-11-08T10:01:00Z', { action: 'evaluate' }),
      ev('REFINE_CYCLE_STARTED', '2026-11-08T10:01:00Z'),
    ]);
    expect(out.failures).toMatchObject({ total: 1, solvedAlone: 1, met: true });
    expect(out.ownerActions.value).toBe(0);
  });

  it('counts the pauses for the owner', () => {
    const out = autonomyMetrics([ev('AUTOPILOT_PAUSED', '2026-11-08T10:00:00Z'), ev('AUTOPILOT_PAUSED', '2026-11-08T11:00:00Z')]);
    expect(out.pauses).toEqual({ value: 2, target: 1, met: false });
  });

  it('meets the failure target when nothing failed', () => {
    expect(autonomyMetrics([]).failures).toEqual({ total: 0, solvedAlone: 0, share: 1, target: 0.95, met: true });
  });
});
