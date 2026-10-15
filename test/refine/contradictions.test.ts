import { describe, expect, it } from 'vitest';
import { verifyContradictions, type DocTexts } from '../../server/refine/contradictions.js';

const docs: DocTexts = {
  'brief.md': '# Briefing\n\n## Decisões\n\n### Porta\n\nA API responde na porta 8080 em todo ambiente.\n',
  'flow.md': '# Fluxo\n\n## 1. Entrada\n\nO cliente chama a API pela porta 18080.\n\n## 2. Saída\n\nO relatório fica pronto.\n',
  'stack.md': '# Stack\n\n- Porta de publicação: 3000.\n',
};

const pair = (fact: string, a: { file: string; quote: string }, b: { file: string; quote: string }) => ({ fact, a, b, fix: 'Alinhe a porta nos dois documentos.' });

describe('verifyContradictions', () => {
  it('verifies a contradiction whose two quotes both appear, locating each side to its section', () => {
    const { verified, dropped } = verifyContradictions(docs, [
      pair('porta da API', { file: 'briefing.md', quote: 'A API responde na porta 8080' }, { file: 'flow.md', quote: 'chama a API pela porta 18080' }),
    ]);
    expect(dropped).toEqual([]);
    expect(verified).toHaveLength(1);
    expect(verified[0]).toMatchObject({
      fact: 'porta da API',
      a: { file: 'brief.md', quote: 'A API responde na porta 8080' },
      b: { file: 'flow.md', quote: 'chama a API pela porta 18080' },
      fix: 'Alinhe a porta nos dois documentos.',
    });
    expect(verified[0]!.a.heading).toMatch(/Porta/);
    expect(verified[0]!.b.heading).toMatch(/Entrada/);
  });

  it('matches through markdown marks, accents and curly quotes', () => {
    const { verified } = verifyContradictions(docs, [
      pair('publicação', { file: 'stack.md', quote: '**Porta de publicação**: 3000' }, { file: 'brief.md', quote: '“A API responde na porta 8080”' }),
    ]);
    expect(verified).toHaveLength(1);
  });

  it('drops a quote that is paraphrased, not copied', () => {
    const { verified, dropped } = verifyContradictions(docs, [
      pair('porta', { file: 'brief.md', quote: 'a API responde na porta oito mil' }, { file: 'flow.md', quote: 'chama a API pela porta 18080' }),
    ]);
    expect(verified).toEqual([]);
    expect(dropped).toHaveLength(1);
  });

  it('drops a quote that is a single word, because one word matches anywhere', () => {
    const { verified } = verifyContradictions(docs, [
      pair('porta', { file: 'brief.md', quote: 'porta' }, { file: 'flow.md', quote: 'chama a API pela porta 18080' }),
    ]);
    expect(verified).toEqual([]);
  });

  it('matches whole words only, so 8080 is not found inside 18080', () => {
    const { verified } = verifyContradictions(docs, [
      pair('porta', { file: 'brief.md', quote: 'porta 8080' }, { file: 'flow.md', quote: 'porta 8080' }),
    ]);
    expect(verified).toEqual([]);
  });

  it('drops a quote that names a file the cycle does not hold', () => {
    const { verified } = verifyContradictions(docs, [
      pair('porta', { file: 'project.json', quote: 'A API responde na porta 8080' }, { file: 'flow.md', quote: 'chama a API pela porta 18080' }),
    ]);
    expect(verified).toEqual([]);
  });

  it('accepts a path to the briefing and the name the agent gives it', () => {
    const { verified } = verifyContradictions(docs, [
      pair('porta', { file: 'docs/briefing.md', quote: 'A API responde na porta 8080' }, { file: 'docs/flow.md', quote: 'chama a API pela porta 18080' }),
    ]);
    expect(verified).toHaveLength(1);
  });

  it('drops a contradiction whose two sides are the same quote', () => {
    const { verified } = verifyContradictions(docs, [
      pair('porta', { file: 'brief.md', quote: 'A API responde na porta 8080' }, { file: 'brief.md', quote: 'A API responde na porta 8080' }),
    ]);
    expect(verified).toEqual([]);
  });

  it('reports a null heading for a quote that sits before the first section', () => {
    const preamble: DocTexts = { 'flow.md': 'Visão geral do cliente.\n\n## 1. Entrada\n\nO cliente chama a API.\n', 'stack.md': 'Porta 3000 fixa.' };
    const { verified } = verifyContradictions(preamble, [
      pair('visão', { file: 'flow.md', quote: 'Visão geral do cliente' }, { file: 'stack.md', quote: 'Porta 3000 fixa' }),
    ]);
    expect(verified[0]?.a.heading).toBeNull();
  });
});
