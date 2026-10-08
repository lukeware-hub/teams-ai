import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { docSections, flowIsMermaid, headingMatches, resolveHeading, sectionText } from '../../server/refine/sections.js';
import { NUMBERED_MERMAID_FLOW } from '../fixtures/numbered-mermaid-flow.js';

describe('flowIsMermaid (R11.11)', () => {
  it('accepts a flow with a mermaid code fence', () => {
    expect(flowIsMermaid('# Flow\n\n```mermaid\nflowchart TD\n  A --> B\n```\n')).toBe(true);
  });
  it('rejects a flow written only in markdown headings, with no diagram', () => {
    expect(flowIsMermaid('# Flow\n\n## 1. Checkout\n\nUser pays.\n')).toBe(false);
  });
  it('is case-insensitive and tolerates leading indentation on the fence', () => {
    expect(flowIsMermaid('# Flow\n\n  ```MERMAID\nflowchart TD\n```\n')).toBe(true);
  });
});

describe('docSections', () => {
  it('cuts numbered mermaid sections at the next numbered comment or the closing fence', () => {
    const sections = docSections(NUMBERED_MERMAID_FLOW);
    expect(sections.map((s) => s.heading)).toEqual(['Fluxo', '0. GOVERNANÇA DA PLATAFORMA', '1. Caso', '7. OPME', '11. Caso clínico', 'Regras gerais', 'Detalhe', 'Glossário']);
    const opme = sections.find((s) => s.heading === '7. OPME')!;
    expect(opme.text).toBe('%% 7. OPME\n  O0[Pedido de OPME] --> O1[Cotação]');
    expect(sections.find((s) => s.heading === '11. Caso clínico')!.text).toBe('%% 11. Caso clínico\n  K0[Prontuário] --> K1[Alta]');
  });

  it('runs a markdown section to the next heading of the same or a higher level', () => {
    const rules = docSections(NUMBERED_MERMAID_FLOW).find((s) => s.heading === 'Regras gerais')!;
    expect(rules.text).toBe('## Regras gerais\n\nTudo auditado.\n\n### Detalhe\n\nLogs por 5 anos.\n');
  });
});

describe('sectionText', () => {
  it('prefers the exact heading over one that merely contains it', () => {
    expect(sectionText(NUMBERED_MERMAID_FLOW, '1. Caso')).toBe('%% 1. Caso\n  C0[Abrir caso] --> C1[Triagem]');
    expect(sectionText(NUMBERED_MERMAID_FLOW, 'opme')).toContain('Pedido de OPME');
    expect(sectionText(NUMBERED_MERMAID_FLOW, 'Governanca da plataforma')).toContain('Planos');
    expect(sectionText(NUMBERED_MERMAID_FLOW, 'Faturamento')).toBeNull();
  });

  it('matches headings leniently, ignoring case, accents, numbering punctuation and too-short names', () => {
    expect(headingMatches('7 opme', '7. OPME')).toBe(true);
    expect(headingMatches('Governança', '0. GOVERNANCA DA PLATAFORMA')).toBe(true);
    expect(headingMatches('7.', '7. OPME')).toBe(false);
    expect(headingMatches('Faturamento', '7. OPME')).toBe(false);
  });

  it('never matches a different section number, nor part of a word', () => {
    expect(headingMatches('1. Caso', '11. Caso clínico')).toBe(false);
    expect(headingMatches('11. Caso', '1. Caso')).toBe(false);
    expect(headingMatches('Caso', 'Fluxo de casos')).toBe(false);
    expect(headingMatches('Caso', '11. Caso clínico')).toBe(true);
    expect(headingMatches('7. OPME e materiais', '7. OPME')).toBe(true);
  });

  it('resolves a citation to its own section: same number, then the same words, then the smallest match', () => {
    expect(sectionText(NUMBERED_MERMAID_FLOW, '11. Caso')).toBe('%% 11. Caso clínico\n  K0[Prontuário] --> K1[Alta]');
    expect(sectionText(NUMBERED_MERMAID_FLOW, 'Caso')).toBe('%% 1. Caso\n  C0[Abrir caso] --> C1[Triagem]');
    expect(sectionText(`## Caso clínico geral\n\n${'texto '.repeat(50)}\n\n${NUMBERED_MERMAID_FLOW}`, 'Clínico')).toBe('%% 11. Caso clínico\n  K0[Prontuário] --> K1[Alta]');
  });

  it('lets an unnumbered citation only abbreviate a numbered heading, never stand for a smaller one', () => {
    expect(headingMatches('Caso clínico', '1. Caso')).toBe(false);
    expect(headingMatches('Pagamento do caso', '3. Pagamento')).toBe(false);
    expect(headingMatches('Faturamento de OPME', '7. OPME')).toBe(false);
    expect(headingMatches('OPME', '7. OPME')).toBe(true);
    expect(headingMatches('Governança', '0. GOVERNANÇA DA PLATAFORMA')).toBe(true);
    expect(sectionText(NUMBERED_MERMAID_FLOW, 'Caso clínico — alta')).toBeNull();
  });

  it('resolves a citation to one heading: exact, then the same words, then the most words in common', () => {
    const headings = ['1. Caso', 'Pagamento do caso', '3. Pagamento', '11. Caso clínico'];
    expect(resolveHeading('Pagamento do caso', headings)).toBe('Pagamento do caso');
    expect(resolveHeading('Caso clínico', headings)).toBe('11. Caso clínico');
    expect(resolveHeading('Caso', headings)).toBe('1. Caso');
    expect(resolveHeading('Pagamento', headings)).toBe('3. Pagamento');
    expect(resolveHeading('Faturamento', headings)).toBeNull();
  });

  it('loads in the browser: no node: imports', async () => {
    expect(await fs.readFile('server/refine/sections.ts', 'utf8')).not.toMatch(/from 'node:/);
  });
});
