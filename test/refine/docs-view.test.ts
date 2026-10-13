import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../../server/knowledge/context-pack.js';
import { buildWithDocs, docDigest, viewDocs } from '../../server/refine/docs-view.js';
import { docSections } from '../../server/refine/sections.js';
import { NUMBERED_MERMAID_FLOW } from '../fixtures/numbered-mermaid-flow.js';

const doc = `Intro do documento.\n\n# Produto\n\n${'a'.repeat(400)}\n\n## Pedidos\n\n${'b'.repeat(400)}\n\n## Entregas\n\n${'c'.repeat(400)}`;

describe('docDigest', () => {
  it('keeps every heading as written and cuts each section at the given length', () => {
    const digest = docDigest(doc, 50);
    for (const heading of ['# Produto', '## Pedidos', '## Entregas']) expect(digest).toContain(heading);
    expect(digest).toContain('Intro do documento.');
    expect(digest).toContain(`${'a'.repeat(50)} […]`);
    expect(digest).not.toContain('a'.repeat(51));
  });

  it('keeps headings alone at zero, and short sections whole', () => {
    expect(docDigest(doc, 0)).toBe('# Produto\n\n## Pedidos\n\n## Entregas');
    expect(docDigest('# A\n\ncurto', 100)).toBe('# A\ncurto');
  });

  it('keeps every numbered section of a mermaid flow, so a citation of it still resolves', () => {
    const headings = docSections(NUMBERED_MERMAID_FLOW).map((s) => s.heading);
    const digest = docDigest(NUMBERED_MERMAID_FLOW, 0);
    expect(headings.length).toBeGreaterThan(1);
    for (const h of headings) expect(digest).toContain(h);
  });
});

describe('viewDocs', () => {
  const docs = { a: doc, b: doc };
  it('returns the docs untouched while they fit', () => {
    expect(viewDocs(docs, 100_000)).toEqual({ docs, digested: false });
  });

  it('takes the longest digest that fits, down to headings alone', () => {
    const tokens = (d: Record<string, string | undefined>) => Object.values(d).reduce((n, t) => n + estimateTokens(t ?? ''), 0);
    const mid = viewDocs(docs, Math.round(tokens(docs) * 0.6));
    expect(mid.digested).toBe(true);
    expect(tokens(mid.docs)).toBeLessThanOrEqual(Math.round(tokens(docs) * 0.6));
    expect(tokens(mid.docs)).toBeGreaterThan(tokens(viewDocs(docs, 1).docs));
    expect(viewDocs(docs, 1).docs.a).toBe(docDigest(doc, 0));
  });

  it('leaves a missing doc missing', () => {
    expect(viewDocs({ a: doc, b: undefined }, 1).docs.b).toBeUndefined();
  });
});

describe('buildWithDocs', () => {
  const build = (d: Record<string, string | undefined>, digested: boolean) => [digested ? 'DIGEST' : 'WHOLE', 'rest', d.a].join('\n');
  const big = { a: `# T\n\n${'x'.repeat(400_000)}` };

  it('writes the docs whole when they fit under the cap', () => {
    expect(buildWithDocs({ a: '# T\n\ntexto' }, build)).toBe('WHOLE\nrest\n# T\n\ntexto');
  });

  it('writes a digest that leaves the cap to the rest of the feedback when they do not', () => {
    const out = buildWithDocs(big, build, 60_000);
    expect(out.startsWith('DIGEST')).toBe(true);
    expect(estimateTokens(out)).toBeLessThanOrEqual(60_000);
  });
});
