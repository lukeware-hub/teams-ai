import { describe, expect, it } from 'vitest';
import { demoteHeadings, stripControls } from '../../server/refine/draft.js';
import { withoutRequests } from '../../server/refine/sections.js';

describe('the text of a follow-on request', () => {
  it('drops control characters and keeps tabs and line breaks', () => {
    expect(stripControls('Exportar\u0000 o\u0007 relatório\tem\nPDF\u001b.')).toBe('Exportar o relatório\tem\nPDF.');
  });

  it('shifts its headings one level down, so they cannot collide with the briefing structure', () => {
    expect(demoteHeadings('# Título\n\n## Regra\n\ntexto')).toBe('## Título\n\n### Regra\n\ntexto');
  });

  it('leaves the "Pedido" section out of the plans basis, and keeps the rest of the briefing', () => {
    const doc = '# Briefing\n\n## Objetivos\n\nVender.\n\n## Pedido pedido-1\n\nExportar em PDF.\n';
    expect(withoutRequests(doc)).toContain('Vender.');
    expect(withoutRequests(doc)).not.toContain('Exportar em PDF.');
  });
});
