import { describe, expect, it } from 'vitest';
import { applyPatch } from '../../server/refine/patches.js';
import { uniqueHeadingFixes } from '../../server/refine/heading-fixes.js';
import { docSections, normHeading } from '../../server/refine/sections.js';

const DESIGN = [
  '# Design',
  '',
  '## 11.1 `doctor-web`',
  '',
  '### Navegação',
  '',
  '```text',
  '# not a heading',
  'Painel',
  'Guias',
  '```',
  '',
  '### Padrão principal',
  '',
  'Cartões do médico.',
  '',
  '## 11.2 `hospital-web`',
  '',
  '### Navegação',
  '',
  '```text',
  'Painel',
  'Aprovações',
  '```',
  '',
  '### Padrão principal',
  '',
  'Cartões do hospital.',
  '',
  '## 12.1 Cabeçalho',
  '',
  'Único.',
  '',
].join('\n');

const apply = (doc: string) => uniqueHeadingFixes(doc).reduce((text, p) => applyPatch(text, p)!, doc);
const headings = (doc: string) => docSections(doc).map((s) => normHeading(s.heading));

describe('uniqueHeadingFixes', () => {
  it('proposes one patch per repeated heading and leaves every heading unique once applied', () => {
    const fixes = uniqueHeadingFixes(DESIGN);
    expect(fixes).toHaveLength(4);
    const after = apply(DESIGN);
    expect(after).toContain('### Navegação (11.2 `hospital-web`)');
    expect(after).toContain('### Padrão principal (11.1 `doctor-web`)');
    expect(new Set(headings(after)).size).toBe(headings(after).length);
  });

  it('changes only the heading line and keeps the text of every section, code blocks included', () => {
    const after = apply(DESIGN);
    expect(after).toContain('# not a heading\nPainel');
    expect(after.split('\n')).toHaveLength(DESIGN.split('\n').length);
    expect(after.replace(/ \([^)]*\)$/gm, '')).toBe(DESIGN);
  });

  it('proposes nothing when every heading is already unique, a code line starting with # not counting', () => {
    expect(uniqueHeadingFixes(apply(DESIGN))).toEqual([]);
    expect(uniqueHeadingFixes('# A\n\n```\n# A\n```\n\n## B\n')).toEqual([]);
  });

  it('skips a repeated section whose text is the same, since nothing anchors it', () => {
    expect(uniqueHeadingFixes('# T\n\n## B\n\n### X\n\num\n\n## C\n\n### X\n\ndois\n')).toHaveLength(2);
    expect(uniqueHeadingFixes('# T\n\n## B\n\n### X\n\nsame\n\n## C\n\n### X\n\nsame\n')).toEqual([]);
  });

  it('numbers a repeated heading that has no parent and never renames an approval section', () => {
    const fixes = uniqueHeadingFixes('## Regras\n\num\n\n## Regras\n\ndois\n');
    expect(fixes.map((f) => f.replace.split('\n')[0])).toEqual(['## Regras (2)', '## Regras (3)']);
    expect(uniqueHeadingFixes('## Ajuste aprovado: a-ajuste-1\n\num\n\n## Ajuste aprovado: a-ajuste-1\n\ndois\n')).toEqual([]);
  });
});
