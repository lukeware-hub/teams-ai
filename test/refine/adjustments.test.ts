import { describe, expect, it } from 'vitest';
import type { BacklogItem } from '../../server/contracts/backlog.js';
import type { SpecStatus } from '../../server/contracts/spec.js';
import { adjustmentItems, adjustmentsDue, approvalPatch, approvedAdjustments, isAdjustment } from '../../server/refine/adjustments.js';
import { sourceHashes, type BacklogDocs } from '../../server/refine/details.js';
import { applyPatch } from '../../server/refine/patches.js';
import { sectionText } from '../../server/refine/sections.js';
import type { PatchRow, SpecRow } from '../../server/refine/state.js';
import { makeSpec } from '../fixtures/contracts.js';

const item = (key: string, over: Partial<BacklogItem> = {}): BacklogItem => ({
  key, title: `Item ${key}`, epic: 'supr', scope: `Entrega ${key}`, priority: 'P1', rationale: 'valor', dependsOn: [], sources: [{ doc: 'flow.md', heading: '3. OPME' }], size: 'M', ...over,
});

describe('approved adjustments', () => {
  it('reads one key per "Ajuste aprovado" heading of briefing.md, and nothing else', () => {
    const briefing = ['# Briefing', '', '## Ajuste aprovado: opme-ajuste-1', '', 'texto', '', '### ajuste aprovado: `OPME-Ajuste-2`', '', '## Ajuste aprovado: opme-ajuste-1', '', '- Ajuste aprovado: caso-ajuste-1', '## Ajuste aprovado: caso-ajuste-1 (texto a mais)', '## Ajuste aprovado: caso', 'Texto ## Ajuste aprovado: fat-ajuste-1'].join('\n');
    expect(approvedAdjustments(briefing)).toEqual(['opme-ajuste-1', 'opme-ajuste-2']);
    expect(approvedAdjustments('# Briefing\r\n\r\n## Ajuste aprovado: opme-ajuste-1\r\n')).toEqual(['opme-ajuste-1']);
  });

  it('tells an adjustment key from an item key', () => {
    expect(['opme-ajuste-1', 'a-b-ajuste-12', 'ajuste-1', 'opme', 'opme-ajuste-x'].map(isAdjustment)).toEqual([true, true, false, false, false]);
  });

  it('adds each approved adjustment after its original and the earlier ones, citing its approval', () => {
    const opme = item('opme', { dependsOn: ['caso'], priority: 'P2', size: 'L' });
    const items = adjustmentItems([item('caso'), opme], ['opme-ajuste-10', 'opme-ajuste-2', 'opme-ajuste-1', 'fat-ajuste-1']);
    expect(items.map((i) => [i.key, i.dependsOn])).toEqual([['opme-ajuste-1', ['opme']], ['opme-ajuste-2', ['opme-ajuste-1']], ['opme-ajuste-10', ['opme-ajuste-2']]]);
    expect(items[0]).toMatchObject({ title: 'Ajuste 1: Item opme', epic: 'supr', priority: 'P2', size: 'L', sources: [{ doc: 'flow.md', heading: '3. OPME' }, { doc: 'briefing.md', heading: 'Ajuste aprovado: opme-ajuste-1' }] });
  });
});

const H = `sha256:${'a'.repeat(64)}`;

describe('adjustments due', () => {
  const flow = (opme: string) => ['```mermaid', '%% 1. Caso', '  A --> B', '%% 3. OPME', `  ${opme}`, '```', ''].join('\n');
  const docs = (opme: string, briefing = '# Briefing\n'): BacklogDocs => ({ 'project.md': '', 'briefing.md': briefing, 'stack.md': '', 'flow.md': flow(opme), 'design.md': '' });
  const before = docs('C --> D');
  const after = docs('C --> D2[Cotação]');
  const opme = item('opme');
  const started = (key: string, of: BacklogItem, from: BacklogDocs, status: SpecStatus): SpecRow => {
    const spec = { ...makeSpec({ specId: `big-001-${key}`, status }), derivedFrom: { backlogKey: of.key, inputHash: H, docsHash: H, sources: sourceHashes(of, from) } };
    return { inputHash: H, specId: spec.specId, rev: H, spec, issues: [], cycle: 1 };
  };
  const due = (specs: Record<string, SpecRow>, items: BacklogItem[] = [opme], d = after, patches: Array<Pick<PatchRow, 'status' | 'replace'>> = []) =>
    adjustmentsDue({ items: items.map((i, n) => ({ ...i, rank: n + 1 })), specs }, d, patches).map((a) => a.key);

  it('asks for the first adjustment of a delivered or running spec whose cited section changed', () => {
    expect(adjustmentsDue({ items: [{ ...opme, rank: 1 }], specs: { opme: started('opme', opme, before, 'done') } }, after, [])).toEqual([{ key: 'opme-ajuste-1', specId: 'big-001-opme', status: 'done', changed: ['flow.md › 3. OPME'] }]);
    expect(due({ opme: started('opme', opme, before, 'running') })).toEqual(['opme-ajuste-1']);
  });

  it('asks nothing for unchanged sections, a spec not started, or one with no provenance', () => {
    expect(due({ opme: started('opme', opme, before, 'done') }, [opme], before)).toEqual([]);
    expect(due({ opme: started('opme', opme, before, 'planned') })).toEqual([]);
    const done = started('opme', opme, before, 'done');
    expect(due({ opme: { ...done, spec: { ...done.spec!, derivedFrom: undefined } } })).toEqual([]);
  });

  it('leaves a change to the open adjustment, and asks for the next one once the last adjustment started', () => {
    const approved = '# Briefing\n\n## Ajuste aprovado: opme-ajuste-1\n\ntexto\n';
    const [first] = adjustmentItems([opme], ['opme-ajuste-1']);
    const derivedAt = docs('C --> D2[Cotação]', approved);
    const changedAgain = docs('C --> D3[Cotação dupla]', approved);
    const rows = (status: SpecStatus) => ({ opme: started('opme', opme, before, 'done'), 'opme-ajuste-1': started('opme-ajuste-1', first!, derivedAt, status) });
    expect(due(rows('planned'), [opme, first!], changedAgain)).toEqual([]);
    expect(due(rows('done'), [opme, first!], changedAgain)).toEqual(['opme-ajuste-2']);
  });

  it('never asks again what is still pending or was rejected in this draft', () => {
    const asked = (status: PatchRow['status'], key = 'opme-ajuste-1') => [{ status, replace: approvalPatch({ key, specId: 'x', status: 'done', changed: [] }).replace }];
    const specs = { opme: started('opme', opme, before, 'done') };
    expect(due(specs, [opme], after, asked('pending'))).toEqual([]);
    expect(due(specs, [opme], after, asked('rejected'))).toEqual([]);
    expect(due(specs, [opme], after, asked('pending', 'opme-ajuste-11'))).toEqual(['opme-ajuste-1']);
  });
});

describe('approval patch', () => {
  it('appends a section that changes the text of no other section, and every other patch still applies', () => {
    const briefing = '# Briefing\n\n## Prioridades\n\n- OPME é P2\n\n### Detalhe\n\ntexto';
    const p = approvalPatch({ key: 'opme-ajuste-1', specId: 'big-001-opme', status: 'done', changed: ['flow.md › 3. OPME'] });
    const accepted = applyPatch(briefing, p)!;
    expect(approvedAdjustments(accepted)).toEqual(['opme-ajuste-1']);
    for (const heading of ['Prioridades', 'Detalhe']) expect(sectionText(accepted, heading)).toBe(sectionText(briefing, heading));
    expect(applyPatch(accepted, { find: '- OPME é P2', replace: '- OPME é P1' })).not.toBeNull();
    expect(p.reason).toContain('flow.md › 3. OPME');
    expect(p.reason).toContain('opme-ajuste-1');
  });
});
