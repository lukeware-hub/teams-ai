import { describe, expect, it } from 'vitest';
import { elapsedText } from './ProcessingBanner.js';

describe('elapsedText', () => {
  const since = '2026-10-21T10:00:00Z';

  it('counts minutes and seconds from the start of the evaluation', () => {
    expect(elapsedText(since, Date.parse('2026-10-21T10:03:05Z'))).toBe('03:05');
  });

  it('shows the hours from an hour on, and never a negative time', () => {
    expect(elapsedText(since, Date.parse('2026-10-21T11:02:03Z'))).toBe('1:02:03');
    expect(elapsedText(since, Date.parse('2026-10-21T09:59:00Z'))).toBe('00:00');
  });
});
