import { describe, expect, it } from 'vitest';
import { MAX_STATE_CHARS } from '../../server/decide/decider.js';
import { preplanFlags, specFlags } from '../../server/decide/decisions/detail-check.js';
import type { DecisionOutcome, NoulAnswer } from '../../server/decide/types.js';

const ac = (id: string, given: string, then = 'a resposta é 201') => ({ id, given, when: 'o teste cadastra', then, smoke: false });
const noul = (value: number): NoulAnswer => ({ type: 'noul', value, probabilities: { yes: value, no: 1 - value }, confidence: Math.max(value, 1 - value) });
const answer = (value: number): DecisionOutcome => ({ answered: true, backend: 'jev', escalated: false, answers: { q0: noul(value) } });
const none: DecisionOutcome = { answered: false, reason: 'disabled' };
type Call = { id: string; state: string; questions: Record<string, { instructions: string }> };
/** Answers each call from its state and its question, and records every call. */
function fakeDecider(by: (state: string, instructions: string) => DecisionOutcome) {
  const calls: Call[] = [];
  return { calls, decide: async (id: string, state: string, questions: Call['questions']) => { calls.push({ id, state, questions }); return by(state, questions.q0!.instructions); } };
}
const ctx = { confidential: false };
const item = { key: 'emprestimo', title: 'Empréstimo', scope: 'Registrar empréstimos' };
const sections = [{ heading: 'flow.md › 2. Empréstimo', text: '## 2. Empréstimo\n\nO bibliotecário registra o empréstimo de um livro.' }];
const spec = (features = ['empréstimo']) => ({
  objectives: ['Registrar empréstimos'], features, outOfScope: [],
  acceptanceCriteria: [ac('AC-001', 'um livro criado pelo teste'), ac('AC-002', 'o banco vazio', 'a lista tem 0 itens')],
});
const isCited = (instructions: string) => instructions.includes('cited sections');

describe('detail-check', () => {
  it('flags a spec outside its cited sections and each criterion that needs what its test cannot control', async () => {
    const d = fakeDecider((state, q) => answer(isCited(q) ? (state.includes('multa') ? 0.9 : 0.1) : state.includes('banco vazio') ? 0.85 : 0.05));
    const issues = await specFlags({ item, sections, spec: spec(['empréstimo', 'multa por atraso']) }, d as never, ctx);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatch(/^o Jev apontou que a spec acrescenta/);
    expect(issues[1]).toContain('"Dado o banco vazio, quando o teste cadastra, então a lista tem 0 itens"');
    // One question per call, so one unsure answer never silences another.
    expect(d.calls).toHaveLength(3);
    expect(d.calls.every((c) => c.id === 'detail-check' && Object.keys(c.questions).join() === 'q0')).toBe(true);
    const criterion = d.calls.filter((c) => !isCited(c.questions.q0!.instructions)).map((c) => c.state);
    expect(criterion[0]).toContain('um livro criado pelo teste');
    expect(criterion[0]).not.toContain('banco vazio');
  });

  it('flags nothing when the Jev does not answer or finds nothing', async () => {
    expect(await specFlags({ item, sections, spec: spec() }, fakeDecider(() => none) as never, ctx)).toEqual([]);
    expect(await specFlags({ item, sections, spec: spec() }, fakeDecider(() => answer(0.2)) as never, ctx)).toEqual([]);
  });

  it('asks no cited-sections question when the spec state would be cut, and still asks each criterion', async () => {
    const d = fakeDecider(() => answer(0.9));
    const long = [{ heading: 'briefing.md › Decisões', text: 'x'.repeat(MAX_STATE_CHARS) }];
    expect(await specFlags({ item, sections: long, spec: spec() }, d as never, ctx)).toHaveLength(2);
    expect(d.calls.some((c) => isCited(c.questions.q0!.instructions))).toBe(false);
  });

  it('flags a pre-plan that contradicts project.md, with the pre-plan first so the cap cuts the docs', async () => {
    const d = fakeDecider((state) => answer(state.includes('relógio do banco') ? 0.9 : 0.1));
    const preplan = { modules: [{ name: 'agenda', purpose: 'agenda' }], tasks: [{ id: 'P1', title: 'Usar o relógio do banco', module: 'agenda', owner: 'dev' as const, criteriaRefs: ['AC-001'], dependsOn: [] }], risks: [] };
    const issues = await preplanFlags({ preplan, projectMd: '# Projeto\n\nO horário vem de uma porta de relógio.', stackMd: '# Stack' }, d as never, ctx);
    expect(issues).toEqual([expect.stringMatching(/^o Jev apontou que o pré-plano contradiz/)]);
    expect(d.calls.map((c) => c.id)).toEqual(['detail-check']);
    expect(d.calls[0]!.state.startsWith('pre-plan:')).toBe(true);
    expect(await preplanFlags({ preplan, projectMd: '', stackMd: '' }, fakeDecider(() => none) as never, ctx)).toEqual([]);
  });
});
