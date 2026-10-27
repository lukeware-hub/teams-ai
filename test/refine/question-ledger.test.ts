import { describe, expect, it } from 'vitest';
import { RefineEvent } from '../../server/refine/events.js';
import { speckitPack, type SpeckitItem } from '../../server/refine/speckit-pack.js';
import { reduceRefineEvents, type QuestionRow } from '../../server/refine/state.js';

const item: SpeckitItem = { key: 'rule-registry', specId: 'rule-registry', title: 'Registro de regras' };
const row = (over: Partial<QuestionRow>): QuestionRow => ({ questionId: 'po-1', role: 'po', text: 'Qual regra?', blocking: true, relatedAcIds: [], cycle: 1, status: 'pending', answer: null, ...over }) as QuestionRow;
const HEADING = '### Earlier questions of this item (the latest owner answer wins; never ask one of them again, even reworded)';

describe('the Spec Kit pack lists the earlier questions of its item', () => {
  it('shows each question with its state, and the latest owner answer first', () => {
    const feedback = speckitPack({
      command: 'specify',
      specHash: 'h',
      inputDir: 'in',
      item,
      history: [
        row({ questionId: 'a', text: 'Recusar?', status: 'answered', answer: 'Recusar a versão', answeredAt: '2026-10-27T10:00:00.000Z' }),
        row({ questionId: 'b', text: 'Aceitar?', status: 'answered', answer: 'Aceitar a nova versão', answeredAt: '2026-10-27T11:00:00.000Z', answeredBy: null }),
        row({ questionId: 'c', text: 'Qual prazo?' }),
      ],
    }).feedback ?? '';
    expect(feedback).toContain(HEADING);
    const latest = feedback.indexOf('- [po] Aceitar?');
    const older = feedback.indexOf('- [po] Recusar?');
    expect(latest).toBeGreaterThan(-1);
    expect(latest).toBeLessThan(older);
    expect(feedback).toContain('answered by the owner on 2026-10-27T11:00:00.000Z: Aceitar a nova versão');
    expect(feedback).toContain('open, waiting for the owner');
  });

  it('says none when the item has no earlier question', () => {
    const feedback = speckitPack({ command: 'specify', specHash: 'h', inputDir: 'in', item, history: [] }).feedback ?? '';
    expect(feedback).toContain(`${HEADING}\n(none)`);
  });

  it('names the agent that answered from the documents', () => {
    const feedback = speckitPack({
      command: 'plan',
      specHash: 'h',
      inputDir: 'in',
      item,
      history: [row({ questionId: 'sm-1', role: 'sm', text: 'Qual porta?', status: 'answered', answer: '8080', answeredBy: 'sm', answeredAt: '2026-10-27T12:00:00.000Z' })],
    }).feedback ?? '';
    expect(feedback).toContain('- [sm] Qual porta?\n  answered by the SM on 2026-10-27T12:00:00.000Z: 8080');
  });
});

describe('the journal keeps when each question was answered', () => {
  it('stores the event time of the owner answer', () => {
    const asked = { questionId: 'po-1', role: 'po', text: 'Qual prazo?', blocking: true, relatedAcIds: [], cycle: 1 };
    const state = reduceRefineEvents([
      { type: RefineEvent.SpeckitStepDone, at: '2026-10-27T10:00:00.000Z', data: { command: 'specify', itemKey: 'rule-registry', files: [], questions: [asked] } },
      { type: RefineEvent.QuestionAnswered, at: '2026-10-27T11:00:00.000Z', data: { questionId: 'po-1', text: 'Dez dias' } },
    ]);
    expect(state.questions[0]).toMatchObject({ status: 'answered', answer: 'Dez dias', answeredAt: '2026-10-27T11:00:00.000Z' });
  });
});
