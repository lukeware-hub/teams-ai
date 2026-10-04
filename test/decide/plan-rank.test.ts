import { describe, expect, it } from 'vitest';
import { PLAN_RANK_LEVELS, planRankQuestions, planRankState, rankPlans } from '../../server/decide/decisions/plan-rank.js';
import type { DecisionOutcome, ScoreAnswer } from '../../server/decide/types.js';
import { makeFrozenSpec, makePlan } from '../fixtures/contracts.js';

const spec = makeFrozenSpec();
const a = makePlan(spec);
const b = makePlan(spec, { stack: 'node-alt' });
const score = (value: number): ScoreAnswer => ({ type: 'score', value, probabilities: {}, confidence: 0.9 });
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

describe('plan rank', () => {
  it('asks one score per candidate on the five levels', () => {
    const q = planRankQuestions(2);
    expect(Object.keys(q)).toEqual(['c0', 'c1']);
    expect(q.c1).toMatchObject({ type: 'score', levels: PLAN_RANK_LEVELS });
  });

  it('describes every candidate with its tasks and the acceptance criteria', () => {
    const s = planRankState(spec, [a, b]);
    expect(s).toContain('acceptance criteria:');
    expect(s).toContain('candidate c0: stack node-typescript');
    expect(s).toContain('candidate c1: stack node-alt');
    expect(s).toContain('T1-create');
  });

  it('a single candidate needs no question', async () => {
    const d = fakeDecider({ answered: false, reason: 'disabled' });
    expect(await rankPlans(spec, [a], d, { confidential: false })).toEqual({ index: 0, source: 'rule' });
    expect(d.calls).toHaveLength(0);
  });

  it('picks the highest score and keeps the first plan on a tie', async () => {
    const better = fakeDecider({ answered: true, backend: 'jev', escalated: false, answers: { c0: score(2), c1: score(3.4) } });
    expect(await rankPlans(spec, [a, b], better, { confidential: false })).toEqual({ index: 1, source: 'jev' });
    expect(better.calls[0]![0]).toBe('plan-rank');
    const tie = fakeDecider({ answered: true, backend: 'local', escalated: false, answers: { c0: score(3), c1: score(3) } });
    expect(await rankPlans(spec, [a, b], tie, { confidential: false })).toEqual({ index: 0, source: 'local' });
  });

  it('keeps the first plan when unanswered or an answer is missing', async () => {
    expect(await rankPlans(spec, [a, b], fakeDecider({ answered: false, reason: 'exhausted' }), { confidential: false })).toEqual({ index: 0, source: 'default' });
    const partial = fakeDecider({ answered: true, backend: 'jev', escalated: false, answers: { c0: score(1) } });
    expect(await rankPlans(spec, [a, b], partial, { confidential: false })).toEqual({ index: 0, source: 'default' });
  });
});
