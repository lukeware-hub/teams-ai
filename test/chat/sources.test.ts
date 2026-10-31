import { describe, expect, it } from 'vitest';
import { withSources } from '../../server/chat/sources.js';

const found = [
  { title: 'Guia do Go', url: 'https://go.example/guide' },
  { title: 'Issue sobre o toolchain', url: 'https://gh.example/issue/1' },
];

describe('withSources', () => {
  it('leaves the answer as it is when no search ran', () => {
    expect(withSources('Resposta simples.', [])).toBe('Resposta simples.');
  });

  it('lists the sources of the search once each, as links the reader can open', () => {
    const out = withSources('Resposta.', [found[0]!, found[0]!]);
    expect(out).toContain('Fontes da pesquisa:');
    expect(out.match(/go\.example/g)).toHaveLength(1);
    expect(out).toContain('[Guia do Go](https://go.example/guide)');
  });

  it('removes every address the search did not return, from the answer and from the sources', () => {
    const out = withSources('Veja [o site](https://invented.example/x) e https://other.example/y para mais.', found);
    expect(out).not.toContain('invented.example');
    expect(out).not.toContain('other.example');
    expect(out).toContain('o site');
  });

  it('lists at most five sources, with brackets and parentheses taken out of the titles', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ title: `Fonte (${i})`, url: `https://ex.example/${i}` }));
    const out = withSources('Resposta.', many);
    expect(out.match(/^- \[/gm)).toHaveLength(5);
    expect(out).not.toMatch(/\[Fonte \(/);
  });

  it('keeps only secure addresses', () => {
    const out = withSources('Resposta.', [{ title: 'Simples', url: 'http://insecure.example' }]);
    expect(out).not.toContain('insecure.example');
  });
});
