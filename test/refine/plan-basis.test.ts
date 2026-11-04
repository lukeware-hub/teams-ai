import { describe, expect, it } from 'vitest';
import { sha256 } from '../../server/contracts/hash.js';
import { planBasis } from '../../server/refine/plan-prepare.js';

const BRIEF = '# Briefing\n\nO usuário entra com e-mail.\n';
const REQUEST = '## Nova demanda (shop-pedido-1)\n\nExportar o relatório em PDF.\n';
const docs = (briefing: string) => ({ 'project.md': 'P', 'flow.md': 'F', 'briefing.md': briefing, 'stack.md': 'S', 'design.md': 'D', 'specs.md': '' }) as never;

describe('planBasis', () => {
  it('keeps the basis a briefing without requests always had, so no plan is made again', () => {
    expect(planBasis(docs(BRIEF), 'login')).toBe(sha256(['', 'P', 'F', BRIEF, 'S', 'D'].join('\n')));
  });

  it('is unchanged when a follow-on request is added, because the request section is not a plan input', () => {
    expect(planBasis(docs(`${BRIEF}\n${REQUEST}`), 'login')).toBe(planBasis(docs(BRIEF), 'login'));
  });

  it('changes when the briefing changes outside the request section', () => {
    expect(planBasis(docs(BRIEF.replace('e-mail', 'telefone')), 'login')).not.toBe(planBasis(docs(BRIEF), 'login'));
  });
});
