import { describe, expect, it } from 'vitest';
import { effortFor } from '../../server/runner/model-policy.js';

describe('effortFor', () => {
  it('holds Opus at low whatever was asked', () => {
    for (const e of [undefined, 'low', 'high', 'max'] as const) expect(effortFor('opus', e, 'low')).toBe('low');
  });

  it('lets Sonnet reason up to high and never above, the fallback when nothing was asked', () => {
    expect(effortFor('sonnet', undefined, 'low')).toBe('low');
    expect(effortFor('sonnet', 'low', 'low')).toBe('low');
    expect(effortFor('sonnet', 'medium', 'low')).toBe('medium');
    expect(effortFor('sonnet', 'max', 'low')).toBe('high');
  });

  it('holds Haiku at low whatever was asked', () => {
    for (const e of [undefined, 'low', 'high', 'max'] as const) expect(effortFor('haiku', e, 'low')).toBe('low');
  });

  it('recognises a pinned model id and leaves an unknown model alone', () => {
    expect(effortFor('claude-opus-5-5', 'high', 'low')).toBe('low');
    expect(effortFor('claude-haiku-5-5', 'high', 'low')).toBe('low');
    expect(effortFor('other-model', 'max', 'low')).toBe('max');
    expect(effortFor('other-model', undefined, 'low')).toBe('low');
  });

  it('holds a model to the cap of its family when one is given, and keeps the rules without one', () => {
    expect(effortFor('sonnet', 'max', 'low', { haiku: 'low', sonnet: 'medium', opus: 'low' })).toBe('medium');
    expect(effortFor('opus', 'max', 'low', { haiku: 'low', sonnet: 'high', opus: 'max' })).toBe('max');
    expect(effortFor('sonnet', 'max', 'low')).toBe('high');
  });

  it('takes the fallback the caller gives when nothing was asked, held to the cap of its family', () => {
    expect(effortFor('sonnet', undefined, 'medium')).toBe('medium');
    expect(effortFor('sonnet', undefined, 'max')).toBe('high');
    expect(effortFor('haiku', undefined, 'medium')).toBe('low');
    expect(effortFor('other-model', undefined, 'max')).toBe('max');
  });
});
