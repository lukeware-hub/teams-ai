import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_CONFIG, loadConfig, resolveProfile } from '../../server/config/config.js';

describe('loadConfig', () => {
  it('fills every default from an empty object', () => {
    const cfg = loadConfig({});
    expect(cfg).toEqual(DEFAULT_CONFIG);
    expect(cfg.roles.dev).toEqual({ provider: 'claude', model: 'opus' });
    expect(cfg.roles.test).toEqual({ provider: 'claude', model: 'sonnet' });
    expect(cfg.concurrency.maxParallel).toBe(3);
    expect(cfg.retry.maxAttempts).toBe(3);
    expect(cfg.budgets.observeOnly).toBe(true);
  });

  it('merges partial overrides without dropping sibling defaults', () => {
    const cfg = loadConfig({ roles: { test: { provider: 'omniroute', model: 'kimi/k2' } }, github: { owner: 'acme' } });
    expect(cfg.roles.test).toEqual({ provider: 'omniroute', model: 'kimi/k2' });
    expect(cfg.roles.sm).toEqual(DEFAULT_CONFIG.roles.sm);
    expect(cfg.github.owner).toBe('acme');
  });

  it('rejects unknown roles and reports the path', () => {
    expect(() => loadConfig({ roles: { qa: { provider: 'claude', model: 'opus' } } })).toThrow(ConfigError);
    expect(() => loadConfig({ roles: { qa: { provider: 'claude', model: 'opus' } } })).toThrow(/roles.*qa/);
  });

  it('rejects an unknown provider and non-positive limits', () => {
    expect(() => loadConfig({ roles: { dev: { provider: 'openai', model: 'x' } } })).toThrow(/roles\.dev\.provider/);
    expect(() => loadConfig({ concurrency: { maxParallel: 0 } })).toThrow(/concurrency\.maxParallel/);
  });

  it('rejects a paths entry under /mnt/c', () => {
    expect(() => loadConfig({ paths: { workspaces: '/mnt/c/Users/x/ws' } })).toThrow(/paths\.workspaces/);
  });
});

describe('resolveProfile', () => {
  const cfg = loadConfig({ roles: { test: { provider: 'omniroute', model: 'kimi/k2' } }, omniroute: { enabled: true } });

  it('returns the configured profile for a normal project', () => {
    expect(resolveProfile(cfg, 'test', { confidential: false })).toEqual({ provider: 'omniroute', model: 'kimi/k2' });
  });

  it('forces the Claude profile for a confidential project', () => {
    expect(resolveProfile(cfg, 'test', { confidential: true })).toEqual(DEFAULT_CONFIG.roles.test);
  });

  it('forces the Claude profile when OmniRoute is disabled', () => {
    const off = loadConfig({ roles: { test: { provider: 'omniroute', model: 'kimi/k2' } }, omniroute: { enabled: false } });
    expect(resolveProfile(off, 'test', { confidential: false })).toEqual(DEFAULT_CONFIG.roles.test);
  });
});
