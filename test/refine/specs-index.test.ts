import { describe, expect, it } from 'vitest';
import { buildSpecsIndex, specIdOf } from '../../server/refine/specs-index.js';
import type { BacklogState } from '../../server/refine/state.js';

const backlog: Pick<BacklogState, 'epics' | 'items'> = {
  epics: [{ key: 'core', title: 'Núcleo' }, { key: 'fin', title: 'Financeiro' }],
  items: [
    { key: 'cobranca', title: 'Cobrança', epic: 'fin', scope: 'Gerar cobrança', priority: 'P2', rationale: 'depois do núcleo', dependsOn: ['casos'], sources: [{ doc: 'flow.md', heading: '16. Faturamento' }], size: 'L', rank: 3 },
    { key: 'base', title: 'Fundação', epic: 'core', scope: 'Esqueleto', priority: 'P0', rationale: 'tudo depende', dependsOn: [], sources: [{ doc: 'briefing.md', heading: 'Objectives' }], size: 'S', rank: 1 },
    { key: 'casos', title: 'Abertura de casos', epic: 'core', scope: 'Abrir caso', priority: 'P1', rationale: 'fluxo principal', dependsOn: ['base'], sources: [{ doc: 'flow.md', heading: '2. Abertura do caso' }], size: 'M', rank: 2 },
  ],
};

describe('buildSpecsIndex', () => {
  it('lists the specs in rank order with ids derived from the draft, dependencies as spec ids and the sources', () => {
    const index = buildSpecsIndex('kayron-hub-001', backlog);
    expect(index.version).toBe(1);
    expect(index.specs.map((s) => [s.rank, s.specId])).toEqual([[1, 'kayron-hub-001-base'], [2, 'kayron-hub-001-casos'], [3, 'kayron-hub-001-cobranca']]);
    expect(index.specs[2]).toMatchObject({ key: 'cobranca', epic: 'fin', priority: 'P2', size: 'L', dependsOn: ['kayron-hub-001-casos'], sources: [{ doc: 'flow.md', heading: '16. Faturamento' }] });
    expect(index.epics).toEqual([{ key: 'core', title: 'Núcleo' }, { key: 'fin', title: 'Financeiro' }]);
  });

  it('carries no lifecycle state, which belongs to each spec file and run', () => {
    const json = JSON.stringify(buildSpecsIndex('d-001', backlog));
    for (const field of ['"status"', '"specHash"', '"runId"', '"pr"']) expect(json).not.toContain(field);
  });

  it('names a spec after the draft and the item key', () => {
    expect(specIdOf('kayron-hub-001', 'opme')).toBe('kayron-hub-001-opme');
  });
  it('names a spec by its key alone on drafts with readable ids, never as the draft id itself', () => {
    expect(specIdOf('order-service', 'user-login', true)).toBe('user-login');
    expect(specIdOf('order-service', 'order-service', true)).toBe('order-service-order-service');
    const index = buildSpecsIndex('order-service', { epics: [], items: [{ key: 'user-login', title: 't', epic: 'e', scope: 's', priority: 'P1', rationale: 'r', dependsOn: [], sources: [], size: 'M', rank: 1 }], keyIds: true });
    expect(index.specs.map((s) => s.specId)).toEqual(['user-login']);
  });
});
