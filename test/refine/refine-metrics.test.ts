import { describe, expect, it } from 'vitest';
import { refineMetrics, type JournalEvent } from '../../scripts/refine-metrics.js';

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
