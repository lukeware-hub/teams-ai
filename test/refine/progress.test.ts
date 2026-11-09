import { describe, expect, it } from 'vitest';
import type { StoredEvent } from '../../server/store/event-store.js';
import { answersAwaitingOf, evaluationProgressOf, reviewingOf, runningStepsOf, stageCostOf, stageSignalsOf, waitingOf } from '../../server/refine/progress.js';

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

  it('a step id used again after it finished is running again, not finished', () => {
    const reused = [ev(1, 'STEP_STARTED', { stepId: 's1', role: 'po' }), ev(2, 'STEP_FINISHED', { stepId: 's1' }), ev(3, 'STEP_STARTED', { stepId: 's1', role: 'sm' })];
    expect(runningStepsOf(reused).map((s) => s.role)).toEqual(['sm']);
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

  it('adds the Jev score to the document it scored, and a Jev decision to the stage under review', () => {
    const scored = (seq: number, file: string) => ev(seq, 'REFINE_DOCS_SCORED', { files: [file], usage: { costUsd: 0.125 } });
    const decided = ev(4, 'DECISION_MADE', { record: { attempts: [{ backend: 'jev', usage: { costUsd: 0.5 } }, { backend: 'claude', usage: { costUsd: 9 } }] } });
    const costs = stageCostOf([
      scored(1, 'flow.md'),
      ev(2, 'REFINE_CYCLE_STARTED', { cycle: 1, file: 'flow.md' }),
      ev(3, 'STEP_FINISHED', { stepId: 's1', costUsd: 0.25, durationMs: 9_000 }),
      decided,
      scored(5, 'project.md'),
    ]);
    expect(costs['flow.md']).toEqual({ rounds: 1, steps: 1, durationMs: 9_000, costUsd: 0.875 });
    expect(costs['project.md']).toEqual({ rounds: 0, steps: 0, durationMs: 0, costUsd: 0.125 });
  });

  it('counts the answers no review has used yet, per stage, and a review clears them', () => {
    const asked = ev(1, 'REFINE_STAGE_REVIEWED', { file: 'flow.md', questions: [{ questionId: 'q1' }, { questionId: 'q2' }] });
    const answered = [ev(2, 'QUESTION_ANSWERED', { questionId: 'q1' }), ev(3, 'QUESTION_ANSWERED', { questionId: 'q2' })];
    expect(answersAwaitingOf([asked, ...answered])).toEqual({ 'flow.md': 2 });
    expect(answersAwaitingOf([asked, ...answered, ev(4, 'REFINE_STAGE_REVIEWED', { file: 'flow.md', questions: [] })])).toEqual({});
  });

  it('tells what the current round has done: reviewed, scored, and whether the Jev did not answer', () => {
    const round = [ev(1, 'REFINE_CYCLE_STARTED', { cycle: 2, file: 'project.md' }), ev(2, 'REFINE_STAGE_REVIEWED', { file: 'project.md' }), ev(3, 'REFINE_DOCS_SCORED', { cycle: 2, available: false })];
    expect(stageSignalsOf([ev(0, 'REFINE_CYCLE_STARTED', { cycle: 1, file: 'flow.md' }), ev(1, 'REFINE_DOCS_SCORED', { cycle: 1, available: true })])).toEqual({ reviewed: false, scored: true, jevDown: false });
    expect(stageSignalsOf(round)).toEqual({ reviewed: true, scored: true, jevDown: true });
  });

  it('shows a quota wait until the next step starts', () => {
    const until = '2026-11-06T23:00:00.000Z';
    expect(waitingOf([...journal, ev(5, 'REFINE_QUOTA_WAITING', { waitMs: 60_000, until })])).toEqual({ until });
    expect(waitingOf([...journal, ev(5, 'REFINE_QUOTA_WAITING', { waitMs: 60_000, until }), ev(6, 'STEP_STARTED', { stepId: 's3' })])).toBeNull();
  });
});

describe('evaluationProgressOf: what the latest evaluation spent and redid', () => {
  it('is null before any evaluation', () => {
    expect(evaluationProgressOf([])).toBeNull();
  });

  it('counts the cost, the time and the items detailed again since the latest start, and sees a cycle on the same text', () => {
    const journal = [
      ev(1, 'REFINE_EVALUATION_STARTED'),
      ev(2, 'REFINE_CYCLE_STARTED', { cycle: 1, draftHash: 'a' }),
      ev(3, 'STEP_FINISHED', { costUsd: 9 }),
      ev(4, 'REFINE_EVALUATION_ENDED'),
      ev(5, 'REFINE_EVALUATION_STARTED'),
      ev(6, 'REFINE_CYCLE_STARTED', { cycle: 2, draftHash: 'a' }),
      ev(7, 'STEP_FINISHED', { costUsd: 0.5 }),
      ev(8, 'SPEC_DERIVED', { key: 'caso' }),
      ev(9, 'SPEC_DERIVED', { key: 'caso' }),
    ];
    expect(evaluationProgressOf(journal)).toEqual({ durationMs: 4 * 60_000, costUsd: 0.5, redone: 1, repeated: true });
  });

  it('does not call a cycle on new text a repeat', () => {
    const journal = [ev(1, 'REFINE_CYCLE_STARTED', { draftHash: 'a' }), ev(2, 'REFINE_EVALUATION_STARTED'), ev(3, 'REFINE_CYCLE_STARTED', { draftHash: 'b' })];
    expect(evaluationProgressOf(journal)?.repeated).toBe(false);
  });
});
