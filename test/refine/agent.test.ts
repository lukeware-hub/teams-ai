import { describe, expect, it } from 'vitest';
import { refineSettingsDir, refineStepModel } from '../../server/refine/agent.js';
import { DEFAULT_CONFIG } from '../../server/config/config.js';

const routing = { ...DEFAULT_CONFIG.routing, stepModels: { refine: 'opus', derive: 'opus' }, laterCycleModels: { refine: 'sonnet' } };

describe('refineStepModel', () => {
  it('runs the first cycle on the role profile and later cycles on sonnet by default', () => {
    expect(refineStepModel(DEFAULT_CONFIG.routing, 'refine', 1)).toBeUndefined();
    expect(refineStepModel(DEFAULT_CONFIG.routing, 'refine', 5)).toBe('claude-sonnet-5-5');
  });

  it('uses stepModels on the first cycle and laterCycleModels from the second on', () => {
    expect(refineStepModel(routing, 'refine', 1)).toBe('opus');
    expect(refineStepModel(routing, 'refine', 2)).toBe('sonnet');
  });

  it('falls back to stepModels for a kind laterCycleModels does not name', () => {
    expect(refineStepModel(routing, 'derive', 4)).toBe('opus');
  });
});

describe('refineSettingsDir', () => {
  it('keeps the settings of a plan step out of the folder it publishes', () => {
    expect(refineSettingsDir({ kind: 'refine', cwd: '/w/refine/a' })).toBe('/w/refine/a/settings');
    expect(refineSettingsDir({ kind: 'speckit', cwd: '/w/refine/a/speckit' })).toBe('/w/refine/a/speckit-settings');
  });
});
