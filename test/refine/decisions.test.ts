import { describe, expect, it } from 'vitest';
import { withDecisions } from '../../server/refine/decisions.js';
import type { QuestionRow } from '../../server/refine/state.js';
import { makeSpec } from '../fixtures/contracts.js';

const row = (questionId: string, text: string, status: QuestionRow['status'], answer: string | null, answeredBy?: 'po' | 'sm'): QuestionRow =>
  ({ questionId, role: 'po', text, blocking: false, relatedAcIds: [], cycle: 1, status, answer, ...(answeredBy ? { answeredBy } : {}) });

describe('withDecisions', () => {
  it('records each answered question with the role that answered from the docs, and skips pending and skipped ones', () => {
    const spec = withDecisions(makeSpec(), [row('q1', 'Port?', 'answered', '8080'), row('q2', 'Region?', 'answered', 'eu', 'sm'), row('q3', 'Cache?', 'pending', null), row('q4', 'Queue?', 'skipped', null)]);
    expect(spec.decisions).toEqual([{ question: 'Port?', answer: '8080' }, { question: 'Region?', answer: 'eu', by: 'sm' }]);
  });

  it('keeps earlier decisions, and a later answer to the same question replaces the earlier one', () => {
    const earlier = { ...makeSpec(), decisions: [{ question: 'Port?', answer: '80' }, { question: 'Region?', answer: 'eu' }] };
    const spec = withDecisions(earlier, [row('q1', '  port?  ', 'answered', '8080')]);
    expect(spec.decisions).toEqual([{ question: '  port?  ', answer: '8080' }, { question: 'Region?', answer: 'eu' }]);
  });

  it('returns the spec untouched when nothing was answered', () => {
    const spec = makeSpec();
    expect(withDecisions(spec, [row('q1', 'Port?', 'pending', null)])).toBe(spec);
  });
});
