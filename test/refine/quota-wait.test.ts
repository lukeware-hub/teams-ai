import { describe, expect, it, vi } from 'vitest';
import { QuotaBreaker } from '../../server/budget/quota-breaker.js';
import { QUOTA_RETRIES, QUOTA_WAIT_MAX_MS, withQuotaWait } from '../../server/refine/quota-wait.js';

const T0 = new Date('2026-10-12T12:00:00Z');
const fail = (failure: string) => ({ ok: false, failure, errors: [failure], summary: {}, sandboxDisabled: false });
const good = { ok: true, value: 'done', summary: {} };
const reading = (resetsInMs: number, from = T0.getTime()) => ({ status: 'rejected', resetsAt: (from + resetsInMs) / 1000, fiveHourUtilization: null, fiveHourResetsAt: null, sevenDayUtilization: null, sevenDayResetsAt: null }) as never;

/** The inner agent arms the breaker on a quota failure, as `runAgentStep` does; the sleep moves the clock. */
function setup(outcomes: unknown[], resetsInMs = 60_000) {
  let now = T0.getTime();
  const clock = () => new Date(now);
  const breaker = new QuotaBreaker(undefined, clock);
  const queue = [...outcomes];
  const inner = vi.fn(async () => {
    const out = queue.shift() as { ok: boolean; failure?: string };
    if (!out.ok && out.failure === 'quota') breaker.onQuotaFailure(reading(resetsInMs, now));
    return out;
  });
  const sleeps: number[] = [];
  const sleep = vi.fn(async (ms: number) => {
    sleeps.push(ms);
    now += ms;
  });
  const agent = withQuotaWait(inner as never, breaker, { sleep, now: clock, log: () => undefined });
  return { agent: () => agent({} as never, {} as never), inner, sleeps, sleep, breaker };
}

describe('withQuotaWait', () => {
  it('waits for the reset after a quota failure and returns the repeated step', async () => {
    const t = setup([fail('quota'), good]);
    expect(await t.agent()).toBe(good);
    expect(t.inner).toHaveBeenCalledTimes(2);
    expect(t.sleeps).toEqual([60_000]);
  });

  it('waits before the first run when the breaker is already paused', async () => {
    const t = setup([good]);
    t.breaker.onQuotaFailure(reading(30_000));
    expect(await t.agent()).toBe(good);
    expect(t.sleeps).toEqual([30_000]);
    expect(t.inner).toHaveBeenCalledTimes(1);
  });

  it('answers at once, without sleeping or running the step, when a person is waiting and the quota is paused', async () => {
    const t = setup([good]);
    t.breaker.onQuotaFailure(reading(30_000));
    const out = (await withQuotaWait(t.inner as never, t.breaker, { sleep: t.sleep, now: () => T0, log: () => undefined })({} as never, { noQuotaWait: true } as never)) as { ok: boolean; failure: string };
    expect(out).toMatchObject({ ok: false, failure: 'quota' });
    expect(t.inner).not.toHaveBeenCalled();
    expect(t.sleep).not.toHaveBeenCalled();
  });

  it('does not repeat a step the quota rejected when a person is waiting', async () => {
    const t = setup([fail('quota'), good]);
    const out = (await withQuotaWait(t.inner as never, t.breaker, { sleep: t.sleep, now: () => T0, log: () => undefined })({} as never, { noQuotaWait: true } as never)) as { failure: string };
    expect(out.failure).toBe('quota');
    expect(t.inner).toHaveBeenCalledTimes(1);
    expect(t.sleep).not.toHaveBeenCalled();
  });

  it('returns the failure with the reset time when the reset is past the cap, with no sleep', async () => {
    const t = setup([fail('quota')], QUOTA_WAIT_MAX_MS + 60_000);
    const out = (await t.agent()) as { ok: boolean; errors: string[] };
    expect(out.ok).toBe(false);
    expect(out.errors.join(' ')).toContain('retry after 2026-10-12T17:31:00.000Z');
    expect(t.sleep).not.toHaveBeenCalled();
  });

  it('repeats a step at most QUOTA_RETRIES times', async () => {
    const t = setup(Array.from({ length: QUOTA_RETRIES + 2 }, () => fail('quota')));
    const out = (await t.agent()) as { ok: boolean };
    expect(out.ok).toBe(false);
    expect(t.inner).toHaveBeenCalledTimes(QUOTA_RETRIES + 1);
    expect(t.sleeps).toHaveLength(QUOTA_RETRIES);
  });

  it.each([['auth'], ['code'], ['schema']])('returns a %s failure at once, with no sleep', async (failure) => {
    const t = setup([fail(failure)]);
    expect(((await t.agent()) as { failure: string }).failure).toBe(failure);
    expect(t.inner).toHaveBeenCalledTimes(1);
    expect(t.sleep).not.toHaveBeenCalled();
  });

  it('never sleeps for a success', async () => {
    const t = setup([good]);
    expect(await t.agent()).toBe(good);
    expect(t.sleep).not.toHaveBeenCalled();
  });

  it('stops repeating once the cycle is aborted', async () => {
    const t = setup([fail('quota'), good]);
    const ctrl = new AbortController();
    ctrl.abort();
    const agent = withQuotaWait(t.inner as never, t.breaker, { sleep: async () => undefined, now: () => T0, log: () => undefined });
    const out = (await agent({} as never, { signal: ctrl.signal } as never)) as { ok: boolean };
    expect(out.ok).toBe(false);
    expect(t.inner).toHaveBeenCalledTimes(1);
  });
});
