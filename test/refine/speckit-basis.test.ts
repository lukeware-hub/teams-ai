import { describe, expect, it } from 'vitest';
import { stepBasis, type BasisQuestion } from '../../server/refine/speckit-basis.js';
import type { SpeckitInput } from '../../server/refine/speckit-pack.js';
import type { Step } from '../../server/refine/speckit-steps.js';

const SPECS = ['## login: Entrar', '', '- Escopo: entrar', '', '## cart: Carrinho', '', '- Escopo: comprar', ''].join('\n');
const BRIEFING = '# Briefing\n\nRegra geral.\n\n## Decisões\n\n### Prazo\n\n> 15 dias\n';
const TEXTS: Record<SpeckitInput, string> = { 'project.md': '# Projeto', 'flow.md': '# Fluxo', 'briefing.md': BRIEFING, 'stack.md': '# Stack', 'design.md': '# Design', 'specs.md': SPECS };
const login = { key: 'login', specId: 'login', title: 'Entrar' };
const cart = { key: 'cart', specId: 'cart', title: 'Carrinho' };
const step = (command: Step['command'], item?: typeof login): Step => ({ command, ...(item ? { item } : {}) });
const ALL: Step[] = [step('constitution'), step('specify', login), step('clarify', login), step('plan', login), step('tasks', login), step('specify', cart), step('clarify', cart), step('plan', cart), step('tasks', cart)];
const asked = (command: NonNullable<BasisQuestion['command']>, itemKey: string | undefined, answer: string | null = null): BasisQuestion => ({
  questionId: `speckit-${command}-${itemKey ?? 'none'}`,
  status: answer === null ? 'pending' : 'answered',
  answer,
  answeredBy: answer === null ? null : 'po',
  origin: 'speckit',
  itemKey,
  command,
});
/** The basis of every step of the plan, keyed by its position, for the questions given. */
const bases = (questions: BasisQuestion[], texts = TEXTS): string[] => ALL.map((s) => stepBasis(s, texts, questions));
const changed = (before: string[], after: string[]): number[] => after.flatMap((b, i) => (b === before[i] ? [] : [i]));
/** Positions in ALL: 0 constitution; 1-4 login specify, clarify, plan, tasks; 5-8 cart. */
const LOGIN_PLAN_AND_TASKS = [3, 4];

describe('stepBasis', () => {
  it('gives the same basis for the same documents and answers', () => {
    expect(bases([asked('plan', 'login')])).toEqual(bases([asked('plan', 'login')]));
  });

  it('an answer to a plan question changes the plan and the tasks of its item, and nothing else', () => {
    expect(changed(bases([asked('plan', 'login')]), bases([asked('plan', 'login', '20 dias')]))).toEqual(LOGIN_PLAN_AND_TASKS);
  });

  it('an answer to a specify question changes the clarify, plan and tasks of its item, but not its own specify', () => {
    expect(changed(bases([asked('specify', 'login')]), bases([asked('specify', 'login', '20 dias')]))).toEqual([2, 3, 4]);
  });

  it('a constitution question changes the constitution and every item step', () => {
    expect(changed(bases([asked('constitution', undefined)]), bases([asked('constitution', undefined, 'Português')]))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('a refinement question changes every step', () => {
    const refine = (answer: string | null): BasisQuestion => ({ questionId: 'q-refine', status: answer === null ? 'pending' : 'answered', answer, answeredBy: 'owner', origin: undefined });
    expect(changed(bases([refine(null)]), bases([refine('sim')]))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("another item's section changes only that item's steps", () => {
    const edited = { ...TEXTS, 'specs.md': SPECS.replace('- Escopo: comprar', '- Escopo: comprar e pagar') };
    expect(changed(bases([], TEXTS), bases([], edited))).toEqual([5, 6, 7, 8]);
  });

  it('a decision written in the briefing changes every step, the constitution included', () => {
    const edited = { ...TEXTS, 'briefing.md': BRIEFING.replace('> 15 dias', '> 30 dias') };
    expect(changed(bases([]), bases([], edited))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('a decision recorded in a briefing that had none changes every step, while blank lines alone change none', () => {
    const plain = { ...TEXTS, 'briefing.md': '# Briefing\n\nRegra geral.\n' };
    const recorded = { ...TEXTS, 'briefing.md': '# Briefing\n\nRegra geral.\n\n## Decisões\n\n### Prazo\n\n> 15 dias\n' };
    const spaced = { ...TEXTS, 'briefing.md': '# Briefing\n\n\nRegra geral.\n\n\n' };
    expect(changed(bases([], plain), bases([], recorded))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(changed(bases([], plain), bases([], spaced))).toEqual([]);
  });

  it('a change to the briefing outside its decisions changes every item step', () => {
    const edited = { ...TEXTS, 'briefing.md': BRIEFING.replace('Regra geral.', 'Regra nova.') };
    expect(changed(bases([]), bases([], edited))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('a step has its own basis: the constitution does not depend on the item sections', () => {
    const edited = { ...TEXTS, 'specs.md': SPECS.replace('Entrar', 'Entrar com senha') };
    expect(stepBasis(step('constitution'), edited, [])).toBe(stepBasis(step('constitution'), TEXTS, []));
  });
});

describe('stepBasis of a refinement question', () => {
  it('reads the answer, not only that the question exists', () => {
    expect(stepBasis(step('plan', login), TEXTS, [asked('plan', 'login')])).not.toBe(stepBasis(step('plan', login), TEXTS, [asked('plan', 'login', 'x')]));
  });
});
