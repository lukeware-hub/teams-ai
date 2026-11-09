import { describe, expect, it } from 'vitest';
import { MAX_STATE_CHARS } from '../../server/decide/decider.js';
import { needsSharedState, preplanFlags, specFlags } from '../../server/decide/decisions/detail-check.js';
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
const spec = (objectives = ['Registrar empréstimos'], outOfScope: string[] = []) => ({
  objectives, features: ['empréstimo'], outOfScope,
  acceptanceCriteria: [ac('AC-001', 'um livro criado pelo teste'), ac('AC-002', 'o banco vazio', 'a lista tem 0 itens')],
});
const preplan = { modules: [{ name: 'agenda', purpose: 'agenda' }], tasks: [{ id: 'P1', title: 'Criar o pacote agenda no monólito', module: 'agenda', owner: 'dev' as const, criteriaRefs: ['AC-001'], dependsOn: [] }], risks: [] };

describe('specFlags', () => {
  it('asks the Jev one objective at a time and names only the objectives it flags', async () => {
    const d = fakeDecider((state) => (state.includes('spec objective: Cobrar multa') ? 0.9 : 0.1));
    const issues = await specFlags({ item, sections, spec: spec(['Registrar empréstimos', 'Cobrar multa por atraso']) }, d as never, ctx);
    expect(d.calls.map((c) => c.id)).toEqual(['spec-cited-sections', 'spec-cited-sections']);
    // Each question carries the item, its cited sections and one objective, never the other one.
    expect(d.calls[0]!.state).toContain('O bibliotecário registra o empréstimo');
    expect(d.calls[0]!.state).not.toContain('Cobrar multa');
    expect(issues[0]).toMatch(/^o Jev \(uma checagem automática que pode errar\) apontou que esta tentativa da spec acrescenta/);
    expect(issues[0]).toContain('"Cobrar multa por atraso"');
    expect(issues[0]).not.toContain('Registrar empréstimos');
  });

  it('flags a criterion that needs the whole database empty by rule, with no question to the Jev', async () => {
    const d = fakeDecider(() => 0.1);
    const issues = await specFlags({ item, sections, spec: spec() }, d as never, ctx);
    expect(d.calls.every((c) => c.id === 'spec-cited-sections')).toBe(true);
    expect(issues).toEqual([expect.stringContaining('"Dado o banco vazio, quando o teste cadastra, então a lista tem 0 itens"')]);
    expect(issues[0]).toMatch(/^uma regra automática apontou que o critério/);
    expect(issues[0]).toContain('mantenha-o se as seções citadas fixam essa data');
  });

  it('flags no objective when the Jev does not answer or finds nothing, and never shows it the out-of-scope list', async () => {
    const clean = { ...spec(), acceptanceCriteria: [ac('AC-001', 'um livro criado pelo teste')] };
    expect(await specFlags({ item, sections, spec: clean }, fakeDecider(() => null) as never, ctx)).toEqual([]);
    expect(await specFlags({ item, sections, spec: clean }, fakeDecider(() => 0.2) as never, ctx)).toEqual([]);
    const d = fakeDecider((state) => (state.includes('multa') ? 0.9 : 0.1));
    expect(await specFlags({ item, sections, spec: { ...spec(['Registrar empréstimos'], ['multa por atraso']), acceptanceCriteria: clean.acceptanceCriteria } }, d as never, ctx)).toEqual([]);
  });

  it('asks no objective question when its state would be cut, and still checks each criterion by rule', async () => {
    const d = fakeDecider(() => 0.9);
    const long = [{ heading: 'briefing.md › Decisões', text: 'x'.repeat(MAX_STATE_CHARS) }];
    expect(await specFlags({ item, sections: long, spec: spec() }, d as never, ctx)).toHaveLength(1);
    expect(d.calls).toEqual([]);
  });
});

describe('needsSharedState', () => {
  const needs = (given: string, then = 'a resposta é 201') => needsSharedState(ac('AC-001', given, then));

  it('flags a criterion that needs the whole database empty, a count of every record, a fixed date or the real clock', () => {
    expect(needs('o banco de dados vazio')).toBe(true);
    expect(needs('um caso criado pelo teste', 'a tabela contém exatamente 3 registros')).toBe(true);
    expect(needs('uma cirurgia marcada para 10/12/2026')).toBe(true);
    expect(needs('uma cobrança vencida em 2026-12-10')).toBe(true);
    expect(needs('um prazo contado a partir da data atual')).toBe(true);
  });

  it('keeps a criterion on data its test creates, on a new database, or that says it does not depend on that state', () => {
    expect(needs('um livro criado pelo teste', 'a lista do teste tem 0 itens')).toBe(false);
    expect(needs('a suíte de isolamento contra um banco novo e vazio')).toBe(false);
    expect(needs('a suíte já rodou antes', 'passa sem depender de banco vazio')).toBe(false);
  });
});

describe('preplanFlags', () => {
  it('flags a pre-plan against the decisions, naming its modules and tasks, with the pre-plan first', async () => {
    const d = fakeDecider((state) => (state.includes('monólito') && state.includes('multirepo') ? 0.95 : 0.1));
    const issues = await preplanFlags({ preplan, decisions: '# Decisões\n\nVale o multirepo, um repositório por serviço.' }, d as never, ctx);
    expect(issues).toEqual([expect.stringMatching(/^o Jev \(uma checagem automática que pode errar\) apontou que esta tentativa do pré-plano contradiz/)]);
    expect(issues[0]).toContain('P1 Criar o pacote agenda no monólito');
    expect(d.calls.map((c) => c.id)).toEqual(['preplan-tech-decisions']);
    expect(d.calls[0]!.state.startsWith('pre-plan:')).toBe(true);
    expect(await preplanFlags({ preplan, decisions: 'Vale o multirepo.' }, fakeDecider(() => null) as never, ctx)).toEqual([]);
  });

  it('asks nothing when there is no decision to compare with', async () => {
    const d = fakeDecider(() => 0.9);
    expect(await preplanFlags({ preplan, decisions: '  ' }, d as never, ctx)).toEqual([]);
    expect(d.calls).toEqual([]);
  });

  it('reads long decisions whole, in windows that each carry the pre-plan, and flags when any window flags', async () => {
    const decisions = [...Array.from({ length: 3_000 }, (_, n) => `Decisão ${n}: o serviço segue a regra técnica ${n}.`), 'Vale o multirepo.'].join('\n');
    const d = fakeDecider((state) => (state.includes('Vale o multirepo.') ? 0.9 : 0.1));
    const issues = await preplanFlags({ preplan, decisions }, d as never, ctx);
    expect(d.calls.length).toBeGreaterThan(1);
    expect(d.calls.every((c) => c.state.length <= MAX_STATE_CHARS && c.state.startsWith('pre-plan:'))).toBe(true);
    const seen = d.calls.map((c) => c.state).join('\n');
    expect(decisions.split('\n').every((line) => seen.includes(line))).toBe(true);
    expect(issues).toHaveLength(1);
  });
});
