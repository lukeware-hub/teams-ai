import { describe, expect, it } from 'vitest';
import { asTeamAlone, autoAcceptable, inTeamAlone } from '../../server/refine/team-rule.js';

describe('autoAcceptable: a move always waits for the owner', () => {
  it('refuses a move with or without the team alone, and keeps accepting a plain addition', () => {
    const move = { find: 'a', replace: 'a b', also: { file: 'briefing.md' as const, find: 'x', replace: 'x y' } };
    expect(autoAcceptable(move, false)).toBe(false);
    expect(autoAcceptable(move, true)).toBe(false);
    expect(autoAcceptable({ find: 'a', replace: 'a b' }, false)).toBe(true);
  });
});

describe('asTeamAlone: the team-alone mark reaches every step of the run and nothing else', () => {
  it('is seen by the steps the run awaits, however deep they are', async () => {
    const deep = async () => {
      await Promise.resolve();
      return inTeamAlone();
    };
    expect(await asTeamAlone(true, deep)).toBe(true);
  });

  it('is off outside the run, and inside a run that is not the team alone', async () => {
    expect(inTeamAlone()).toBe(false);
    expect(await asTeamAlone(false, async () => inTeamAlone())).toBe(false);
  });

  it('does not leak into work started by another caller while the run is still open', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const run = asTeamAlone(true, () => held.then(() => inTeamAlone()));
    expect(await asTeamAlone(false, async () => inTeamAlone())).toBe(false);
    release();
    expect(await run).toBe(true);
  });
});
