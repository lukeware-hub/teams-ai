import { describe, expect, it } from 'vitest';
import { reduceRefineEvents } from '../../server/refine/state.js';

const started = (at: string) => ({ type: 'REFINE_EVALUATION_STARTED', at, data: {} });
const ended = (at: string, data: Record<string, unknown> = {}) => ({ type: 'REFINE_EVALUATION_ENDED', at, data });

describe('the evaluation clock', () => {
  it('starts with the click and ends with the evaluation', () => {
    const s = reduceRefineEvents([started('2026-10-22T10:00:00Z'), ended('2026-10-22T10:02:05Z')]);
    expect(s.evaluation).toEqual({ startedAt: '2026-10-22T10:00:00Z', endedAt: '2026-10-22T10:02:05Z' });
  });

  it('stays open while the evaluation runs', () => {
    expect(reduceRefineEvents([started('2026-10-22T10:00:00Z')]).evaluation).toEqual({ startedAt: '2026-10-22T10:00:00Z', endedAt: null });
  });

  it('voids the record when a restart cut the evaluation off', () => {
    expect(reduceRefineEvents([started('2026-10-22T10:00:00Z'), ended('2026-10-22T10:01:00Z', { interrupted: true })]).evaluation).toBeUndefined();
  });

  it('keeps no record for an end without a start', () => {
    expect(reduceRefineEvents([ended('2026-10-22T10:01:00Z')]).evaluation).toBeUndefined();
  });

  it('keeps an empty time when the journal event carries none', () => {
    expect(reduceRefineEvents([{ type: 'REFINE_EVALUATION_STARTED', data: {} }]).evaluation).toEqual({ startedAt: '', endedAt: null });
    expect(reduceRefineEvents([started('2026-10-22T10:00:00Z'), { type: 'REFINE_EVALUATION_ENDED', data: {} }]).evaluation).toEqual({ startedAt: '2026-10-22T10:00:00Z', endedAt: '' });
  });
});
