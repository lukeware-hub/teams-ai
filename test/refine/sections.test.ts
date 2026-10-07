import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { docSections, headingMatches, sectionText } from '../../server/refine/sections.js';
import { KAYRON_FLOW } from '../fixtures/kayron-flow.js';

describe('docSections', () => {
  it('cuts numbered mermaid sections at the next numbered comment or the closing fence', () => {
    const sections = docSections(KAYRON_FLOW);
    expect(sections.map((s) => s.heading)).toEqual(['Fluxo', '0. GOVERNANÇA DA PLATAFORMA', '1. Caso', '7. OPME', '11. Caso clínico', 'Regras gerais', 'Detalhe', 'Glossário']);
    const opme = sections.find((s) => s.heading === '7. OPME')!;
    expect(opme.text).toBe('%% 7. OPME\n  O0[Pedido de OPME] --> O1[Cotação]');
    expect(sections.find((s) => s.heading === '11. Caso clínico')!.text).toBe('%% 11. Caso clínico\n  K0[Prontuário] --> K1[Alta]');
  });

  it('runs a markdown section to the next heading of the same or a higher level', () => {
    const rules = docSections(KAYRON_FLOW).find((s) => s.heading === 'Regras gerais')!;
    expect(rules.text).toBe('## Regras gerais\n\nTudo auditado.\n\n### Detalhe\n\nLogs por 5 anos.\n');
  });
});

describe('sectionText', () => {
  it('prefers the exact heading over one that merely contains it', () => {
    expect(sectionText(KAYRON_FLOW, '1. Caso')).toBe('%% 1. Caso\n  C0[Abrir caso] --> C1[Triagem]');
    expect(sectionText(KAYRON_FLOW, 'opme')).toContain('Pedido de OPME');
    expect(sectionText(KAYRON_FLOW, 'Governanca da plataforma')).toContain('Planos');
    expect(sectionText(KAYRON_FLOW, 'Faturamento')).toBeNull();
  });

  it('matches headings leniently, ignoring case, accents, numbering punctuation and too-short names', () => {
    expect(headingMatches('7 opme', '7. OPME')).toBe(true);
    expect(headingMatches('Governança', '0. GOVERNANCA DA PLATAFORMA')).toBe(true);
    expect(headingMatches('7.', '7. OPME')).toBe(false);
    expect(headingMatches('Faturamento', '7. OPME')).toBe(false);
  });

  it('loads in the browser: no node: imports', async () => {
    expect(await fs.readFile('server/refine/sections.ts', 'utf8')).not.toMatch(/from 'node:/);
  });
});
