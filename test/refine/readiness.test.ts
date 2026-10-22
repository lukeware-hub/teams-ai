import { describe, expect, it } from 'vitest';
import { UNSCORED, jevVerdict, percentOf, scoresDocs, type Readiness } from '../../server/refine/readiness.js';

const scored = (average: number, over: Partial<Readiness> = {}): Readiness => ({ ...UNSCORED, available: true, average, cycle: 1, outdated: false, ...over });
const unanswered: Readiness = { ...UNSCORED, cycle: 1, outdated: false };

describe('percentOf', () => {
  it('rounds to a whole percent, so 79.6% is 80 and counts as ready', () => {
    expect(percentOf(0.796)).toBe(80);
    expect(percentOf(0.794)).toBe(79);
  });
});

describe('jevVerdict', () => {
  it('has no verdict before any score', () => {
    expect(jevVerdict(undefined)).toBe('none');
  });

  it('reports a confidential project as skipped, whatever the score', () => {
    expect(jevVerdict({ ...unanswered, skipped: 'confidential' })).toBe('skipped');
  });

  it('reports a score the Jev did not give as unavailable', () => {
    expect(jevVerdict(unanswered)).toBe('unavailable');
  });

  it('reports a score older than the last document change as outdated, even when high', () => {
    expect(jevVerdict(scored(0.95, { outdated: true }))).toBe('outdated');
  });

  it('splits a current score at the ready percentage', () => {
    expect(jevVerdict(scored(0.79))).toBe('below');
    expect(jevVerdict(scored(0.8))).toBe('ready');
  });
});

describe('scoresDocs', () => {
  it('scores a new project and a backlog only', () => {
    expect(scoresDocs('new-project')).toBe(true);
    expect(scoresDocs('backlog')).toBe(true);
    expect(scoresDocs('new-spec')).toBe(false);
    expect(scoresDocs('continue')).toBe(false);
    expect(scoresDocs(null)).toBe(false);
  });
});
