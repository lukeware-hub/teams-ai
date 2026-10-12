import { describe, expect, it } from 'vitest';
import type { BacklogItem } from '../../server/contracts/backlog.js';
import { batches, preplanInputHash, sourceHashes, specInputHash, type BacklogDocs } from '../../server/refine/details.js';
import { NUMBERED_MERMAID_FLOW } from '../fixtures/numbered-mermaid-flow.js';

const item = (key: string, over: Partial<BacklogItem> = {}): BacklogItem => ({
  key, title: `Item ${key}`, epic: 'core', scope: `Entrega ${key}`, priority: 'P1', rationale: 'valor', dependsOn: [], sources: [{ doc: 'flow.md', heading: '7. OPME' }], size: 'M', ...over,
});
const docs = (over: Partial<BacklogDocs> = {}): BacklogDocs => ({
  'project.md': '# Clínica\n\n## Personas\n\n- Médico',
  'briefing.md': '# Briefing\n\n## Prioridades\n\n- OPME é P2',
  'stack.md': '# Stack\n\n- Node 22',
  'flow.md': NUMBERED_MERMAID_FLOW,
  'design.md': '# Design',
  ...over,
});
const ranked = (i: BacklogItem, rank: number) => ({ ...i, rank });

describe('specInputHash', () => {
  it('changes only for the items citing an edited section', () => {
    const opme = item('opme');
    const caso = item('caso', { sources: [{ doc: 'flow.md', heading: '1. Caso' }] });
    const edited = docs({ 'flow.md': NUMBERED_MERMAID_FLOW.replace('O1[Cotação]', 'O1[Cotação em 3 fornecedores]') });
    expect(specInputHash(opme, edited)).not.toBe(specInputHash(opme, docs()));
    expect(specInputHash(caso, edited)).toBe(specInputHash(caso, docs()));
  });

  it('ignores uncited docs and a dependency scope, and follows the item own scope and sources', () => {
    const dependent = item('consumo', { dependsOn: ['opme'] });
    const base = specInputHash(dependent, docs());
    expect(specInputHash(dependent, docs({ 'project.md': '# Outro projeto', 'design.md': '# Outro design' }))).toBe(base);
    // R11.10: the dependencies feed the pre-plan only.
    expect(specInputHash(item('consumo', { dependsOn: ['opme', 'caso'] }), docs())).toBe(base);
    expect(specInputHash(item('consumo', { dependsOn: ['opme'], scope: 'Outro escopo' }), docs())).not.toBe(base);
    expect(specInputHash(item('consumo', { dependsOn: ['opme'], sources: [{ doc: 'briefing.md', heading: 'Prioridades' }] }), docs())).not.toBe(base);
    const briefingItem = item('prio', { sources: [{ doc: 'briefing.md', heading: 'Prioridades' }] });
    expect(specInputHash(briefingItem, docs({ 'briefing.md': '# Briefing\n\n## Prioridades\n\n- OPME é P1' }))).not.toBe(specInputHash(briefingItem, docs()));
  });

  it('records each cited section with the hash of its text and of its text below the heading, null when the heading is missing', () => {
    const sources = sourceHashes(item('x', { sources: [{ doc: 'flow.md', heading: '7. OPME' }, { doc: 'flow.md', heading: '9. Faturamento' }] }), docs());
    expect(sources[0]).toMatchObject({ doc: 'flow.md', heading: '7. OPME', hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), bodyHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
    expect(sources[0]!.bodyHash).not.toBe(sources[0]!.hash);
    expect(sources[1]).toEqual({ doc: 'flow.md', heading: '9. Faturamento', hash: null, bodyHash: null });
  });
});

describe('preplanInputHash', () => {
  it('follows the planned spec, stack.md and whether the item carries the scaffold', () => {
    const i = item('opme');
    const rev = `sha256:${'a'.repeat(64)}`;
    const base = preplanInputHash(i, rev, '# Stack', false);
    expect(preplanInputHash(i, `sha256:${'b'.repeat(64)}`, '# Stack', false)).not.toBe(base);
    expect(preplanInputHash(i, rev, '# Stack\n- Postgres', false)).not.toBe(base);
    expect(preplanInputHash(i, rev, '# Stack', true)).not.toBe(base);
    const rescoped = { ...i, scope: 'outro' };
    expect(preplanInputHash(rescoped, rev, '# Stack', false)).toBe(base);
    expect(preplanInputHash({ ...i, dependsOn: ['caso'] }, rev, '# Stack', false)).not.toBe(base);
  });
});

describe('batches', () => {
  it('groups by epic in rank order, at most three items per call', () => {
    const items = [
      ranked(item('a', { epic: 'core' }), 1), ranked(item('b', { epic: 'opme' }), 2), ranked(item('c', { epic: 'core' }), 3),
      ranked(item('d', { epic: 'core' }), 4), ranked(item('e', { epic: 'core' }), 5), ranked(item('f', { epic: 'opme' }), 6),
    ];
    expect(batches(items).map((b) => b.map((i) => i.key))).toEqual([['a', 'c', 'd'], ['e'], ['b', 'f']]);
    expect(batches(items, 1).map((b) => b.map((i) => i.key))).toEqual([['a'], ['c'], ['d'], ['e'], ['b'], ['f']]);
  });
});
