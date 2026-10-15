import { describe, expect, it } from 'vitest';
import { effortFor, fallbackModel } from '../../server/runner/model-policy.js';

describe('effortFor', () => {
  it('holds Opus at low whatever was asked', () => {
    for (const e of [undefined, 'low', 'high', 'max'] as const) expect(effortFor('opus', e)).toBe('low');
  });

  it('lets Sonnet reason up to high and never above, low when nothing was asked', () => {
    expect(effortFor('sonnet', undefined)).toBe('low');
    expect(effortFor('sonnet', 'low')).toBe('low');
    expect(effortFor('sonnet', 'medium')).toBe('medium');
    expect(effortFor('sonnet', 'max')).toBe('high');
  });

  it('holds Haiku at low whatever was asked', () => {
    for (const e of [undefined, 'low', 'high', 'max'] as const) expect(effortFor('haiku', e)).toBe('low');
  });

  it('recognises a pinned model id and leaves an unknown model alone', () => {
    expect(effortFor('claude-opus-5-5', 'high')).toBe('low');
    expect(effortFor('claude-haiku-5-5', 'high')).toBe('low');
    expect(effortFor('other-model', 'max')).toBe('max');
    expect(effortFor('other-model', undefined)).toBe('low');
  });
});

describe('fallbackModel', () => {
  it('moves only Opus down, to Sonnet', () => {
    expect(fallbackModel('opus')).toBe('claude-sonnet-5-5');
    expect(fallbackModel('claude-opus-5-5')).toBe('claude-sonnet-5-5');
    expect(fallbackModel('sonnet')).toBeUndefined();
    expect(fallbackModel('haiku')).toBeUndefined();
  });
});
