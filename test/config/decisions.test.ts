import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_CONFIG, loadConfig, resolveDecision } from '../../server/config/config.js';
import { DECISION_IDS } from '../../server/decide/types.js';

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
    // R11.5.7: question routing runs in shadow mode by default, so labelled data builds up.
    expect(DEFAULT_CONFIG.decisions.perDecision['question-routing']).toMatchObject({ enabled: true, chain: ['jev', 'local'], escalateTo: 'po' });
    // R11.5a item 3: only the criterion check acts until an eval measures the other two (human, 2026-10-12).
    expect(DEFAULT_CONFIG.decisions.perDecision['criterion-shared-deploy']).toMatchObject({ enabled: true, chain: ['jev', 'local'], escalateTo: 'po' });
    expect(DEFAULT_CONFIG.decisions.perDecision['spec-cited-sections']).toMatchObject({ enabled: false, chain: ['jev', 'local'], escalateTo: 'po' });
    expect(DEFAULT_CONFIG.decisions.perDecision['preplan-tech-decisions']).toMatchObject({ enabled: false, chain: ['jev', 'local'], escalateTo: 'sm' });
    // The answer step reads five documents for one question: Sonnet from the second cycle on, as the other refinement checklists.
    expect(DEFAULT_CONFIG.routing.laterCycleModels.answer).toBe('sonnet');
    // The floor measures itself from the labelled answers unless the config fixes a number or turns it off.
    expect(DEFAULT_CONFIG.decisions.autoAnswerFloor).toBe('measured');
    expect(loadConfig({ decisions: { autoAnswerFloor: 0.9 } }).decisions.autoAnswerFloor).toBe(0.9);
    expect(loadConfig({ decisions: { autoAnswerFloor: 'off' } }).decisions.autoAnswerFloor).toBe('off');
    expect(() => loadConfig({ decisions: { autoAnswerFloor: 1.5 } })).toThrow(ConfigError);
  });

  it('local backend is off by default and points at a llama.cpp server on this host', () => {
    expect(DEFAULT_CONFIG.decisions.local).toEqual({ enabled: false, baseUrl: 'http://127.0.0.1:8080', timeoutMs: 30_000, nProbs: 20 });
    expect(() => loadConfig({ decisions: { local: { baseUrl: 'not a url' } } })).toThrow(ConfigError);
  });

  it('model tiers default to haiku / sonnet / opus and must be non-empty', () => {
    expect(DEFAULT_CONFIG.decisions.modelTiers).toEqual({ small: 'haiku', medium: 'sonnet', large: 'opus' });
    expect(() => loadConfig({ decisions: { modelTiers: { small: '' } } })).toThrow(ConfigError);
  });

  it('the Docker config turns on only the refinement decisions Jev takes', () => {
    const cfg = loadConfig(JSON.parse(readFileSync(new URL('../../docker/config.json', import.meta.url), 'utf8')));
    const enabled = DECISION_IDS.filter((id) => resolveDecision(cfg, id).enabled);
    expect(enabled).toEqual(['gate1-readiness', 'question-dedup', 'history-contradiction', 'question-routing', 'patch-dedup', 'failure-cause', 'criterion-shared-deploy']);
    for (const id of enabled) expect(resolveDecision(cfg, id).chain).toEqual(['jev', 'local']);
  });
});
