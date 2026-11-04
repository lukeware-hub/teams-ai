import { describe, expect, it } from 'vitest';
import { RefineEvent } from '../../server/refine/events.js';
import { applyRefineEvent, emptyRefineState } from '../../server/refine/state.js';

const done = () => {
  const s = emptyRefineState();
  for (const doc of ['flow.md', 'project.md', 'briefing.md', 'stack.md', 'design.md']) applyRefineEvent(s, { type: RefineEvent.StageAdvanced, data: { doc, cycle: 1 } });
  return s;
};
const edited = (s: ReturnType<typeof done>, source: string) => applyRefineEvent(s, { type: RefineEvent.DocEdited, data: { file: 'briefing.md', hash: 'h', source } });

describe('what outdates the later stages', () => {
  it('an edit by hand outdates every finished stage after the document', () => {
    const s = done();
    edited(s, 'human');
    expect(Object.keys(s.staleBy ?? {})).toEqual(['stack.md', 'design.md']);
  });

  it('an accepted suggestion or a recorded decision outdates none: it is the review\'s own output', () => {
    for (const source of ['patch', 'decision']) {
      const s = done();
      edited(s, source);
      expect(s.staleBy).toBeUndefined();
    }
  });

  it('a review of the stage clears its mark', () => {
    const s = done();
    edited(s, 'human');
    applyRefineEvent(s, { type: RefineEvent.StageReviewed, data: { cycle: 2, file: 'stack.md', questions: [], divergences: [], discardedPatches: [] } });
    expect(Object.keys(s.staleBy ?? {})).toEqual(['design.md']);
  });
});
