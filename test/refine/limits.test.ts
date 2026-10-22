import { describe, expect, it } from 'vitest';
import { refineLimits } from '../../server/refine/limits.js';

describe('refineLimits', () => {
  it('defaults to lock at 50 rounds', () => {
    expect(refineLimits({})).toEqual({ max: 50 });
  });
  it('reads the limit from the environment', () => {
    expect(refineLimits({ TEAMS_AI_REFINE_MAX_ROUNDS: '8' })).toEqual({ max: 8 });
  });
  it('falls back to the default for values that are not positive whole numbers', () => {
    expect(refineLimits({ TEAMS_AI_REFINE_MAX_ROUNDS: 'abc' })).toEqual({ max: 50 });
    expect(refineLimits({ TEAMS_AI_REFINE_MAX_ROUNDS: '0' })).toEqual({ max: 50 });
    expect(refineLimits({ TEAMS_AI_REFINE_MAX_ROUNDS: '2.5' })).toEqual({ max: 50 });
  });
});
