import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_CONFIG, TIMER_MAX_MS, loadConfig, stepBudgetFor, stepModelFor } from '../../server/config/config.js';

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
    expect(cfg.roles.dev).toEqual({ model: 'claude-sonnet-5-5' });
    expect(cfg.roles.test).toEqual({ model: 'claude-sonnet-5-5' });
    expect(cfg.concurrency.maxParallel).toBe(3);
    expect(cfg.retry.maxAttempts).toBe(3);
    expect(cfg.budgets.observeOnly).toBe(true);
  });

  it('runs Opus only on the architecture steps, Haiku on small tasks and Sonnet on the rest', () => {
    const cfg = loadConfig({});
    expect(Object.values(cfg.roles).every((r) => r.model === 'claude-sonnet-5-5')).toBe(true);
    expect(cfg.routing.stepModels).toEqual({ 'tech-spec': 'claude-opus-5-5', plan: 'claude-opus-5-5', 'services-plan': 'claude-opus-5-5' });
    expect(cfg.routing.models).toEqual({ small: 'claude-haiku-5-5', medium: 'claude-sonnet-5-5', large: 'claude-sonnet-5-5' });
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

  it('keeps agent settings empty by default and accepts a manual pick per project and role', () => {
    expect(loadConfig({}).agentSettings).toEqual({});
    const cfg = loadConfig({ agentSettings: { demo: { dev: { model: 'claude-opus-5-5', effort: 'max' } } } });
    expect(cfg.agentSettings.demo.dev).toEqual({ model: 'claude-opus-5-5', effort: 'max' });
  });

  it('rejects an agent setting with an unknown role, model or effort', () => {
    expect(() => loadConfig({ agentSettings: { demo: { qa: { model: 'opus', effort: 'low' } } } })).toThrow(/agentSettings/);
    expect(() => loadConfig({ agentSettings: { demo: { dev: { model: 'gpt', effort: 'low' } } } })).toThrow(/agentSettings/);
    expect(() => loadConfig({ agentSettings: { demo: { dev: { model: 'opus', effort: 'turbo' } } } })).toThrow(/agentSettings/);
  });

  it('rejects a step time limit that a timer cannot hold', () => {
    expect(() => loadConfig({ stepTimeouts: { demo: TIMER_MAX_MS + 1 } })).toThrow(/stepTimeouts/);
    expect(loadConfig({ stepTimeouts: { demo: TIMER_MAX_MS } }).stepTimeouts.demo).toBe(TIMER_MAX_MS);
  });
});

describe('stepBudgetFor', () => {
  it('gives a project its own time limit and every other project the budget default', () => {
    const cfg = loadConfig({ stepTimeouts: { demo: 45 * 60_000 } });
    expect(stepBudgetFor(cfg, 'demo')).toEqual({ ...cfg.budgets.step, timeoutMs: 45 * 60_000 });
    expect(stepBudgetFor(cfg, 'other')).toEqual(cfg.budgets.step);
    expect(stepBudgetFor(cfg)).toEqual(cfg.budgets.step);
  });

  it('does not take an inherited name such as constructor for a time limit', () => {
    expect(stepBudgetFor(loadConfig({}), 'constructor')).toEqual(DEFAULT_CONFIG.budgets.step);
  });
});
