import { describe, expect, it } from 'vitest';
import { RefineEvent } from '../../server/refine/events.js';
import { impactOf, nearestTwin, ownerLedger, RULES, resolveCard, resolveLanding, resolveQuestion, type Subject } from '../../server/refine/resolver.js';
import { applyRefineEvent, emptyRefineState } from '../../server/refine/state.js';

const q = (text: string, extra: Partial<Subject> = {}): Subject => ({ questionId: 'po-c1-0', text, relatedAcIds: [], ...extra });
const recommended = [{ label: '30 dias', detail: '', recommended: true }, { label: '90 dias', detail: '' }];

/** Synthetic questions, placeholders only: the scope ones must never come out as detail. */
const SCOPE = [
  'Incluir o módulo de relatórios nesta entrega?',
  'Devemos incluir o registro de auditoria na primeira fase?',
  'Priorizar o cadastro antes do pagamento?',
  'Podemos adiar a integração para depois da entrega?',
  'Remover a tela de ajuda do escopo?',
  'A funcionalidade entra na primeira versão?',
  'INCLUIR O MÓDULO DE RELATÓRIOS?',
  'Incluído na primeira fase?',
  'Should we include the audit log in this release?',
  'Can the export be deferred to a later release?',
];
const DETAIL = [
  'Qual o prazo de expiração do token de acesso?',
  'Qual o nome do campo de e-mail?',
  'Quantas tentativas de login são permitidas?',
  'What is the value of the session timeout?',
];
const UNCLASSIFIED = ['Como o sistema trata a sessão expirada?', 'Quais são as regras de cálculo?', 'Quem aprova a troca de senha?'];

describe('the resolver rules', () => {
  it('stay frozen: a change of any number is a new stamp and a new holdout', () => {
    expect(RULES).toEqual({ stamp: 'r2', repeat: { overlap: 0.8, words: 4 }, gate: { labels: 40, z: 1.645, lower: 0.8, bad: 0.6 } });
  });
});

describe('the scope vocabulary, after the DEV audit of r1 (plan 101)', () => {
  it.each([
    'Qual o prazo para o item entregue?',
    'Qual o prazo da versão vigente da política?',
    'Qual o prazo da regularização posterior?',
    'Qual o prazo para os atos, inclusive os urgentes?',
    'Qual o prazo próximo do vencimento?',
  ])('does not take the ordinary or domain sense of a word for scope: %s', (text) => {
    expect(impactOf(q(text)).impact).toBe('detail');
  });
});

describe('the impact of a question', () => {
  it.each(SCOPE)('classifies %s as scope', (text) => {
    expect(impactOf(q(text)).impact).toBe('scope');
  });

  it.each(DETAIL)('classifies %s as detail', (text) => {
    expect(impactOf(q(text)).impact).toBe('detail');
  });

  it.each(UNCLASSIFIED)('leaves %s unclassified, so the owner is asked', (text) => {
    expect(impactOf(q(text)).impact).toBe('unclassified');
  });

  it('reads a scope cue in an option, not only in the question', () => {
    expect(impactOf(q('Qual o valor do limite?', { options: [{ label: '10', detail: 'Inclui o módulo extra.' }] })).impact).toBe('scope');
  });

  it('treats the platform questions as scope, by their rule or their id', () => {
    expect(impactOf(q('Qual o valor do limite?', { rule: 'outline' })).impact).toBe('scope');
    expect(impactOf(q('Qual o valor do limite?', { questionId: 'gap-c1-0' })).impact).toBe('scope');
  });
});

describe('the verdict of a question', () => {
  it('assumes the recommended option of a detail question', () => {
    expect(resolveQuestion(q(DETAIL[0]!, { options: recommended }), 'round', [])).toMatchObject({ verdict: 'assume', recommended: '30 dias', impact: 'detail' });
  });

  it('asks the owner when two options are marked recommended', () => {
    const both = [{ label: 'a', detail: '', recommended: true }, { label: 'b', detail: '', recommended: true }];
    expect(resolveQuestion(q(DETAIL[0]!, { options: both }), 'round', []).verdict).toBe('ask');
  });

  it('escalates a scope question even when it repeats an answer', () => {
    const ledger = [q(SCOPE[0]!, { questionId: 'po-c0-0' })];
    expect(resolveQuestion(q(SCOPE[0]!), 'round', ledger).verdict).toBe('escalate');
  });

  it('takes evidence from a verified card before an assumption', () => {
    expect(resolveQuestion(q(DETAIL[0]!, { options: recommended }), 'speckit', [], true).verdict).toBe('evidence');
  });

  it('repeats an answered question of the same context with near-identical words', () => {
    const ledger = [q('Qual o prazo de expiração do token de acesso?', { questionId: 'po-c1-0', relatedAcIds: ['AC-1'] })];
    const repeat = resolveQuestion(q('Qual o prazo de expiração do token de acesso em dias?', { questionId: 'po-c2-0', relatedAcIds: ['AC-1'] }), 'round', ledger);
    expect(repeat).toMatchObject({ verdict: 'repeat', nearest: { of: 'po-c1-0', sameDigits: true } });
    expect(repeat.nearest!.score).toBeCloseTo(0.8);
  });

  it('does not repeat when the digits differ, though the words are as close', () => {
    const ledger = [q('Qual o prazo de expiração do token de acesso?', { questionId: 'po-c1-0', relatedAcIds: ['AC-1'] })];
    const near = resolveQuestion(q('Qual o prazo de expiração do token de acesso em 30 dias?', { questionId: 'po-c2-0', relatedAcIds: ['AC-1'] }), 'round', ledger);
    expect(near.verdict).not.toBe('repeat');
    expect(near.nearest).toMatchObject({ of: 'po-c1-0', sameDigits: false });
  });

  it('needs four content words to repeat by overlap, and the same text repeats at once', () => {
    const short = [q('Qual o prazo exato?', { questionId: 'po-c1-0', relatedAcIds: ['AC-1'] })];
    expect(nearestTwin(q('Qual o prazo exato hoje?', { questionId: 'po-c2-0', relatedAcIds: ['AC-1'] }), short)!.score).toBe(0);
    expect(resolveQuestion(q('Qual o prazo exato?', { questionId: 'po-c2-0', relatedAcIds: ['AC-1'] }), 'round', short).verdict).toBe('repeat');
  });

  it('finds no twin outside the context of the question', () => {
    const ledger = [q(DETAIL[0]!, { questionId: 'po-c1-0', itemKey: 'item-a' })];
    expect(nearestTwin(q(DETAIL[0]!, { itemKey: 'item-b' }), ledger)).toBeUndefined();
  });
});

describe('what an event lands', () => {
  it('resolves only the questions the state does not hold yet, and names a stage question by its file', () => {
    const state = emptyRefineState();
    const first = q(DETAIL[0]!, { options: recommended });
    applyRefineEvent(state, { type: RefineEvent.Evaluated, data: { cycle: 1, checklist: [], questions: [first], discardedPatches: [] } });
    const second = q(DETAIL[1]!, { questionId: 'po-c1-1', options: recommended });
    const landed = resolveLanding({ type: RefineEvent.Evaluated, data: { questions: [first, second] } }, state);
    expect(landed.map((r) => r.questionId)).toEqual(['po-c1-1']);
    const stage = resolveLanding({ type: RefineEvent.StageReviewed, data: { file: 'briefing.md', questions: [{ ...second, questionId: 'po-s1-0' }] } }, emptyRefineState());
    expect(stage[0]).toMatchObject({ site: 'stage', item: 'doc:briefing.md' });
  });

  it('re-decides a pending Spec Kit question from its triage card, with evidence and the card recommendation', () => {
    const state = emptyRefineState();
    applyRefineEvent(state, { type: RefineEvent.Evaluated, data: { cycle: 1, checklist: [], questions: [q(DETAIL[0]!, { options: recommended })], discardedPatches: [] } });
    const card = { questionId: 'po-c1-0', text: DETAIL[0], subject: 'Prazo', options: [{ label: '90 dias', detail: '', recommended: true }, { label: '30 dias', detail: '' }], answer: { text: '90 dias' } };
    const [resolved] = resolveCard({ type: RefineEvent.SpeckitTriaged, data: { results: [card] } }, state);
    expect(resolved).toMatchObject({ evidence: true, verdict: 'evidence', recommended: '90 dias', site: 'speckit' });
  });

  it('leaves an agent answer out of the ledger, so it never settles a repeat', () => {
    const state = emptyRefineState();
    applyRefineEvent(state, { type: RefineEvent.Evaluated, data: { cycle: 1, checklist: [], questions: [q(DETAIL[0]!)], discardedPatches: [] } });
    applyRefineEvent(state, { type: RefineEvent.QuestionAnswered, data: { questionId: 'po-c1-0', text: '30 dias', by: 'po' } });
    expect(ownerLedger(state)).toEqual([]);
  });

  it('reads the state and changes none of it, so a replay leaves every flow as it was', () => {
    const state = emptyRefineState();
    applyRefineEvent(state, { type: RefineEvent.Evaluated, data: { cycle: 1, checklist: [], questions: [q(DETAIL[0]!, { options: recommended })], discardedPatches: [] } });
    const before = JSON.stringify(state);
    resolveLanding({ type: RefineEvent.Evaluated, data: { questions: [q(DETAIL[1]!, { questionId: 'po-c1-1' })] } }, state);
    resolveCard({ type: RefineEvent.SpeckitTriaged, data: { results: [{ questionId: 'po-c1-0', text: DETAIL[0] }] } }, state);
    expect(JSON.stringify(state)).toBe(before);
  });
});
