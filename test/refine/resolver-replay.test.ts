import { describe, expect, it } from 'vitest';
import { ownerAnswers, type JournalEvent } from '../../server/refine/agreement.js';
import { RefineEvent } from '../../server/refine/events.js';
import { renderResolverReport, replayResolver, summarize } from '../../server/refine/resolver-replay.js';

const T = (s: number) => new Date(Date.UTC(2026, 9, 27, 10, 0, s)).toISOString();
const ev = (s: number, type: string, data: Record<string, unknown>): JournalEvent => ({ type, at: T(s), data });
const round = (cycle: number, questions: unknown[], extra: Record<string, unknown> = {}) => ({ cycle, checklist: [], questions, discardedPatches: [], ...extra });
const answer = (s: number, questionId: string, text: string) => ev(s, RefineEvent.QuestionAnswered, { questionId, text });

const PRAZO = 'Qual o prazo de expiração do token de acesso?';
const RECOMMENDED = [{ label: '30 dias', detail: '', recommended: true }, { label: '90 dias', detail: '' }];
const q1 = { questionId: 'po-c1-0', role: 'po', text: PRAZO, blocking: true, relatedAcIds: ['AC-1'], cycle: 1, options: RECOMMENDED };
const q2 = { questionId: 'po-c1-1', role: 'po', text: 'Quais são as regras de cálculo?', blocking: true, relatedAcIds: ['AC-1'], cycle: 1, options: [{ label: 'A', detail: '' }, { label: 'B', detail: '', recommended: true }] };
const q3 = { questionId: 'po-c2-0', role: 'po', text: 'Qual o prazo de expiração do token de acesso em dias?', blocking: true, relatedAcIds: ['AC-1'], cycle: 2, options: RECOMMENDED };

/** A first answer (no gap), a deliberate answer of the assumable question, and a repeat of it in the next cycle. */
const journal = (repeatAnswer = '30 dias', floor: unknown = null): JournalEvent[] => [
  ev(0, RefineEvent.Evaluated, round(1, [q1, q2], { autoAnswerFloor: floor })),
  answer(3, 'po-c1-1', 'B'),
  answer(10, 'po-c1-0', '30 dias'),
  ev(40, RefineEvent.Evaluated, round(2, [q3])),
  answer(60, 'po-c2-0', repeatAnswer),
];

describe('the owner answers of the resolver replay', () => {
  it('pair each answer with its recommended option exactly as the agreement replay does', () => {
    expect(replayResolver(journal()).owner).toEqual(ownerAnswers(journal()));
  });
});

describe('the labels of the resolver replay', () => {
  it('label only deliberate answers: the first answer labels nothing, and each verdict has its own outcome', () => {
    const labels = replayResolver(journal()).labels.map((l) => [l.questionId, l.verdict, l.independent, l.outcome]);
    expect(labels).toEqual([
      ['po-c1-1', 'ask', false, null],
      ['po-c1-0', 'assume', true, true],
      ['po-c2-0', 'repeat', true, true],
    ]);
  });

  it('judges a repeat against the twin answer: a different option of the same question is a miss', () => {
    expect(replayResolver(journal('90 dias')).labels.at(-1)).toMatchObject({ verdict: 'repeat', outcome: false });
  });

  it('leaves a repeat with free text unlabelled, and counts it', () => {
    const replay = replayResolver(journal('depende do contrato'));
    expect(replay.labels.at(-1)).toMatchObject({ verdict: 'repeat', outcome: null });
    expect(summarize(replay).unlabelledRepeats).toBe(1);
  });

  it('leaves out the answers of an armed floor, which answered for the owner', () => {
    const replay = replayResolver(journal('30 dias', 0.9));
    expect(replay.labels.filter((l) => l.armed).map((l) => l.questionId)).toEqual(['po-c1-1', 'po-c1-0']);
    const summary = summarize(replay);
    expect(summary.armed).toBe(2);
    expect(summary.verdicts.find((v) => v.site === 'round' && v.verdict === 'assume')).toMatchObject({ labelled: 0 });
  });

  it('counts an answer a few seconds after the previous one as no label', () => {
    const burst = [ev(0, RefineEvent.Evaluated, round(1, [q1])), answer(10, 'po-c1-0', '30 dias'), answer(11, 'po-c1-0', '90 dias')];
    expect(replayResolver(burst).labels.map((l) => l.independent)).toEqual([false, false]);
  });
});

describe('the summary of the resolver replay', () => {
  it('tallies each verdict against its own rule, and each impact against the recommended option', () => {
    const summary = summarize(replayResolver(journal()));
    expect(summary.verdicts.find((v) => v.site === 'round' && v.verdict === 'assume')).toMatchObject({ resolved: 1, labelled: 1, agreed: 1, state: 'probation' });
    expect(summary.verdicts.find((v) => v.site === 'round' && v.verdict === 'repeat')).toMatchObject({ resolved: 1, labelled: 1, agreed: 1 });
    expect(summary.impacts.find((i) => i.impact === 'detail')).toMatchObject({ labelled: 2, agreed: 2 });
    expect(summary.impacts.find((i) => i.impact === 'unclassified')).toMatchObject({ labelled: 0 });
  });

  it('keeps only the answers inside the window of --since', () => {
    const summary = summarize(replayResolver(journal()), Date.parse(T(50)));
    expect(summary.verdicts.find((v) => v.site === 'round' && v.verdict === 'repeat')).toMatchObject({ labelled: 1 });
    expect(summary.verdicts.find((v) => v.site === 'round' && v.verdict === 'assume')).toMatchObject({ labelled: 0 });
  });

  it('says it is a DEV run first, and prints the audit only when asked', () => {
    const replay = replayResolver(journal());
    const lines = renderResolverReport(replay, { audit: 2 });
    expect(lines[0]).toContain('DEV run, not promotable');
    expect(lines.some((l) => l.includes('po-c1-1: Quais são as regras de cálculo?'))).toBe(true);
    expect(renderResolverReport(replay).some((l) => l.startsWith('audit'))).toBe(false);
  });
});
