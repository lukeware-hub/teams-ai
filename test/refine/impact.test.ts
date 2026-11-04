import { describe, expect, it } from 'vitest';
import { Impact, type Impact as ImpactType } from '../../server/contracts/impact.js';
import { impactPack, validateImpact } from '../../server/refine/impact.js';

const IMPACT: ImpactType = {
  requestId: 'pedido-1',
  summary: 'O pedido acrescenta a exportação; o login não muda.',
  affected: [{ kind: 'spec', ref: 'export', effect: 'nova spec', action: 'none' }],
  conflicts: [],
  duplicates: [],
  dependencies: [{ from: 'export', to: 'login', reason: 'exporta o relatório do login' }],
  risks: [],
};
const KNOWN = { known: new Set(['login', 'export']), kept: new Set(['login']) };

describe('the impact of a request', () => {
  it('reads a complete impact', () => {
    expect(Impact.safeParse(IMPACT).success).toBe(true);
    expect(Impact.safeParse({ ...IMPACT, affected: [{ kind: 'spec', ref: 'export', effect: 'x', action: 'delete' }] }).success).toBe(false);
  });

  it('accepts an impact whose references all exist and whose dependencies form no cycle', () => {
    expect(validateImpact(IMPACT, KNOWN)).toEqual([]);
  });

  it('refuses a reference to an item the backlog does not name', () => {
    const issues = validateImpact({ ...IMPACT, dependencies: [{ from: 'export', to: 'pagamento', reason: 'r' }] }, KNOWN);
    expect(issues).toEqual([expect.stringContaining('pagamento')]);
  });

  it('refuses a dependency cycle', () => {
    const issues = validateImpact({ ...IMPACT, dependencies: [{ from: 'export', to: 'login', reason: 'r' }, { from: 'login', to: 'export', reason: 'r' }] }, KNOWN);
    expect(issues).toEqual([expect.stringContaining('ciclo')]);
  });

  it('refuses to adjust a spec that already started, which only an approved adjustment changes', () => {
    const issues = validateImpact({ ...IMPACT, affected: [{ kind: 'spec', ref: 'login', effect: 'mudar', action: 'adjust' }] }, KNOWN);
    expect(issues).toEqual([expect.stringContaining('login')]);
  });

  it('packs the request verbatim with the outline and the started items marked', () => {
    const pack = impactPack({ requestId: 'pedido-1',
      specHash: 'h',
      principles: [],
      request: 'Exportar o relatório em PDF.',
      heading: 'Pedido pedido-1',
      docs: { 'briefing.md': '# Briefing\n\n## Pedido pedido-1\n\nExportar o relatório em PDF.\n' },
      items: [
        { key: 'login', title: 'Entrar', rank: 1, dependsOn: [], started: true, modules: ['auth'] },
        { key: 'export', title: 'Exportar', rank: 2, dependsOn: ['login'], started: false, modules: ['report'] },
      ],
    });
    expect(pack.feedback).toContain('Exportar o relatório em PDF.');
    expect(pack.feedback).toContain('login: Entrar (started)');
    expect(pack.feedback).toContain('export: Exportar');
  });
});
