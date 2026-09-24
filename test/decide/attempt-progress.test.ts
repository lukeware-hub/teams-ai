import { describe, expect, it } from 'vitest';
import { ATTEMPT_PROGRESS_LEVELS, assessAttemptProgress, attemptProgressQuestions, attemptProgressState } from '../../server/decide/decisions/attempt-progress.js';
import type { DecisionOutcome } from '../../server/decide/types.js';
import { makePlanTask } from '../fixtures/contracts.js';

const task = makePlanTask({ id: 'T1', criteriaRefs: ['AC-001'], affectedPaths: ['src'] });
const history = ['Gate unit-test failed (code, exit 1)\nFailed tests:\na::adds', 'Review requested changes:\n- src/a.ts [major] off by one (fix: use <=)'];
const fake = (outcome: DecisionOutcome) => ({ decide: async () => outcome });
const score = (value: number, confidence = 0.9): DecisionOutcome => ({ answered: true, backend: 'jev', escalated: false, answers: { progress: { type: 'score', value, probabilities: {}, confidence } } });

describe('attempt progress', () => {
  it('asks one score question with the three ordered levels', () => {
    expect(ATTEMPT_PROGRESS_LEVELS).toEqual(['diverging', 'stalled', 'converging']);
    expect(attemptProgressQuestions().progress).toMatchObject({ type: 'score' });
  });
  it('state lists the task, the attempt number and every delta, newest last', () => {
    const s = attemptProgressState(task, 3, history);
    expect(s).toContain('task: T1');
    expect(s).toContain('attempt about to start: 3');
    expect(s.indexOf('Gate unit-test')).toBeLessThan(s.indexOf('Review requested'));
  });
  it('rounds the weighted level index to the nearest level', async () => {
    expect((await assessAttemptProgress(task, 2, history, fake(score(0.4)), { confidential: false })).progress).toBe('diverging');
    expect((await assessAttemptProgress(task, 2, history, fake(score(1.4)), { confidential: false })).progress).toBe('stalled');
    expect((await assessAttemptProgress(task, 2, history, fake(score(1.6)), { confidential: false })).progress).toBe('converging');
  });
  it('defaults to converging when unanswered, so the retry policy is unchanged', async () => {
    expect(await assessAttemptProgress(task, 2, history, fake({ answered: false, reason: 'disabled' }), { confidential: false })).toEqual({ progress: 'converging', source: 'default' });
  });
});
