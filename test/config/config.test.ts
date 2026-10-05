import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_CONFIG, loadConfig } from '../../server/config/config.js';

describe('loadConfig', () => {
  it('fills every default from an empty object', () => {
    const cfg = loadConfig({});
    expect(cfg).toEqual(DEFAULT_CONFIG);
    expect(cfg.roles.dev).toEqual({ model: 'opus' });
    expect(cfg.roles.test).toEqual({ model: 'sonnet' });
    expect(cfg.concurrency.maxParallel).toBe(3);
    expect(cfg.retry.maxAttempts).toBe(3);
    expect(cfg.budgets.observeOnly).toBe(true);
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
