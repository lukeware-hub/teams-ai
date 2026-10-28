import { describe, expect, it } from 'vitest';
import { RefineHealer, type HealTarget } from '../../server/refine/heal-driver.js';
import type { HealView } from '../../server/refine/heal.js';
import { BusyError, ConflictError } from '../../server/refine/session.js';

const idle: HealView = { busy: false, started: false, staged: false, paused: false };

/** A target whose view and calls are scripted, and whose calls go to the log. */
function target(key: string, view: HealView, log: string[], over: Partial<HealTarget> = {}): HealTarget {
  return {
    key,
    view: () => view,
    evaluate: async () => void log.push(`${key}:evaluate`),
    prepare: async () => void log.push(`${key}:prepare`),
    pause: async (reason) => void log.push(`${key}:pause:${reason}`),
    ...over,
  };
}

const interrupted: HealView = { ...idle, cycle: { kind: 'interrupted', reason: 'interrupted', attempts: 1 } };

describe('the heal driver', () => {
  it('does nothing while the flag is off, and calls nothing on any draft', async () => {
    const log: string[] = [];
    const healer = new RefineHealer(async () => [target('a', interrupted, log)], async () => false, () => undefined);
    await healer.tick();
    expect(log).toEqual([]);
  });

  it('starts a new cycle for a draft a restart interrupted, and pauses one that keeps failing', async () => {
    const log: string[] = [];
    const again = { ...idle, cycle: { kind: 'interrupted' as const, reason: 'interrupted', attempts: 3 } };
    const healer = new RefineHealer(async () => [target('a', interrupted, log), target('b', again, log)], async () => true, () => undefined);
    await healer.tick();
    expect(log).toEqual(['a:evaluate', 'b:pause:interrupted']);
  });

  it('prepares the plans a restart cut, and leaves a paused draft alone', async () => {
    const log: string[] = [];
    const speckit = { ...idle, speckit: { kind: 'interrupted' as const, reason: 'x', attempts: 1 } };
    const healer = new RefineHealer(async () => [target('a', speckit, log), target('b', { ...interrupted, paused: true }, log)], async () => true, () => undefined);
    await healer.tick();
    expect(log).toEqual(['a:prepare']);
  });

  it('runs one tick at a time: a tick that starts while another runs does nothing', async () => {
    const log: string[] = [];
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const healer = new RefineHealer(async () => [target('a', interrupted, log, { evaluate: async () => { log.push('a:evaluate'); await slow; } })], async () => true, () => undefined);
    const first = healer.tick();
    await healer.tick();
    release();
    await first;
    expect(log).toEqual(['a:evaluate']);
  });

  it('leaves a draft a run holds for the next tick, without reporting it as a failure', async () => {
    const log: string[] = [];
    const errors: string[] = [];
    const busy = target('a', interrupted, log, { evaluate: async () => { throw new BusyError('busy'); } });
    const healer = new RefineHealer(async () => [busy, target('b', interrupted, log)], async () => true, (key) => errors.push(key));
    await healer.tick();
    expect(errors).toEqual([]);
    expect(log).toEqual(['b:evaluate']);
  });

  it('reports any other failure, pauses that draft for the owner, and goes on with the other drafts', async () => {
    const log: string[] = [];
    const errors: string[] = [];
    const broken = target('a', interrupted, log, { evaluate: async () => { throw new Error('disk full'); } });
    const healer = new RefineHealer(async () => [broken, target('b', interrupted, log)], async () => true, (key) => errors.push(key));
    await healer.tick();
    expect(errors).toEqual(['a']);
    expect(log).toEqual(['a:pause:disk full', 'b:evaluate']);
  });

  it('pauses a draft whose refusal is not a busy hold, with the refusal as the reason', async () => {
    const log: string[] = [];
    const errors: string[] = [];
    const refused = target('a', interrupted, log, { evaluate: async () => { throw new ConflictError('o refinamento já tem 6 rodadas nesta etapa'); } });
    const healer = new RefineHealer(async () => [refused], async () => true, (key) => errors.push(key));
    await healer.tick();
    expect(errors).toEqual(['a']);
    expect(log).toEqual(['a:pause:o refinamento já tem 6 rodadas nesta etapa']);
  });

  it('reports a pause that fails too, and goes on with the other drafts', async () => {
    const log: string[] = [];
    const errors: string[] = [];
    const stuck = target('a', interrupted, log, { evaluate: async () => { throw new Error('disk full'); }, pause: async () => { throw new Error('journal closed'); } });
    const healer = new RefineHealer(async () => [stuck, target('b', interrupted, log)], async () => true, (key, err) => errors.push(`${key}: ${(err as Error).message}`));
    await healer.tick();
    expect(errors).toEqual(['a: disk full', 'a: journal closed']);
    expect(log).toEqual(['b:evaluate']);
  });
});
