import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_CONFIG, loadConfig, resolveDecision } from '../../server/config/config.js';

describe('decisions config', () => {
  it('defaults: layer off, Jev pinned, gate-triage chain and thresholds from spec 10A.0', () => {
    expect(DEFAULT_CONFIG.decisions.enabled).toBe(false);
    expect(DEFAULT_CONFIG.decisions.openrouter).toEqual({
      baseUrl: 'https://openrouter.ai/api',
      model: 'typesafe/jev-1.13',
      timeoutMs: 15_000,
      maxTries: 3,
      backoffMs: 500,
    });
    expect(DEFAULT_CONFIG.decisions.perDecision['gate-triage']).toEqual({
      enabled: true,
      chain: ['jev', 'local', 'claude'],
      thresholds: { jev: 0.8, local: 0.9 },
      escalateTo: 'test',
    });
  });

  it('resolveDecision turns every decision off while the layer is disabled', () => {
    expect(resolveDecision(DEFAULT_CONFIG, 'gate-triage').enabled).toBe(false);
    const on = loadConfig({ decisions: { enabled: true } });
    expect(resolveDecision(on, 'gate-triage').enabled).toBe(true);
    const oneOff = loadConfig({ decisions: { enabled: true, perDecision: { 'gate-triage': { enabled: false } } } });
    expect(resolveDecision(oneOff, 'gate-triage').enabled).toBe(false);
  });

  it('rejects an alias model, an out-of-range threshold and an unknown backend', () => {
    expect(() => loadConfig({ decisions: { openrouter: { model: 'jev-latest' } } })).toThrow(ConfigError);
    expect(() => loadConfig({ decisions: { perDecision: { 'gate-triage': { thresholds: { jev: 1.5 } } } } })).toThrow(ConfigError);
    expect(() => loadConfig({ decisions: { perDecision: { 'gate-triage': { chain: ['gpt'] } } } })).toThrow(ConfigError);
  });
  it('per-decision defaults follow the spec escalation column', () => {
    expect(DEFAULT_CONFIG.decisions.perDecision['attempt-progress']).toMatchObject({ escalateTo: 'sm', chain: ['jev', 'local', 'claude'] });
    expect(DEFAULT_CONFIG.decisions.perDecision['pr-risk']).toMatchObject({ escalateTo: 'test' });
    expect(DEFAULT_CONFIG.decisions.perDecision['model-tier']).toMatchObject({ chain: ['jev', 'local'] });
  });

  it('model tiers default to haiku / sonnet / opus and must be non-empty', () => {
    expect(DEFAULT_CONFIG.decisions.modelTiers).toEqual({ small: 'haiku', medium: 'sonnet', large: 'opus' });
    expect(() => loadConfig({ decisions: { modelTiers: { small: '' } } })).toThrow(ConfigError);
  });
});
