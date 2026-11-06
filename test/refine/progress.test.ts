import { describe, expect, it } from 'vitest';
import type { StoredEvent } from '../../server/store/event-store.js';
import { answersAwaitingOf, reviewingOf, runningStepsOf, stageCostOf, waitingOf } from '../../server/refine/progress.js';

const ev = (seq: number, type: string, data: Record<string, unknown> = {}): StoredEvent => ({ seq, at: `2026-11-06T22:0${seq}:00.000Z`, runId: 'r', specHash: 'h', type, kind: 'fact', data } as StoredEvent);

describe('progress of a refinement, read from its journal', () => {
  const journal = [
    ev(1, 'REFINE_CYCLE_STARTED', { cycle: 1, file: 'flow.md' }),
    ev(2, 'STEP_STARTED', { stepId: 's1', kind: 'refine', role: 'po', model: 'claude-sonnet-5-5', effort: 'low', part: { index: 1, total: 2 }, limitMs: 120_000 }),
    ev(3, 'STEP_FINISHED', { stepId: 's1', costUsd: 0.25, durationMs: 9_000 }),
    ev(4, 'STEP_STARTED', { stepId: 's2', kind: 'refine', role: 'po', model: 'claude-sonnet-5-5', effort: 'low', part: { index: 2, total: 2 }, limitMs: 120_000 }),
  ];

  it('lists the steps started and not finished, with their part and time limit', () => {
    const running = runningStepsOf(journal);
    expect(running.map((s) => s.stepId)).toEqual(['s2']);
    expect(running[0]).toMatchObject({ role: 'po', model: 'claude-sonnet-5-5', effort: 'low', part: { index: 2, total: 2 }, limitMs: 120_000 });
  });

  it('names the stage under review until its evaluation ends', () => {
    expect(reviewingOf(journal)).toBe('flow.md');
    expect(reviewingOf([...journal, ev(5, 'REFINE_EVALUATION_ENDED')])).toBeNull();
  });

  it('adds up what each stage has cost, and counts its rounds', () => {
    const costs = stageCostOf([...journal, ev(5, 'REFINE_CYCLE_STARTED', { cycle: 2, file: 'project.md' }), ev(6, 'STEP_FINISHED', { stepId: 's2', costUsd: 0.5, durationMs: 4_000 })]);
    expect(costs['flow.md']).toEqual({ rounds: 1, steps: 1, durationMs: 9_000, costUsd: 0.25 });
    expect(costs['project.md']).toEqual({ rounds: 1, steps: 1, durationMs: 4_000, costUsd: 0.5 });
  });

  it('counts the answers no review has used yet, per stage, and a review clears them', () => {
    const asked = ev(1, 'REFINE_STAGE_REVIEWED', { file: 'flow.md', questions: [{ questionId: 'q1' }, { questionId: 'q2' }] });
    const answered = [ev(2, 'QUESTION_ANSWERED', { questionId: 'q1' }), ev(3, 'QUESTION_ANSWERED', { questionId: 'q2' })];
    expect(answersAwaitingOf([asked, ...answered])).toEqual({ 'flow.md': 2 });
    expect(answersAwaitingOf([asked, ...answered, ev(4, 'REFINE_STAGE_REVIEWED', { file: 'flow.md', questions: [] })])).toEqual({});
  });

  it('shows a quota wait until the next step starts', () => {
    const until = '2026-11-06T23:00:00.000Z';
    expect(waitingOf([...journal, ev(5, 'REFINE_QUOTA_WAITING', { waitMs: 60_000, until })])).toEqual({ until });
    expect(waitingOf([...journal, ev(5, 'REFINE_QUOTA_WAITING', { waitMs: 60_000, until }), ev(6, 'STEP_STARTED', { stepId: 's3' })])).toBeNull();
  });
});
