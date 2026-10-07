import { describe, expect, it } from 'vitest';
import type { ItemSpec } from '../../server/agents/outputs.js';
import type { AcceptanceCriterion, SpecProvenance } from '../../server/contracts/spec.js';
import { allocateCriteria, postProcessItemSpec } from '../../server/refine/item-spec.js';

const ac = (id: string, then: string): AcceptanceCriterion => ({ id, given: 'g', when: 'w', then, smoke: false });
const provenance: SpecProvenance = { backlogKey: 'opme', inputHash: `sha256:${'b'.repeat(64)}`, docsHash: `sha256:${'c'.repeat(64)}`, sources: [{ doc: 'flow.md', heading: '7. OPME', hash: `sha256:${'d'.repeat(64)}` }] };
const out = (over: Partial<ItemSpec> = {}): ItemSpec => ({
  key: 'opme', type: 'feature', objectives: ['Controlar OPME'], features: ['Pedido'], acceptanceCriteria: [ac('AC-001', 'pedido criado'), ac('AC-002', 'cotação')], outOfScope: [], externalDependencies: [], ...over,
});

describe('allocateCriteria', () => {
  it('numbers new criteria above every id already used in the target project', () => {
    const r = allocateCriteria([ac('AC-001', 'a'), ac('AC-002', 'b')], [], 46);
    expect(r).toEqual({ ok: true, criteria: [ac('AC-047', 'a'), ac('AC-048', 'b')], highWater: 48 });
  });

  it('keeps the id of an unchanged criterion, then of one the agent echoes, and never reuses a number', () => {
    const previous = [ac('AC-047', 'x'), ac('AC-048', 'y'), ac('AC-049', 'gone')];
    // c1 echoes AC-047 with new text, c2 keeps the text of AC-047: the text wins, the echo of a taken id gets a new number.
    const r = allocateCriteria([ac('AC-047', 'new'), ac('AC-050', 'x'), ac('AC-048', 'y edited')], previous, 49);
    expect(r).toEqual({ ok: true, criteria: [ac('AC-050', 'new'), ac('AC-047', 'x'), ac('AC-048', 'y edited')], highWater: 50 });
  });

  it('is stable across cycles when nothing changed', () => {
    const first = allocateCriteria([ac('AC-001', 'a'), ac('AC-002', 'b')], [], 10);
    if (!first.ok) throw new Error('allocation failed');
    expect(allocateCriteria([ac('AC-009', 'a'), ac('AC-001', 'b')], first.criteria, first.highWater)).toEqual(first);
  });

  it('fails closed at AC-999', () => {
    const r = allocateCriteria([ac('AC-001', 'a'), ac('AC-002', 'b')], [], 998);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.issues.join(' ')).toMatch(/AC-999/);
  });
});

describe('postProcessItemSpec', () => {
  it('builds the item spec: id from the draft and key, refining, no hash, provenance, global criteria ids', () => {
    const r = postProcessItemSpec(out(), { draftId: 'kayron-001', previous: null, highWater: 46, provenance });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec).toMatchObject({ specId: 'kayron-001-opme', status: 'refining', specHash: null, specVersion: 0, type: 'feature', derivedFrom: provenance, validationReports: [] });
    expect(r.spec.acceptanceCriteria.map((c) => c.id)).toEqual(['AC-047', 'AC-048']);
    expect(r.highWater).toBe(48);
  });

  it('keeps the ids of the previous spec of the same item', () => {
    const first = postProcessItemSpec(out(), { draftId: 'kayron-001', previous: null, highWater: 46, provenance });
    if (!first.ok) throw new Error('first derivation failed');
    const again = postProcessItemSpec(out({ acceptanceCriteria: [ac('AC-002', 'cotação'), ac('AC-003', 'aprovação')] }), { draftId: 'kayron-001', previous: first.spec, highWater: first.highWater, provenance });
    expect(again.ok && again.spec.acceptanceCriteria.map((c) => c.id)).toEqual(['AC-048', 'AC-049']);
  });

  it('reports what the spec contract rejects, with paths', () => {
    const r = postProcessItemSpec(out({ type: 'bug' }), { draftId: 'kayron-001', previous: null, highWater: 0, provenance });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.issues.join('\n')).toMatch(/bug/);
  });
});
