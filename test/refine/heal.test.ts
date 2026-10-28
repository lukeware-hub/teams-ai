import { describe, expect, it } from 'vitest';
import { RefineEvent } from '../../server/refine/events.js';
import { healRunsOf, kindOf, kindOfLegacyReason, nextHeal, type HealEvent, type HealFailure, type HealView } from '../../server/refine/heal.js';

const idle: HealView = { busy: false, started: false, staged: false, paused: false };
const failed = (kind: HealFailure['kind'], attempts: number): HealFailure => ({ kind, reason: kind, attempts });

describe('kinds of a failure', () => {
  it('reads the reasons the journal already holds, with the words of the real failures', () => {
    expect(kindOfLegacyReason('interrupted')).toBe('interrupted');
    expect(kindOfLegacyReason('A preparação foi interrompida quando o servidor reiniciou.')).toBe('interrupted');
    expect(kindOfLegacyReason('A revisão de briefing.md passou do tempo limite. Clique em Reavaliar.')).toBe('timeout');
    expect(kindOfLegacyReason('A sessão do Claude expirou. Entre de novo no Claude em Configurações e processe de novo.')).toBe('auth');
    expect(kindOfLegacyReason('A preparação do Spec Kit (/speckit-clarify de privacy-purpose-engine) não devolveu o resultado em formato válido.')).toBe('schema');
    expect(kindOfLegacyReason('O Spec Kit deixou critérios de aceite de fora em /speckit-plan de platform-local-foundation. Tente de novo.')).toBe('other');
  });

  it("keeps a failure's own kind when it has one, and gives any other agent kind to the owner", () => {
    expect(kindOf({ kind: 'schema', reason: 'x' })).toBe('schema');
    expect(kindOf({ kind: 'environment', reason: 'x' })).toBe('environment');
    expect(kindOf({ kind: 'code', reason: 'interrupted' })).toBe('other');
    expect(kindOf({ reason: 'interrupted' })).toBe('interrupted');
  });
});

describe('the next thing the driver does for a draft', () => {
  it('does nothing while the draft is busy, started, staged or paused', () => {
    const cycle = failed('interrupted', 1);
    for (const view of [{ busy: true }, { started: true }, { staged: true }, { paused: true }]) {
      expect(nextHeal({ ...idle, ...view, cycle })).toEqual({ do: 'idle' });
    }
  });

  it('starts a new cycle after an interruption, and pauses after three in a row', () => {
    expect(nextHeal({ ...idle, cycle: failed('interrupted', 1) })).toEqual({ do: 'evaluate' });
    expect(nextHeal({ ...idle, cycle: failed('interrupted', 2) })).toEqual({ do: 'evaluate' });
    expect(nextHeal({ ...idle, cycle: failed('interrupted', 3) })).toEqual({ do: 'pause', reason: 'interrupted' });
  });

  it('retries a schema or timeout failure once more, then pauses', () => {
    expect(nextHeal({ ...idle, cycle: failed('schema', 1) })).toEqual({ do: 'evaluate' });
    expect(nextHeal({ ...idle, cycle: failed('timeout', 2) })).toEqual({ do: 'pause', reason: 'timeout' });
  });

  it('pauses at once for a login that expired, and leaves a quota wait to the step', () => {
    expect(nextHeal({ ...idle, cycle: failed('auth', 1) })).toEqual({ do: 'pause', reason: 'auth' });
    expect(nextHeal({ ...idle, cycle: failed('quota', 1) })).toEqual({ do: 'idle' });
  });

  it('hands any other failure to the owner', () => {
    expect(nextHeal({ ...idle, cycle: failed('other', 1) })).toEqual({ do: 'pause', reason: 'other' });
  });

  it('heals a failed plan preparation by preparing again, and the cycle first when both failed', () => {
    expect(nextHeal({ ...idle, speckit: failed('interrupted', 1) })).toEqual({ do: 'prepare' });
    expect(nextHeal({ ...idle, cycle: failed('schema', 1), speckit: failed('interrupted', 1) })).toEqual({ do: 'evaluate' });
  });
});

describe('the failures in a row, read from the journal', () => {
  const event = (seq: number, type: string, data: Record<string, unknown> = {}): HealEvent => ({ seq, type, data });

  it('counts the failures of a kind in a row, and a success or a finished preparation ends the run', () => {
    const events = [
      event(1, RefineEvent.CycleFailed, { reason: 'interrupted' }),
      event(2, RefineEvent.CycleFailed, { reason: 'interrupted' }),
      event(3, RefineEvent.Evaluated),
      event(4, RefineEvent.CycleFailed, { kind: 'schema', reason: 'x' }),
      event(5, RefineEvent.SpeckitFailed, { reason: 'A preparação foi interrompida quando o servidor reiniciou.' }),
      event(6, RefineEvent.SpeckitDone),
    ];
    expect(healRunsOf(events)).toEqual({ cycle: { kind: 'schema', reason: 'x', attempts: 1 }, speckit: undefined, paused: false });
  });

  it('marks a draft paused until a failure comes after the pause, which is the owner acting', () => {
    const events = [event(1, RefineEvent.CycleFailed, { kind: 'auth', reason: 'x' }), event(2, RefineEvent.AutopilotPaused, { reason: 'auth' })];
    expect(healRunsOf(events).paused).toBe(true);
    expect(healRunsOf([...events, event(3, RefineEvent.CycleFailed, { kind: 'auth', reason: 'x' })]).paused).toBe(false);
  });

  it('counts an alternation of kinds in the same run, so it reaches the limit of the kind that comes last', () => {
    const timeout = event(1, RefineEvent.CycleFailed, { kind: 'timeout', reason: 'x' });
    const schema = event(2, RefineEvent.CycleFailed, { kind: 'schema', reason: 'x' });
    const interrupted = event(3, RefineEvent.CycleFailed, { kind: 'interrupted', reason: 'x' });
    expect(nextHeal({ ...idle, cycle: healRunsOf([timeout]).cycle })).toEqual({ do: 'evaluate' });
    expect(nextHeal({ ...idle, cycle: healRunsOf([timeout, schema]).cycle })).toEqual({ do: 'pause', reason: 'schema' });
    expect(nextHeal({ ...idle, cycle: healRunsOf([interrupted, timeout]).cycle })).toEqual({ do: 'pause', reason: 'timeout' });
  });

  it('takes the kinds the failures carry: a quota waits, an environment failure gets three tries, and a stopped run goes to the owner', () => {
    const failures = (kind: string, n: number) => Array.from({ length: n }, (_, i) => event(i + 1, RefineEvent.CycleFailed, { kind, reason: 'x' }));
    expect(nextHeal({ ...idle, cycle: healRunsOf(failures('quota', 1)).cycle })).toEqual({ do: 'idle' });
    expect(nextHeal({ ...idle, cycle: healRunsOf(failures('environment', 2)).cycle })).toEqual({ do: 'evaluate' });
    expect(nextHeal({ ...idle, cycle: healRunsOf(failures('environment', 3)).cycle })).toEqual({ do: 'pause', reason: 'environment' });
    expect(nextHeal({ ...idle, cycle: healRunsOf(failures('aborted', 1)).cycle })).toEqual({ do: 'pause', reason: 'other' });
  });
});
