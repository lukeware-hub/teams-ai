import { describe, expect, it } from 'vitest';
import { assessScopeDrift, scopeDriftQuestions, scopeDriftState } from '../../server/decide/decisions/scope-drift.js';
import type { Answers, DecisionOutcome } from '../../server/decide/types.js';
import { makePlanTask } from '../fixtures/contracts.js';

const task = makePlanTask({ id: 'T1', criteriaRefs: ['AC-001'], affectedPaths: ['src/t1/**'] });
const opts = { changedFiles: ['src/t1/a.ts', 'src/shared/b.ts'], outOfScope: ['src/shared/b.ts'], scopeJustification: 'b.ts needed a helper', diffStat: ' 2 files changed' };
const ctx = { confidential: false };
const fake = (o: DecisionOutcome) => ({ decide: async () => o });
const noul = (value: number) => ({ type: 'noul' as const, value, probabilities: { yes: value, no: 1 - value }, confidence: 0.9 });
const answered = (answers: Answers): DecisionOutcome => ({ answered: true, backend: 'jev', escalated: false, answers });

describe('scope drift', () => {
  it('asks one noul per out-of-scope file plus one for unrequired changes', () => {
    const q = scopeDriftQuestions(opts.outOfScope);
    expect(Object.keys(q)).toEqual(['file:src/shared/b.ts', 'unrequired']);
    expect(q['file:src/shared/b.ts']!.type).toBe('noul');
  });

  it('state carries the task, the justification and the out-of-scope list', () => {
    const s = scopeDriftState(task, opts);
    expect(s).toContain('AC-001');
    expect(s).toContain('b.ts needed a helper');
    expect(s).toContain('src/shared/b.ts');
  });

  it('a file judged not required forces high drift', async () => {
    const r = await assessScopeDrift(task, opts, fake(answered({ 'file:src/shared/b.ts': noul(0.1), unrequired: noul(0.1) })), ctx);
    expect(r).toEqual({ drift: 'high', unrequired: ['src/shared/b.ts'], source: 'jev' });
  });

  it('unrequired changes alone grade low or high by probability', async () => {
    const ok = answered({ 'file:src/shared/b.ts': noul(0.95), unrequired: noul(0.5) });
    expect(await assessScopeDrift(task, opts, fake(ok), ctx)).toMatchObject({ drift: 'low', unrequired: [] });
    const bad = answered({ 'file:src/shared/b.ts': noul(0.95), unrequired: noul(0.8) });
    expect(await assessScopeDrift(task, opts, fake(bad), ctx)).toMatchObject({ drift: 'high', unrequired: [] });
    const none = answered({ 'file:src/shared/b.ts': noul(0.95), unrequired: noul(0.1) });
    expect(await assessScopeDrift(task, opts, fake(none), ctx)).toMatchObject({ drift: 'none' });
  });

  it('defaults to none when unanswered', async () => {
    expect(await assessScopeDrift(task, opts, fake({ answered: false, reason: 'disabled' }), ctx)).toEqual({ drift: 'none', unrequired: [], source: 'default' });
  });
});
