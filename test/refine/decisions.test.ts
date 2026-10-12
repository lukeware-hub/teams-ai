import { describe, expect, it } from 'vitest';
import { parseDecisions, withDecisions } from '../../server/refine/decisions.js';
import { renderBriefMd } from '../../server/refine/draft.js';
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

// Plan 76 review: the brief is where the owner reads and edits the decisions, so they come back from it as the owner left them.
describe('parseDecisions', () => {
  it('reads back what the brief renders, a multi-line answer and the role included, and stops at the next section', () => {
    const decisions = [{ question: 'Port?', answer: '8080' }, { question: 'NATS down?', answer: 'Reply 200.\n## Observação\n\nRetry later.', by: 'sm' as const }];
    expect(parseDecisions(renderBriefMd({ ...makeSpec(), decisions }, 'GET /x returned 500'))).toEqual(decisions);
  });

  it("takes the owner's edits: a changed answer and a removed item", () => {
    const md = renderBriefMd({ ...makeSpec(), decisions: [{ question: 'Port?', answer: '8080' }, { question: 'Region?', answer: 'eu' }] });
    const edited = md.replace('Answer: 8080', 'Answer: 9090').replace('- Region?\n  Answer: eu\n', '');
    expect(parseDecisions(edited)).toEqual([{ question: 'Port?', answer: '9090' }]);
  });

  it('is undefined when the brief has no decisions section or no item in it', () => {
    expect(parseDecisions(renderBriefMd(makeSpec()))).toBeUndefined();
    expect(parseDecisions('## Decisions\n\n')).toBeUndefined();
  });
});
