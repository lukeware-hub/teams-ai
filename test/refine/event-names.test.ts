import { describe, expect, it } from 'vitest';
import { currentEvent, RefineEvent } from '../../server/refine/events.js';

describe('the names of the plan preparation in the journal', () => {
  it('reads a journal written under the old names with the current names', () => {
    expect(RefineEvent.SpeckitFailed).toBe('PLANS_FAILED');
    expect(currentEvent({ type: 'SPECKIT_FAILED', data: { reason: 'x' } })).toEqual({ type: 'PLANS_FAILED', data: { reason: 'x' } });
  });

  it('leaves the other names as they are, the legacy completion and the plans ones included', () => {
    expect(currentEvent({ type: 'SPECKIT_DONE', data: {} }).type).toBe('SPECKIT_DONE');
    expect(currentEvent({ type: 'PLANS_PREPARED', data: {} }).type).toBe('PLANS_PREPARED');
    expect(currentEvent({ type: 'constructor', data: {} }).type).toBe('constructor');
  });
});
