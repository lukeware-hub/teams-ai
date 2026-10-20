import { describe, expect, it } from 'vitest';
import { UNSCORED, jevBlocksStart, jevVerdict, percentOf, scoresDocs, type Readiness } from '../../server/refine/readiness.js';

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

describe('jevBlocksStart', () => {
  it('blocks a backlog start that is below, outdated or unavailable', () => {
    expect(jevBlocksStart(true, scored(0.79))).toBe(true);
    expect(jevBlocksStart(true, scored(0.95, { outdated: true }))).toBe(true);
    expect(jevBlocksStart(true, unanswered)).toBe(true);
  });

  it('lets a backlog start through at the ready percentage, without a score, and for a confidential project', () => {
    expect(jevBlocksStart(true, scored(0.8))).toBe(false);
    expect(jevBlocksStart(true, undefined)).toBe(false);
    expect(jevBlocksStart(true, { ...unanswered, skipped: 'confidential' })).toBe(false);
  });

  it('never blocks a start that has no backlog', () => {
    expect(jevBlocksStart(false, scored(0.1))).toBe(false);
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
