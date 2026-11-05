import { describe, expect, it } from 'vitest';
import type { Impact } from '../../server/contracts/impact.js';
import { validateImpact } from '../../server/refine/impact.js';

const base = (over: Partial<Impact> = {}): Impact => ({ requestId: 'pedido-1', summary: 'O pedido acrescenta a exportação.', affected: [], conflicts: [], duplicates: [], dependencies: [], risks: [], ...over });
const scope = { known: new Set(['login', 'cart']), kept: new Set<string>(), requestId: 'pedido-1' };

describe('the references of an impact', () => {
  it('names only the five documents of the project', () => {
    expect(validateImpact(base({ affected: [{ kind: 'doc', ref: 'flow.md', effect: 'acrescenta a etapa', action: 'none' }] }), scope)).toEqual([]);
    expect(validateImpact(base({ affected: [{ kind: 'doc', ref: 'readme.md', effect: 'x', action: 'none' }] }), scope)).toEqual([expect.stringContaining('readme.md')]);
  });

  it('accepts a section of one of the five documents, as the request section of briefing.md', () => {
    expect(validateImpact(base({ affected: [{ kind: 'doc', ref: 'briefing.md › Pedido pedido-1', effect: 'acrescenta o pedido', action: 'none' }] }), scope)).toEqual([]);
    expect(validateImpact(base({ affected: [{ kind: 'doc', ref: 'readme.md › Pedido pedido-1', effect: 'x', action: 'none' }] }), scope)).toEqual([expect.stringContaining('readme.md')]);
  });

  it('names the architecture as one thing only', () => {
    expect(validateImpact(base({ affected: [{ kind: 'architecture', ref: 'architecture', effect: 'sem mudança', action: 'none' }] }), scope)).toEqual([]);
    expect(validateImpact(base({ affected: [{ kind: 'architecture', ref: 'banco', effect: 'x', action: 'review' }] }), scope)).toEqual([expect.stringContaining('arquitetura')]);
  });

  it('refuses an impact made for another request', () => {
    expect(validateImpact(base({ requestId: 'pedido-2' }), scope)).toEqual([expect.stringContaining('pedido-2')]);
  });
});
