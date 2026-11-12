import { describe, expect, it } from 'vitest';
import { sha256 } from '../../server/contracts/hash.js';
import { planBasis } from '../../server/refine/plan-prepare.js';

const BRIEF = '# Briefing\n\nO usuário entra com e-mail.\n';
const REQUEST = '## Pedido pedido-1\n\nExportar o relatório em PDF.\n';
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

describe('planBasis of an item that cites sections', () => {
  const STACK = '# Stack\n\n## Ambiente local\n\nUso diário com 34 serviços.\n\n## Banco\n\nPostgres 16.\n';
  const withStack = (stack: string) => ({ ...(docs(BRIEF) as object), 'stack.md': stack }) as never;
  const source = (sources: Array<{ doc: string; heading: string }>) => ({ backlog: { items: [{ key: 'login', sources }] } }) as never;

  it('is unchanged when another section of a cited document changes', () => {
    const cites = source([{ doc: 'stack.md', heading: 'Banco' }]);
    expect(planBasis(withStack(STACK.replace('34', '39')), 'login', cites)).toBe(planBasis(withStack(STACK), 'login', cites));
  });

  it('changes when a cited section changes', () => {
    const cites = source([{ doc: 'stack.md', heading: 'Ambiente local' }]);
    expect(planBasis(withStack(STACK.replace('34', '39')), 'login', cites)).not.toBe(planBasis(withStack(STACK), 'login', cites));
  });

  it('takes a heading it cannot find as its whole document, so no change goes unseen', () => {
    const cites = source([{ doc: 'docs/stack.md', heading: 'Seção que não existe' }]);
    expect(planBasis(withStack(STACK.replace('34', '39')), 'login', cites)).not.toBe(planBasis(withStack(STACK), 'login', cites));
  });

  it('reads all five documents when the item cites a file that is not one of them', () => {
    const cites = source([{ doc: 'notes.md', heading: 'Qualquer' }]);
    expect(planBasis(docs(BRIEF), 'login', cites)).toBe(planBasis(docs(BRIEF), 'login'));
  });
});
