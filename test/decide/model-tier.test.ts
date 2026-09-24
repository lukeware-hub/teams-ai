import { describe, expect, it } from 'vitest';
import { EFFORT_LEVELS, MODEL_TIERS, chooseModelTier, modelTierQuestions } from '../../server/decide/decisions/model-tier.js';
import type { DecisionOutcome } from '../../server/decide/types.js';
import { makePlanTask } from '../fixtures/contracts.js';

const task = makePlanTask({ id: 'T1', criteriaRefs: ['AC-001'], affectedPaths: ['src'] });
const fake = (o: DecisionOutcome) => ({ decide: async () => o });
const answered = (tier: string, effort: number): DecisionOutcome => ({
  answered: true,
  backend: 'jev',
  escalated: false,
  answers: {
    tier: { type: 'choice', value: tier, probabilities: { [tier]: 0.9 }, confidence: 0.9 },
    effort: { type: 'score', value: effort, probabilities: {}, confidence: 0.9 },
  },
});
const ctx = { confidential: false };

describe('model tier', () => {
  it('asks a choice for the tier and a score for the effort', () => {
    expect(MODEL_TIERS).toEqual(['small', 'medium', 'large']);
    expect(EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'max']);
    expect(modelTierQuestions().tier).toMatchObject({ type: 'choice' });
    expect(modelTierQuestions().effort).toMatchObject({ type: 'score', levels: [...EFFORT_LEVELS] });
  });
  it('uses the answer on attempt 1', async () => {
    expect(await chooseModelTier(task, 1, fake(answered('small', 0)), ctx)).toEqual({ tier: 'small', effort: 'low', source: 'jev' });
  });
  it('moves one tier and one effort level up per extra attempt, capped', async () => {
    expect(await chooseModelTier(task, 2, fake(answered('small', 0)), ctx)).toMatchObject({ tier: 'medium', effort: 'medium' });
    expect(await chooseModelTier(task, 5, fake(answered('small', 0)), ctx)).toMatchObject({ tier: 'large', effort: 'max' });
  });
  it('returns nulls when unanswered so the role default applies', async () => {
    expect(await chooseModelTier(task, 1, fake({ answered: false, reason: 'disabled' }), ctx)).toEqual({ tier: null, effort: null, source: 'default' });
  });
});
