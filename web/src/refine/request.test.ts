import { describe, expect, it } from 'vitest';
import type { RefineState } from '../api.js';
import { impactCounts, readyChecks, replanRows, requestNodes, requestTrail } from './request.js';

const item = (key: string, rank: number, dependsOn: string[] = []) => ({ key, title: key, epic: 'core', scope: 's', priority: 'P1', rationale: 'r', dependsOn, sources: [], size: 'M', rank });
const base = {
  status: 'answering',
  stale: false,
  cycle: 1,
  questions: [],
  backlog: {
    enabled: true,
    detail: true,
    items: [item('login', 1), item('export', 2), item('cart', 3, ['login', 'export'])],
    specs: { login: { spec: { status: 'running' } }, export: { spec: { status: 'planned' } }, cart: { spec: { status: 'planned' } } },
  },
  extension: { requestId: 'pedido-1', title: 'Exportar', text: 'Exportar em PDF.', at: 'x', before: [{ key: 'login', rank: 1, dependsOn: [] }, { key: 'cart', rank: 2, dependsOn: ['login'] }] },
} as unknown as RefineState;

describe('the trail of a request', () => {
  it('marks the request done, and the step still open as the active one', () => {
    const nodes = requestNodes(base);
    expect(nodes.map((n) => [n.key, n.state])).toEqual([['pedido', 'done'], ['impacto', 'active'], ['specs', 'todo'], ['pronto', 'todo']]);
  });

  it('marks the impact done once the SM made it', () => {
    const nodes = requestNodes({ ...base, impact: { inputHash: 'h', impact: { summary: 's', affected: [], conflicts: [], duplicates: [], dependencies: [], risks: [] }, issues: [] } } as RefineState);
    expect(nodes.find((n) => n.key === 'impacto')?.state).toBe('done');
  });
});

describe('the impact counts', () => {
  it('counts the new specs, the affected specs and documents, and the risks', () => {
    const impact = { summary: 's', affected: [{ kind: 'spec', ref: 'login', effect: 'e', action: 'adjust' }, { kind: 'doc', ref: 'flow.md', effect: 'e', action: 'review' }], conflicts: [], duplicates: [], dependencies: [], risks: [{ text: 'r', severity: 'low', mitigation: 'm' }] };
    expect(impactCounts(impact as never, 1)).toEqual({ novas: 1, afetadas: 1, documentos: 1, riscos: 1 });
    expect(impactCounts(null, 0)).toEqual({ novas: 0, afetadas: 0, documentos: 0, riscos: 0 });
  });
});

describe('the replan of a request', () => {
  it('names what is new, what moved and what stays, against the outline the request followed', () => {
    const rows = replanRows(base);
    expect(rows.map((r) => [r.key, r.state, r.oldRank, r.newRank, r.change])).toEqual([
      ['login', 'em execução', 1, 1, 'mantida'],
      ['export', 'nova', null, 2, 'nova'],
      ['cart', 'planejada', 2, 3, 'desceu 1 · depende de login, export'],
    ]);
  });
});

describe('the checks of a request before it starts', () => {
  it('passes the impact, the specs, the plans and the questions when all are in place', () => {
    const ready = { ...base, status: 'ready', speckit: { status: 'done', stale: false, steps: [] }, impact: { inputHash: 'h', impact: { summary: 's', affected: [], conflicts: [], duplicates: [], dependencies: [], risks: [] }, issues: [] } } as unknown as RefineState;
    expect(readyChecks(ready, true).every((c) => c.ok)).toBe(true);
    expect(readyChecks(base, true).find((c) => c.id === 'impacto')?.ok).toBe(false);
  });

  it('keeps the specs open while specs.md is not approved, even when every item has its spec', () => {
    const ready = { ...base, status: 'ready', speckit: { status: 'done', stale: false, steps: [] }, impact: { inputHash: 'h', impact: { summary: 's', affected: [], conflicts: [], duplicates: [], dependencies: [], risks: [] }, issues: [] } } as unknown as RefineState;
    expect(readyChecks(ready, false).find((c) => c.id === 'specs')?.ok).toBe(false);
  });
});

describe('the trail of a request', () => {
  it('counts the specs, their plans and their task lists', () => {
    const trace = { heading: 'Pedido pedido-1', specs: [{ key: 'a', specId: 'a', citesRequest: true, planned: true, tasked: true }, { key: 'b', specId: 'b', citesRequest: true, planned: true, tasked: false }] };
    expect(requestTrail(trace, 2)).toBe('Pedido → 2 specs → 2 planos → 1 tarefas');
    expect(requestTrail(null, 0)).toBe('Pedido → 0 specs → 0 planos → 0 tarefas');
  });
});
