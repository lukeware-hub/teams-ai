import { describe, expect, it } from 'vitest';
import { RefineEvent, type Question } from '../../server/refine/events.js';
import { checkRepeats, differenceHolds, repeatNote, repeatsOf } from '../../server/refine/question-guard.js';
import { reduceRefineEvents, type QuestionRow } from '../../server/refine/state.js';

const decided = (over: Partial<QuestionRow> = {}): QuestionRow =>
  ({ questionId: 'speckit-a', role: 'po', text: 'Qual prazo vale para o link de recuperação?', blocking: false, relatedAcIds: [], cycle: 1, origin: 'speckit', itemKey: 'login', status: 'answered', answer: 'Noventa dias', ...over }) as QuestionRow;
const asked = (over: Partial<Question> = {}): Question => ({ questionId: 'speckit-b', role: 'po', text: 'Até quando o link de recuperação vale?', blocking: false, relatedAcIds: [], cycle: 2, origin: 'speckit', itemKey: 'login', ...over });
const DIFFERENCE = 'Vale até o fim do prazo de envio, não por noventa dias corridos.';

describe('repeatsOf', () => {
  it('finds the decided questions of the same item that the new one repeats', () => {
    expect(repeatsOf(asked(), [decided()]).map((q) => q.questionId)).toEqual(['speckit-a']);
  });

  it('ignores pending questions, other items and questions about another fact', () => {
    expect(repeatsOf(asked(), [decided({ status: 'pending', answer: null })])).toEqual([]);
    expect(repeatsOf(asked(), [decided({ itemKey: 'cart' })])).toEqual([]);
    expect(repeatsOf(asked({ text: 'Qual moeda cobramos?' }), [decided()])).toEqual([]);
  });

  it('counts a question the owner skipped, and never one the PO or the SM answered', () => {
    expect(repeatsOf(asked(), [decided({ status: 'skipped', answer: null })])).toHaveLength(1);
    expect(repeatsOf(asked(), [decided({ answeredBy: 'po' })])).toEqual([]);
  });
});

describe('differenceHolds', () => {
  it('needs a sentence of at least eight words with a fact the decided question did not have', () => {
    expect(differenceHolds('Vale até o fim.', decided())).toBe(false);
    expect(differenceHolds('Vale para o link de recuperação, por noventa dias, do prazo.', decided())).toBe(false);
    expect(differenceHolds(DIFFERENCE, decided())).toBe(true);
  });
});

describe('checkRepeats', () => {
  it('keeps a question that repeats nothing decided', () => {
    const r = checkRepeats([asked({ text: 'Qual moeda cobramos?' })], [decided()]);
    expect(r.kept).toHaveLength(1);
    expect(r.unresolved).toEqual([]);
  });

  it('leaves a repeat with no difference unresolved, with the decided question it repeats', () => {
    expect(checkRepeats([asked()], [decided()])).toEqual({ kept: [], unresolved: [{ question: asked(), matches: [decided()] }] });
  });

  it('keeps a repeat whose distinctFrom names a difference that holds', () => {
    const q = asked({ distinctFrom: [{ questionId: 'speckit-a', difference: DIFFERENCE }] });
    expect(checkRepeats([q], [decided()])).toEqual({ kept: [q], unresolved: [] });
  });

  it('does not keep a repeat whose distinctFrom names another question', () => {
    const q = asked({ distinctFrom: [{ questionId: 'speckit-zzz', difference: DIFFERENCE }] });
    expect(checkRepeats([q], [decided()]).kept).toEqual([]);
  });
});

describe('repeatNote', () => {
  it('names each repeated question with its id and answer, and the one way to keep the new question', () => {
    const note = repeatNote([{ question: asked(), matches: [decided()] }]);
    expect(note).toContain('"Até quando o link de recuperação vale?" repeats:');
    expect(note).toContain('id speckit-a: "Qual prazo vale para o link de recuperação?", decided as "Noventa dias"');
    expect(note).toContain('distinctFrom');
  });
});

describe('the journal keeps a dropped repeat until the owner asks for it again', () => {
  const drop = {
    type: RefineEvent.QuestionDropped,
    data: { questionId: 'speckit-b', role: 'po', text: 'Até quando o link de recuperação vale?', cycle: 2, command: 'specify', itemKey: 'login', matchedQuestionId: 'speckit-a', matchedText: 'Qual prazo vale para o link de recuperação?', matchedAnswer: 'Noventa dias' },
  };

  it('records the drop beside the questions, once per question', () => {
    const s = reduceRefineEvents([drop, drop]);
    expect(s.droppedQuestions).toEqual([expect.objectContaining({ questionId: 'speckit-b', matchedAnswer: 'Noventa dias' })]);
    expect(s.questions).toEqual([]);
  });

  it('brings a dropped question back as a pending one when the owner asks for it', () => {
    const s = reduceRefineEvents([drop, { type: RefineEvent.QuestionReasked, data: { ...drop.data } }]);
    expect(s.droppedQuestions).toEqual([]);
    expect(s.questions).toEqual([expect.objectContaining({ questionId: 'speckit-b', status: 'pending', origin: 'speckit', itemKey: 'login', text: 'Até quando o link de recuperação vale?' })]);
  });

  it('never adds a question twice when it is already on record', () => {
    const s = reduceRefineEvents([
      { type: RefineEvent.SpeckitStepDone, data: { command: 'specify', itemKey: 'login', files: [], questions: [{ questionId: 'speckit-b', role: 'po', text: 'Até quando o link de recuperação vale?', blocking: false, relatedAcIds: [], cycle: 2 }] } },
      drop,
      { type: RefineEvent.QuestionReasked, data: { ...drop.data } },
    ]);
    expect(s.questions).toHaveLength(1);
  });
});
