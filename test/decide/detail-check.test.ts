import { describe, expect, it } from 'vitest';
import { MAX_STATE_CHARS } from '../../server/decide/decider.js';
import { preplanFlags, specFlags } from '../../server/decide/decisions/detail-check.js';
import type { DecisionOutcome, NoulAnswer } from '../../server/decide/types.js';

const ac = (id: string, given: string, then = 'a resposta é 201') => ({ id, given, when: 'o teste cadastra', then, smoke: false });
const noul = (value: number): NoulAnswer => ({ type: 'noul', value, probabilities: { yes: value, no: 1 - value }, confidence: Math.max(value, 1 - value) });
type Call = { id: string; state: string };
/** Answers each call's single question from its state and its key (null leaves it unanswered), and records every call. */
function fakeDecider(by: (state: string, id: string) => number | null) {
  const calls: Call[] = [];
  const decide = async (id: string, state: string, questions: Record<string, unknown>): Promise<DecisionOutcome> => {
    const key = Object.keys(questions).join();
    calls.push({ id, state });
    const value = by(state, id);
    return value === null ? { answered: false, reason: 'disabled' } : { answered: true, backend: 'jev', escalated: false, answers: { [key]: noul(value) } };
  };
  return { calls, decide };
}
const ctx = { confidential: false };
const item = { key: 'emprestimo', title: 'Empréstimo', scope: 'Registrar empréstimos' };
const sections = [{ heading: 'flow.md › 2. Empréstimo', text: '## 2. Empréstimo\n\nO bibliotecário registra o empréstimo de um livro.' }];
const spec = (features = ['empréstimo'], outOfScope: string[] = []) => ({
  objectives: ['Registrar empréstimos'], features, outOfScope,
  acceptanceCriteria: [ac('AC-001', 'um livro criado pelo teste'), ac('AC-002', 'o banco vazio', 'a lista tem 0 itens')],
});

describe('detail-check', () => {
  it('flags a spec outside its cited sections and each criterion that needs what its test cannot control', async () => {
    const d = fakeDecider((state, id) => (id === 'spec-cited-sections' ? (state.includes('multa') ? 0.9 : 0.1) : state.includes('banco vazio') ? 0.85 : 0.05));
    const issues = await specFlags({ item, sections, spec: spec(['empréstimo', 'multa por atraso']) }, d as never, ctx);
    expect(issues).toHaveLength(2);
    // The flag names the attempt the Jev judged, says it can be wrong, and keeps what the sections ask for.
    expect(issues[0]).toMatch(/^o Jev \(uma checagem automática que pode errar\) apontou que esta tentativa da spec acrescenta/);
    expect(issues[0]).toContain('empréstimo; multa por atraso');
    expect(issues[0]).toContain('mantenha tudo o que vem do item ou das seções citadas');
    expect(issues[1]).toContain('"Dado o banco vazio, quando o teste cadastra, então a lista tem 0 itens"');
    expect(issues[1]).toContain('mantenha-o se as seções citadas fixam essa data');
    // One question per call, each check its own decision, so one unsure answer never silences another and each is switched on alone.
    expect(d.calls.map((c) => c.id)).toEqual(['spec-cited-sections', 'criterion-shared-deploy', 'criterion-shared-deploy']);
    expect(d.calls[1]!.state).toContain('um livro criado pelo teste');
    expect(d.calls[1]!.state).not.toContain('banco vazio');
  });

  it('flags nothing when the Jev does not answer or finds nothing, and never shows it the out-of-scope list', async () => {
    expect(await specFlags({ item, sections, spec: spec() }, fakeDecider(() => null) as never, ctx)).toEqual([]);
    expect(await specFlags({ item, sections, spec: spec() }, fakeDecider(() => 0.2) as never, ctx)).toEqual([]);
    // What the spec leaves out is not something it adds.
    const d = fakeDecider((state) => (state.includes('multa') ? 0.9 : 0.1));
    expect(await specFlags({ item, sections, spec: spec(['empréstimo'], ['multa por atraso']) }, d as never, ctx)).toEqual([]);
  });

  it('asks no cited-sections question when the spec state would be cut, and still asks each criterion', async () => {
    const d = fakeDecider(() => 0.9);
    const long = [{ heading: 'briefing.md › Decisões', text: 'x'.repeat(MAX_STATE_CHARS) }];
    expect(await specFlags({ item, sections: long, spec: spec() }, d as never, ctx)).toHaveLength(2);
    expect(d.calls.map((c) => c.id)).toEqual(['criterion-shared-deploy', 'criterion-shared-deploy']);
  });

  it('flags a pre-plan that contradicts the docs, naming its modules and tasks, with the docs last and stack.md first', async () => {
    const d = fakeDecider((state) => (state.includes('relógio do banco') ? 0.9 : 0.1));
    const preplan = { modules: [{ name: 'agenda', purpose: 'agenda' }], tasks: [{ id: 'P1', title: 'Usar o relógio do banco', module: 'agenda', owner: 'dev' as const, criteriaRefs: ['AC-001'], dependsOn: [] }], risks: [] };
    const issues = await preplanFlags({ preplan, projectMd: '# Projeto\n\nO horário vem de uma porta de relógio.', stackMd: '# Stack' }, d as never, ctx);
    expect(issues).toEqual([expect.stringMatching(/^o Jev \(uma checagem automática que pode errar\) apontou que esta tentativa do pré-plano contradiz/)]);
    expect(issues[0]).toContain('agenda');
    expect(issues[0]).toContain('P1 Usar o relógio do banco');
    expect(d.calls.map((c) => c.id)).toEqual(['preplan-tech-decisions']);
    // The pre-plan first and project.md last: a state cut at the cap loses the end of project.md only.
    const state = d.calls[0]!.state;
    expect(state.startsWith('pre-plan:')).toBe(true);
    expect(state.indexOf('### stack.md')).toBeLessThan(state.indexOf('### project.md'));
    expect(await preplanFlags({ preplan, projectMd: '', stackMd: '' }, fakeDecider(() => null) as never, ctx)).toEqual([]);
  });

  it('reads a long stack.md whole, in windows that each carry the pre-plan, and flags when any window flags', async () => {
    const preplan = { modules: [{ name: 'agenda', purpose: 'agenda' }], tasks: [{ id: 'P1', title: 'Usar o relógio do banco', module: 'agenda', owner: 'dev' as const, criteriaRefs: ['AC-001'], dependsOn: [] }], risks: [] };
    const stackMd = [...Array.from({ length: 3_000 }, (_, n) => `Decisão ${n}: o serviço segue a regra técnica ${n}.`), 'O horário vem do relógio do banco.'].join('\n');
    const d = fakeDecider((state) => (state.includes('O horário vem do relógio do banco') ? 0.9 : 0.1));
    const issues = await preplanFlags({ preplan, projectMd: '# Projeto\n\nTexto do projeto.', stackMd }, d as never, ctx);
    expect(d.calls.length).toBeGreaterThan(2);
    expect(d.calls.every((c) => c.id === 'preplan-tech-decisions' && c.state.length <= MAX_STATE_CHARS && c.state.startsWith('pre-plan:'))).toBe(true);
    // Every line of both docs reaches the Jev in some window.
    const seen = d.calls.map((c) => c.state).join('\n');
    expect(stackMd.split('\n').every((line) => seen.includes(line))).toBe(true);
    expect(seen).toContain('Texto do projeto.');
    expect(issues).toHaveLength(1);
    expect(await preplanFlags({ preplan, projectMd: '', stackMd }, fakeDecider(() => 0.1) as never, ctx)).toEqual([]);
  });
});
