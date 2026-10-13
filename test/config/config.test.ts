import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_CONFIG, loadConfig, stepModelFor } from '../../server/config/config.js';

describe('stepModelFor', () => {
  it("gives a services plan the plan's model unless it has its own, since both plan the run", () => {
    const routing = loadConfig({ routing: { stepModels: { plan: 'opus' } } }).routing;
    expect(stepModelFor(routing, 'services-plan')).toBe('opus');
    expect(stepModelFor(loadConfig({ routing: { stepModels: { plan: 'opus', 'services-plan': 'sonnet' } } }).routing, 'services-plan')).toBe('sonnet');
    expect(stepModelFor(routing, 'dev')).toBeUndefined();
  });
});

describe('loadConfig', () => {
  it('fills every default from an empty object', () => {
    const cfg = loadConfig({});
    expect(cfg).toEqual(DEFAULT_CONFIG);
    expect(cfg.roles.dev).toEqual({ model: 'sonnet' });
    expect(cfg.roles.test).toEqual({ model: 'sonnet' });
    expect(cfg.concurrency.maxParallel).toBe(3);
    expect(cfg.retry.maxAttempts).toBe(3);
    expect(cfg.budgets.observeOnly).toBe(true);
  });

  it('runs Opus only on the architecture steps, Haiku on small tasks and Sonnet on the rest', () => {
    const cfg = loadConfig({});
    expect(Object.values(cfg.roles).every((r) => r.model === 'sonnet')).toBe(true);
    expect(cfg.routing.stepModels).toEqual({ 'tech-spec': 'opus', plan: 'opus', 'services-plan': 'opus' });
    expect(cfg.routing.models).toEqual({ small: 'haiku', medium: 'sonnet', large: 'sonnet' });
  });

  it('merges partial overrides without dropping sibling defaults', () => {
    const cfg = loadConfig({ roles: { test: { model: 'haiku' } }, github: { owner: 'acme' } });
    expect(cfg.roles.test).toEqual({ model: 'haiku' });
    expect(cfg.roles.sm).toEqual(DEFAULT_CONFIG.roles.sm);
    expect(cfg.github.owner).toBe('acme');
  });

  it('rejects unknown roles and reports the path', () => {
    expect(() => loadConfig({ roles: { qa: { model: 'opus' } } })).toThrow(ConfigError);
    expect(() => loadConfig({ roles: { qa: { model: 'opus' } } })).toThrow(/roles.*qa/);
  });

  it('rejects a leftover provider key and non-positive limits', () => {
    expect(() => loadConfig({ roles: { dev: { provider: 'omniroute', model: 'x' } } })).toThrow(/roles.dev: Unrecognized key/);
    expect(() => loadConfig({ concurrency: { maxParallel: 0 } })).toThrow(/concurrency\.maxParallel/);
  });

  it('rejects a paths entry under /mnt/c', () => {
    expect(() => loadConfig({ paths: { workspaces: '/mnt/c/Users/x/ws' } })).toThrow(/paths\.workspaces/);
  });
});
