import { describe, expect, it } from 'vitest';
import { FAILURE_CAUSES, classifyFailure, failureCauseQuestions, failureCauseState, retryable } from '../../server/decide/decisions/failure-cause.js';
import type { DecisionOutcome } from '../../server/decide/types.js';
import { choiceAnswer } from '../fixtures/fake-backend.js';

function fakeDecider(outcome: DecisionOutcome) {
  const calls: unknown[][] = [];
  return {
    calls,
    decide: async (...args: unknown[]) => {
      calls.push(args);
      return outcome;
    },
  };
}

describe('failure cause classification (R11.14)', () => {
  it('offers the three causes and sends the newest failure last', () => {
    expect(Object.keys(FAILURE_CAUSES).sort()).toEqual(['code-defect', 'environment', 'spec-problem']);
    expect(failureCauseQuestions().cause).toMatchObject({ type: 'choice', options: FAILURE_CAUSES });
    expect(failureCauseState(['first', 'second'])).toBe('attempt 1:\nfirst\n\nattempt 2:\nsecond');
  });

  it('uses the answer and asks decision failure-cause', async () => {
    const d = fakeDecider({ answered: true, backend: 'jev', escalated: false, answers: { cause: choiceAnswer('spec-problem', { 'spec-problem': 0.9 }) } });
    expect(await classifyFailure(['x'], d, { confidential: false })).toBe('spec-problem');
    expect(d.calls[0]![0]).toBe('failure-cause');
  });

  it('gives null when unanswered or the answer is not an option', async () => {
    expect(await classifyFailure(['x'], fakeDecider({ answered: false, reason: 'disabled' }), { confidential: false })).toBeNull();
    const odd = fakeDecider({ answered: true, backend: 'local', escalated: false, answers: { cause: choiceAnswer('luck', { luck: 1 }) } });
    expect(await classifyFailure(['x'], odd, { confidential: false })).toBeNull();
  });

  it('retries everything but a spec problem, an unanswered classification included, so a classifier that is down never stops the program', () => {
    expect([null, 'code-defect', 'environment'].map((c) => retryable(c as never))).toEqual([true, true, true]);
    expect(retryable('spec-problem')).toBe(false);
  });
});
