import { describe, expect, it } from 'vitest';
import { refineLimits } from '../../server/refine/limits.js';
import { emptyRefineState, released, type RefineState } from '../../server/refine/state.js';

describe('refineLimits', () => {
  it('defaults to release at 5 and lock at 10 rounds', () => {
    expect(refineLimits({})).toEqual({ release: 5, max: 10 });
  });
  it('reads both limits from the environment', () => {
    expect(refineLimits({ TEAMS_AI_REFINE_RELEASE_ROUNDS: '3', TEAMS_AI_REFINE_MAX_ROUNDS: '8' })).toEqual({ release: 3, max: 8 });
  });
  it('falls back to the default for values that are not positive whole numbers', () => {
    expect(refineLimits({ TEAMS_AI_REFINE_RELEASE_ROUNDS: 'abc', TEAMS_AI_REFINE_MAX_ROUNDS: '0' })).toEqual({ release: 5, max: 10 });
    expect(refineLimits({ TEAMS_AI_REFINE_MAX_ROUNDS: '2.5' })).toEqual({ release: 5, max: 10 });
  });
  it('never releases after the lock round', () => {
    expect(refineLimits({ TEAMS_AI_REFINE_RELEASE_ROUNDS: '12', TEAMS_AI_REFINE_MAX_ROUNDS: '10' })).toEqual({ release: 10, max: 10 });
  });
});

const limits = { release: 5, max: 10 };
const at = (over: Partial<RefineState>): RefineState => ({ ...emptyRefineState(), cycle: 5, status: 'answering', derived: { project: {} as never, spec: {} as never }, ...over });

describe('released', () => {
  it('opens at the release round with checks still failing', () => {
    expect(released(at({}), limits)).toBe(true);
  });
  it('stays closed below the release round', () => {
    expect(released(at({ cycle: 4 }), limits)).toBe(false);
  });
  it('stays closed while evaluating, started, in error, stale, or without a derived spec', () => {
    expect(released(at({ status: 'evaluating' }), limits)).toBe(false);
    expect(released(at({ status: 'started' }), limits)).toBe(false);
    expect(released(at({ status: 'error' }), limits)).toBe(false);
    expect(released(at({ stale: true }), limits)).toBe(false);
    expect(released(at({ derived: null }), limits)).toBe(false);
  });
  it('stays closed for a backlog that is not detailed yet', () => {
    expect(released(at({ backlog: { enabled: true, detail: false } as never }), limits)).toBe(false);
    expect(released(at({ backlog: { enabled: true, detail: true } as never }), limits)).toBe(true);
  });
});
