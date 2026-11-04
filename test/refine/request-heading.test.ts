import { describe, expect, it } from 'vitest';
import { buildWithDocs } from '../../server/refine/docs-view.js';
import { isRequestHeading } from '../../server/refine/sections.js';

describe('the heading of a follow-on request', () => {
  it('is recognised only when it reads "Pedido pedido-<n>"', () => {
    expect(isRequestHeading('Pedido pedido-1')).toBe(true);
    expect(isRequestHeading('Pedido pedido-12')).toBe(true);
    expect(isRequestHeading('Nova demanda (hello-001)')).toBe(false);
    expect(isRequestHeading('Pedido login')).toBe(false);
  });

  it('stays whole in every digested pack, even when the rest of the briefing is cut', () => {
    const brief = `# Briefing\n\n## Objetivos\n\n${'Vender mais. '.repeat(600)}\n\n## Pedido pedido-1\n\nExportar em PDF com o logotipo da empresa.\n`;
    const out = buildWithDocs({ brief }, (d) => d.brief ?? '', 400);
    expect(out).toContain('Exportar em PDF com o logotipo da empresa.');
  });
});
