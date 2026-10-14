import { describe, expect, it } from 'vitest';
import { ATTEMPT_PROGRESS_LEVELS, assessAttemptProgress, attemptProgressQuestions, attemptProgressState, repeatedFailure } from '../../server/decide/decisions/attempt-progress.js';
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
  it('judges stalled by rule, before any backend, when the last delta repeats the complaints of the one before', async () => {
    const review = (sev: string, extra = '') => `Review requested changes:\n- .env.example [${sev}] not in the change set (fix: add it)${extra}`;
    expect(repeatedFailure([review('important'), review('important', '\n- go.mod [minor] all indirect (fix: tidy)')])).toBe(true);
    expect(repeatedFailure([review('important'), review('critical')])).toBe(false);
    expect(repeatedFailure([review('important'), `${review('important')}\n- src/b.go:12 [important] new bug (fix: x)`])).toBe(false);
    expect(repeatedFailure(['Gate unit-test failed (code, exit 1)\na::adds', 'Gate unit-test failed (code, exit 1)\na::adds'])).toBe(true);
    expect(repeatedFailure(['Gate unit-test failed (code, exit 1)\na::adds', 'Gate unit-test failed (code, exit 1)\nb::subs'])).toBe(false);
    expect(repeatedFailure([review('important')])).toBe(false);
    expect(await assessAttemptProgress(task, 3, [review('important'), review('important')], fake(score(2)), { confidential: false })).toEqual({ progress: 'stalled', source: 'rule' });
  });
  it('treats a new problem found in the same file as progress, and the same spot as a repeat', () => {
    const review = (line: number, text: string) => `Review requested changes:\n- internal/application/validate.go:${line} [important] ${text} (fix: change it)`;
    const a = review(145, 'A tarefa de item faltante não guarda o médico responsável nem a data da notificação, que a tarefa exige.');
    const b = review(130, 'requestMissing cria uma tarefa nova e um prazo novo no sla-service a cada chamada, sem idempotência.');
    expect(repeatedFailure([a, b])).toBe(false);
    // The same spot a few lines away, or the same words far away, is the same complaint.
    expect(repeatedFailure([a, review(150, 'Outra frase sobre outro assunto.')])).toBe(true);
    expect(repeatedFailure([a, review(40, 'A tarefa de item faltante não guarda o médico responsável nem a data da notificação.')])).toBe(true);
    // A finding with no line is about the whole file.
    expect(repeatedFailure([a, 'Review requested changes:\n- internal/application/validate.go [important] algo de outro tipo (fix: x)'])).toBe(true);
  });

  it('defaults to converging when unanswered, so the retry policy is unchanged', async () => {
    expect(await assessAttemptProgress(task, 2, history, fake({ answered: false, reason: 'disabled' }), { confidential: false })).toEqual({ progress: 'converging', source: 'default' });
  });
});
