import { describe, expect, it } from 'vitest';
import type { BacklogItem } from '../../server/contracts/backlog.js';
import { adjustmentItems, approvedAdjustments, isAdjustment } from '../../server/refine/adjustments.js';

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
