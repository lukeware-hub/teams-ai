import { describe, expect, it } from 'vitest';
import { RefineEvent } from '../../server/refine/events.js';
import { applyRefineEvent, emptyRefineState } from '../../server/refine/state.js';

describe('a reprocess drops the suggestions accepted after the passed text', () => {
  it('keeps the ones accepted before the pass, and drops the ones accepted after it', () => {
    const state = emptyRefineState();
    const apply = (type: string, data: Record<string, unknown>) => applyRefineEvent(state, { type, data });
    apply(RefineEvent.PatchProposed, { patchId: 'p1', role: 'po', file: 'briefing.md', find: 'a', replace: 'b', reason: 'x', diff: '', cycle: 1 });
    apply(RefineEvent.PatchAccepted, { patchId: 'p1' });
    apply(RefineEvent.StagePassed, { file: 'briefing.md', hash: 'h' });
    apply(RefineEvent.PatchProposed, { patchId: 'p2', role: 'po', file: 'briefing.md', find: 'c', replace: 'd', reason: 'y', diff: '', cycle: 2 });
    apply(RefineEvent.PatchAccepted, { patchId: 'p2' });
    apply(RefineEvent.StageReprocessed, { file: 'briefing.md' });
    expect(state.patches.find((p) => p.patchId === 'p1')?.status).toBe('accepted');
    expect(state.patches.find((p) => p.patchId === 'p2')?.status).toBe('dropped');
    expect(state.patches.find((p) => p.patchId === 'p2')?.decision).toBe('Voltou ao texto entregue com o Reprocessar.');
  });

  it('leaves the suggestions of other documents as they are', () => {
    const state = emptyRefineState();
    const apply = (type: string, data: Record<string, unknown>) => applyRefineEvent(state, { type, data });
    apply(RefineEvent.PatchProposed, { patchId: 'p3', role: 'po', file: 'stack.md', find: 'e', replace: 'f', reason: 'z', diff: '', cycle: 1 });
    apply(RefineEvent.PatchAccepted, { patchId: 'p3' });
    apply(RefineEvent.StagePassed, { file: 'briefing.md', hash: 'h' });
    apply(RefineEvent.StageReprocessed, { file: 'briefing.md' });
    expect(state.patches.find((p) => p.patchId === 'p3')?.status).toBe('accepted');
  });
});
