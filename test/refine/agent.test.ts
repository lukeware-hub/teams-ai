import { describe, expect, it } from 'vitest';
import { refineSettingsDir } from '../../server/refine/agent.js';
import { automaticStepOf, DEFAULT_CONFIG } from '../../server/config/config.js';

const routing = { ...DEFAULT_CONFIG.routing, stepModels: { refine: 'opus', derive: 'opus' }, laterCycleModels: { refine: 'sonnet' }, efforts: { ...DEFAULT_CONFIG.routing.efforts, laterCycle: 'high' as const } };

describe('automaticStepOf', () => {
  it('runs the first cycle on the role profile and later cycles on sonnet by default', () => {
    expect(automaticStepOf(DEFAULT_CONFIG.routing, 'refine', 1)).toBeUndefined();
    expect(automaticStepOf(DEFAULT_CONFIG.routing, 'refine', 5)?.model).toBe('claude-sonnet-5-5');
  });

  it('uses stepModels on the first cycle and laterCycleModels from the second on, each with its effort', () => {
    expect(automaticStepOf(routing, 'refine', 1)).toEqual({ model: 'opus', effort: 'low' });
    expect(automaticStepOf(routing, 'refine', 2)).toEqual({ model: 'sonnet', effort: 'high' });
  });

  it('falls back to stepModels for a kind laterCycleModels does not name', () => {
    expect(automaticStepOf(routing, 'derive', 4)).toEqual({ model: 'opus', effort: 'low' });
  });
});

describe('refineSettingsDir', () => {
  it('keeps the settings of a plan step out of the folder it publishes', () => {
    expect(refineSettingsDir({ kind: 'refine', cwd: '/w/refine/a' })).toBe('/w/refine/a/settings');
    expect(refineSettingsDir({ kind: 'speckit', cwd: '/w/refine/a/speckit' })).toBe('/w/refine/a/speckit-settings');
  });
});
