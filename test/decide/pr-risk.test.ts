import { describe, expect, it } from 'vitest';
import { PR_RISK_LEVELS, REVIEW_PROFILE_DEPTH, choosePrRisk, prRiskState } from '../../server/decide/decisions/pr-risk.js';
import type { DecisionOutcome } from '../../server/decide/types.js';
import { makePlanTask } from '../fixtures/contracts.js';

const task = makePlanTask({ id: 'T1', criteriaRefs: ['AC-001'], affectedPaths: ['src'] });
const opts = { changedFiles: ['src/a.ts', 'src/b.ts'], diffStat: ' 2 files changed, 40 insertions(+)' };
const fake = (o: DecisionOutcome) => ({ decide: async () => o });
const score = (value: number): DecisionOutcome => ({ answered: true, backend: 'jev', escalated: false, answers: { risk: { type: 'score', value, probabilities: {}, confidence: 0.9 } } });

describe('pr risk', () => {
  it('levels are trivial → high and the state carries files and diff stat', () => {
    expect(PR_RISK_LEVELS).toEqual(['trivial', 'low', 'medium', 'high']);
    const s = prRiskState(task, opts);
    expect(s).toContain('src/a.ts');
    expect(s).toContain('40 insertions');
  });
  it('maps risk to a review profile', async () => {
    const ctx = { confidential: false };
    expect(await choosePrRisk(task, opts, fake(score(0)), ctx)).toMatchObject({ risk: 'trivial', profile: 'quick' });
    expect(await choosePrRisk(task, opts, fake(score(1)), ctx)).toMatchObject({ risk: 'low', profile: 'standard' });
    expect(await choosePrRisk(task, opts, fake(score(2)), ctx)).toMatchObject({ risk: 'medium', profile: 'standard' });
    expect(await choosePrRisk(task, opts, fake(score(3)), ctx)).toMatchObject({ risk: 'high', profile: 'deep', source: 'jev' });
  });
  it('defaults to standard when unanswered', async () => {
    expect(await choosePrRisk(task, opts, fake({ answered: false, reason: 'disabled' }), { confidential: false })).toEqual({ risk: 'medium', profile: 'standard', source: 'default' });
    expect(REVIEW_PROFILE_DEPTH.standard).toBe(2);
  });
});
