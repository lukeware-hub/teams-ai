import { describe, expect, it } from 'vitest';
import { mergeChecklist, PO_ITEMS, SM_ITEMS } from '../../server/refine/checklist.js';

describe('mergeChecklist', () => {
  it('returns the fixed ids, filling omitted ones as not reported and ignoring foreign ids', () => {
    const items = mergeChecklist(
      [{ id: 'po.personas', passed: true, detail: 'two personas' }, { id: 'sm.constraints-clear', passed: true, detail: 'nope' }],
      [{ id: 'sm.constraints-clear', passed: false, detail: 'vague' }],
    );
    expect(items.map((i) => i.id)).toEqual([...PO_ITEMS, ...SM_ITEMS]);
    expect(items.find((i) => i.id === 'po.personas')).toMatchObject({ role: 'po', passed: true });
    expect(items.find((i) => i.id === 'po.objectives-verifiable')).toMatchObject({ passed: false, detail: 'not reported' });
    expect(items.find((i) => i.id === 'sm.constraints-clear')).toMatchObject({ role: 'sm', passed: false, detail: 'vague' });
  });
});
