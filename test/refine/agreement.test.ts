import { describe, expect, it } from 'vitest';
import { bands, clusterInterval, leaveOneItemOut, ownerAnswers, type JournalEvent } from '../../server/refine/agreement.js';

const clock = (s: number) => new Date(Date.UTC(2026, 9, 27, 10, 0, s)).toISOString();

// Two plan items. q4 has no recommended option, and the last answer is a role's, so neither is a sample.
const journal: JournalEvent[] = [
  {
    type: 'SPECKIT_STEP_DONE',
    at: clock(0),
    data: {
      questions: [
        { questionId: 'q1', itemKey: 'item-a', options: [{ label: 'sim', recommended: true }, { label: 'não' }] },
        { questionId: 'q2', itemKey: 'item-b', options: [{ label: 'não', recommended: true }, { label: 'sim' }] },
        { questionId: 'q3', itemKey: 'item-b', options: [{ label: 'sim', recommended: true }, { label: 'não' }] },
        { questionId: 'q4', itemKey: 'item-a', options: [{ label: 'a' }] },
      ],
    },
  },
  { type: 'QUESTION_ANSWERED', at: clock(5), data: { questionId: 'q1', text: 'sim' } },
  { type: 'QUESTION_ANSWERED', at: clock(6), data: { questionId: 'q2', text: 'sim' } },
  { type: 'QUESTION_ANSWERED', at: clock(16), data: { questionId: 'q3', text: 'sim' } },
  { type: 'QUESTION_ANSWERED', at: clock(56), data: { questionId: 'q1', text: 'não' } },
  { type: 'QUESTION_ANSWERED', at: clock(66), data: { questionId: 'q4', text: 'a' } },
  { type: 'QUESTION_ANSWERED', at: clock(67), data: { questionId: 'q3', text: 'x', by: 'po' } },
];

describe('owner agreement replay', () => {
  it('pairs each owner answer with its recommended option and its pause since the previous answer', () => {
    expect(ownerAnswers(journal)).toEqual([
      { questionId: 'q1', item: 'item-a', gapSeconds: null, agreed: true },
      { questionId: 'q2', item: 'item-b', gapSeconds: 1, agreed: false },
      { questionId: 'q3', item: 'item-b', gapSeconds: 10, agreed: true },
      { questionId: 'q1', item: 'item-a', gapSeconds: 40, agreed: false },
    ]);
  });

  it('judges an answer against the recommendation the owner saw last, after a triage re-decided it', () => {
    const triaged: JournalEvent[] = [
      { type: 'SPECKIT_STEP_DONE', at: clock(0), data: { questions: [{ questionId: 'q9', itemKey: 'item-c', options: [{ label: 'não', recommended: true }, { label: 'sim' }] }] } },
      { type: 'SPECKIT_TRIAGED', at: clock(1), data: { results: [{ questionId: 'q9', options: [{ label: 'sim', recommended: true }, { label: 'não' }] }] } },
      { type: 'QUESTION_ANSWERED', at: clock(5), data: { questionId: 'q9', text: 'sim' } },
    ];
    expect(ownerAnswers(triaged)).toEqual([{ questionId: 'q9', item: 'item-c', gapSeconds: null, agreed: true }]);
  });

  it('gives agreement by pause, with the first answer in the total only, and the labels', () => {
    const answers = ownerAnswers(journal);
    const counts = bands(answers).map((b) => [b.label, b.n, b.agreed]);
    expect(counts).toEqual([
      ['all answers', 4, 2],
      ['under 3 s', 1, 0],
      ['3 to 30 s', 1, 1],
      ['30 s and more', 1, 0],
      ['labels (3 s and more)', 2, 1],
    ]);
    expect(bands(answers)[4]!.share).toBe(0.5);
  });

  it('bootstraps the labels by item, the same way every run', () => {
    const answers = ownerAnswers(journal);
    expect(clusterInterval(answers)).toEqual([0, 1]);
    expect(clusterInterval(answers)).toEqual(clusterInterval(answers));
  });

  it('leaves each item out in turn, and reports the lowest and the highest agreement', () => {
    const loo = leaveOneItemOut(ownerAnswers(journal));
    expect(loo).toEqual({ lowest: { item: 'item-b', share: 0 }, highest: { item: 'item-a', share: 1 } });
  });

  it('has no leave-one-out with fewer than two items', () => {
    expect(leaveOneItemOut(ownerAnswers(journal.slice(0, 2)))).toBeNull();
  });
});
