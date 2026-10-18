import { describe, expect, it } from 'vitest';
import { EFFORT_LEVELS, MODEL_TIERS, chooseModelTier, heuristicTier, modelTierQuestions } from '../../server/decide/decisions/model-tier.js';
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

describe('heuristicTier', () => {
  const t = (over: Parameters<typeof makePlanTask>[0]) => makePlanTask({ affectedPaths: ['src/a.ts'], criteriaRefs: ['AC-001'], ...over });
  const ac = (n: number) => Array.from({ length: n }, (_, i) => `AC-${String(i + 1).padStart(3, '0')}`);

  it("sizes a service's scaffold like the project's: large", () => {
    expect(heuristicTier(t({ id: 'T0-scaffold-inventory-api', service: 'inventory-api', title: 'Scaffold', description: 'x' }), 1).tier).toBe('large');
  });

  it('sizes a task from what the plan says about it', () => {
    expect(heuristicTier(t({ id: 'T9-readme', title: 'Write the README', description: 'x'.repeat(900) }), 1).tier).toBe('small');
    expect(heuristicTier(t({ id: 'T2-list', title: 'List todos', description: 'x'.repeat(1500), criteriaRefs: ac(4) }), 1).tier).toBe('medium');
    expect(heuristicTier(t({ id: 'T4-docker', title: 'Docker deploy', affectedPaths: ['a', 'b', 'c', 'd'], criteriaRefs: [] }), 1).tier).toBe('medium');
    expect(heuristicTier(t({ id: 'T3-big', title: 'Big', criteriaRefs: ac(6) }), 1).tier).toBe('large');
    expect(heuristicTier(t({ id: 'T4-many', title: 'Many files', affectedPaths: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] }), 1).tier).toBe('large');
    expect(heuristicTier(t({ id: 'T4-long', title: 'Long', description: 'x'.repeat(2600) }), 1).tier).toBe('large');
  });

  it('keeps the scaffold and risky work on the large tier, judging by the title and paths only', () => {
    expect(heuristicTier(t({ id: 'T0-scaffold', title: 'Project skeleton' }), 1).tier).toBe('large');
    for (const title of ['Add login', 'Rotate the session token', 'Database migration']) {
      expect(heuristicTier(t({ id: 'T1-x', title }), 1).tier).toBe('large');
    }
    expect(heuristicTier(t({ id: 'T1-x', title: 'Store', affectedPaths: ['src/auth/store.ts'] }), 1).tier).toBe('large');
    // package-lock, crypto.randomUUID and docker login in a description are not risk.
    expect(heuristicTier(t({ id: 'T1-x', title: 'Block list', description: 'Commit package-lock, use crypto.randomUUID, docker login.' }), 1).tier).toBe('small');
  });

  it('moves one tier up per failed attempt and never sets an effort', () => {
    const small = t({ id: 'T9-readme', title: 'Write the README' });
    expect(heuristicTier(small, 2).tier).toBe('medium');
    expect(heuristicTier(small, 3).tier).toBe('large');
    expect(heuristicTier(small, 9)).toEqual({ tier: 'large', effort: null, source: 'heuristic' });
  });
});

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
