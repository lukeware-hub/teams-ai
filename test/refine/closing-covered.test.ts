import { describe, expect, it } from 'vitest';
import { closingChecks, emptyRefineState, type RefineState } from '../../server/refine/state.js';
import { validateImpact } from '../../server/refine/impact.js';

const impact = (duplicates: unknown[], summary = 'O pedido já existe.') => ({ requestId: 'pedido-1', summary, affected: [], conflicts: [], duplicates, dependencies: [], risks: [] });
const state = (duplicates: unknown[]) => ({ ...emptyRefineState(), extension: { requestId: 'pedido-1', title: 'x', text: 'x', at: 'x', before: [{ key: 'login', rank: 1, dependsOn: [] }] }, impact: { inputHash: 'h', impact: impact(duplicates), issues: [] }, backlog: { enabled: true, project: null, epics: [], items: [], cycle: 1 } }) as unknown as RefineState;
const scope = { known: new Set(['login', 'export']), kept: new Set<string>(), requestId: 'pedido-1' };

describe('a request the backlog already covers adds no item', () => {
  it('fails the impact check when a new item repeats a spec the backlog already delivers', () => {
    const check = closingChecks(state([{ newKey: 'export', existing: 'login', verdict: 'reuse', reason: 'já entregue' }]), true).find((c) => c.id === 'impact');
    expect(check).toMatchObject({ ok: false, detail: expect.stringContaining('export') });
  });

  it('passes when the repeated item is one the request already follows, or its verdict is distinct', () => {
    expect(closingChecks(state([{ newKey: 'login', existing: 'login', verdict: 'reuse', reason: 'r' }]), true).find((c) => c.id === 'impact')).toMatchObject({ ok: true });
    expect(closingChecks(state([{ newKey: 'export', existing: 'login', verdict: 'distinct', reason: 'r' }]), true).find((c) => c.id === 'impact')).toMatchObject({ ok: true });
  });
});

describe('the summary of an impact', () => {
  it('has at most two sentences', () => {
    expect(validateImpact(impact([], 'O pedido acrescenta a exportação. O login não muda.') as never, scope)).toEqual([]);
    expect(validateImpact(impact([], 'Uma. Duas. Três.') as never, scope)).toEqual([expect.stringContaining('duas frases')]);
  });
});
