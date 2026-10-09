import { describe, expect, it } from 'vitest';
import { refineStepModel } from '../../server/refine/agent.js';
import { DEFAULT_CONFIG } from '../../server/config/config.js';

const routing = { ...DEFAULT_CONFIG.routing, stepModels: { refine: 'opus', derive: 'opus' }, laterCycleModels: { refine: 'sonnet' } };

describe('refineStepModel', () => {
  it('leaves every step to the role profile by default', () => {
    expect(refineStepModel(DEFAULT_CONFIG.routing, 'refine', 1)).toBeUndefined();
    expect(refineStepModel(DEFAULT_CONFIG.routing, 'refine', 5)).toBeUndefined();
  });

  it('uses stepModels on the first cycle and laterCycleModels from the second on', () => {
    expect(refineStepModel(routing, 'refine', 1)).toBe('opus');
    expect(refineStepModel(routing, 'refine', 2)).toBe('sonnet');
  });

  it('falls back to stepModels for a kind laterCycleModels does not name', () => {
    expect(refineStepModel(routing, 'derive', 4)).toBe('opus');
  });
});
