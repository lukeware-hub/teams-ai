import { describe, expect, it } from 'vitest';
import { formatByTemplate } from '../../server/refine/template-layout.js';

const DECISION = '## Decisões\n\n### Porta\n\n> A API responde na porta 8080.\n';

describe('formatByTemplate', () => {
  it('moves each section under the template heading its title fills, and keeps the rest after them in order', () => {
    const doc = '# Loja\n\n## 1. Proposta de valor\n\nVender roupas online.\n\n## Índice\n\n- item\n\n## 2. Usuários e atores\n\n- Cliente: compra roupas.\n\n## Glossário\n\nTermo: valor.\n';
    const r = formatByTemplate('project.md', doc, 'shop');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain('## Vision\n\n#### 1. Proposta de valor\n\nVender roupas online.');
    expect(r.text).toContain('## Personas\n\n#### 2. Usuários e atores');
    expect(r.text).toContain('## Stack\n\n- (none)');
    expect(r.text.indexOf('## GitHub owner')).toBeLessThan(r.text.indexOf('## Índice'));
    expect(r.text.indexOf('## Índice')).toBeLessThan(r.text.indexOf('## Glossário'));
  });

  it('keeps a section of decisions word for word, after the template headings', () => {
    const r = formatByTemplate('project.md', `# Loja\n\n## Vision\n\nVender.\n\n${DECISION}`, 'shop');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain('## Decisões\n\n### Porta\n\n> A API responde na porta 8080.');
    expect(r.text.indexOf('## Decisões')).toBeGreaterThan(r.text.indexOf('## GitHub owner'));
  });

  it('gives the same text when it is laid out a second time', () => {
    const first = formatByTemplate('project.md', '# Loja\n\n## 1. Proposta de valor\n\nVender roupas online.\n\n## Glossário\n\nTermo.\n', 'shop');
    if (!first.ok) throw new Error(`first layout refused: ${first.reason}`);
    expect(formatByTemplate('project.md', first.text, 'shop')).toEqual({ ok: true, text: first.text });
  });

  it('refuses a document with no section headings', () => {
    expect(formatByTemplate('project.md', '# Loja\n\nSó um texto.\n', 'shop')).toEqual({ ok: false, reason: 'o documento não tem seções de nível 2' });
  });

  it('refuses a section that still holds a placeholder of the template', () => {
    const r = formatByTemplate('project.md', '# Loja\n\n## 2. Usuários\n\n- <name>: quem é.\n', 'shop');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/<name>/);
  });
});
