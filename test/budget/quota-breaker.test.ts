import { describe, expect, it } from 'vitest';
import { DEFAULT_BREAKER, QuotaBreaker } from '../../server/budget/quota-breaker.js';
import type { RateLimitInfo } from '../../server/runner/stream-events.js';

const T0 = new Date('2026-09-24T10:00:00.000Z');
const epoch = (d: Date) => Math.floor(d.getTime() / 1000);
const FIVE_H_RESET = new Date('2026-09-24T12:00:00.000Z');
const SEVEN_D_RESET = new Date('2026-09-26T00:00:00.000Z');
const info = (over: Partial<RateLimitInfo> = {}): RateLimitInfo => ({
  status: 'allowed',
  resetsAt: epoch(FIVE_H_RESET),
  fiveHourUtilization: 0.1,
  fiveHourResetsAt: epoch(FIVE_H_RESET),
  sevenDayUtilization: 0.64,
  sevenDayResetsAt: epoch(SEVEN_D_RESET),
  ...over,
});

/** A settable fake clock: the breaker may read it more than once per call. */
function breaker(start = T0) {
  const clock = { now: start };
  return { b: new QuotaBreaker(DEFAULT_BREAKER, () => clock.now), clock };
}

describe('QuotaBreaker', () => {
  it('stays closed while every window is under the threshold', () => {
    const { b } = breaker();
    b.observe(info());
    expect(b.canStart()).toBe(true);
    expect(b.state()).toEqual({ status: 'closed' });
  });

  it('pauses until the reset of a window at or above the threshold', () => {
    const { b } = breaker();
    b.observe(info({ fiveHourUtilization: 0.97 }));
    expect(b.canStart()).toBe(false);
    expect(b.state()).toEqual({ status: 'paused', until: FIVE_H_RESET, reason: 'window' });
  });

  it('does not pause on allowed_warning while the windows stay under the threshold', () => {
    const { b } = breaker();
    b.observe(info({ status: 'allowed_warning', fiveHourUtilization: 0.8 }));
    expect(b.canStart()).toBe(true);
    expect(b.state()).toEqual({ status: 'closed' });
  });

  it('pauses on a rejected status even with low utilization, using the top-level reset', () => {
    const { b } = breaker();
    b.observe(info({ status: 'rejected', fiveHourUtilization: 0.2 }));
    expect(b.state()).toEqual({ status: 'paused', until: FIVE_H_RESET, reason: 'rejected' });
  });

  it('closes again once the reset time has passed', () => {
    const { b, clock } = breaker();
    b.observe(info({ fiveHourUtilization: 1 }));
    expect(b.canStart()).toBe(false);
    clock.now = new Date('2026-09-24T12:00:01.000Z');
    expect(b.canStart()).toBe(true);
  });

  it('ignores a healthy reading while paused (it may come from a step that started earlier)', () => {
    const { b } = breaker();
    b.observe(info({ status: 'rejected' }));
    b.observe(info({ status: 'allowed', fiveHourUtilization: 0.6 }));
    expect(b.canStart()).toBe(false);
    expect(b.state()).toMatchObject({ status: 'paused', reason: 'rejected' });
  });

  it('uses backoff probes when a quota failure carries no reset time', () => {
    const { b, clock } = breaker();
    b.onQuotaFailure(null);
    expect(b.state()).toEqual({ status: 'paused', until: new Date('2026-09-24T10:05:00.000Z'), reason: 'probe' });
    clock.now = new Date('2026-09-24T10:05:00.000Z');
    b.onQuotaFailure(null);
    expect(b.state()).toEqual({ status: 'paused', until: new Date('2026-09-24T10:15:00.000Z'), reason: 'probe' });
  });

  it('caps the backoff at the last value and resets the ladder after the pause ends with a healthy reading', () => {
    const { b, clock } = breaker();
    for (let i = 0; i < 7; i++) {
      const s = b.state();
      if (s.status === 'paused') clock.now = s.until; // each probe fails right when it fires
      b.onQuotaFailure(null);
    }
    // 5 + 10 + 20 + 40 + 60 + 60 + 60 minutes after T0
    expect(b.state()).toEqual({ status: 'paused', until: new Date('2026-09-24T14:15:00.000Z'), reason: 'probe' });
    clock.now = new Date('2026-09-24T14:15:00.000Z');
    b.observe(info());
    expect(b.canStart()).toBe(true);
    b.onQuotaFailure(null);
    expect(b.state()).toMatchObject({ until: new Date('2026-09-24T14:20:00.000Z') });
  });

  it('on a quota failure prefers the exhausted window reset over an earlier healthy one', () => {
    const { b } = breaker();
    b.onQuotaFailure(info({ status: 'rejected', sevenDayUtilization: 1, fiveHourUtilization: 0.3 }));
    expect(b.state()).toEqual({ status: 'paused', until: SEVEN_D_RESET, reason: 'rejected' });
  });

  it('on a quota failure falls back to the top-level resetsAt when no window is exhausted', () => {
    const { b } = breaker();
    b.onQuotaFailure(info({ status: 'rejected', resetsAt: epoch(new Date('2026-09-24T10:30:00.000Z')) }));
    expect(b.state()).toEqual({ status: 'paused', until: new Date('2026-09-24T10:30:00.000Z'), reason: 'rejected' });
  });

  it('does not shorten an existing longer pause with a later quota failure', () => {
    const { b } = breaker();
    b.observe(info({ sevenDayUtilization: 1 }));
    expect(b.state()).toMatchObject({ until: SEVEN_D_RESET });
    b.onQuotaFailure(info({ status: 'rejected', sevenDayUtilization: 0.5 }));
    expect(b.state()).toMatchObject({ until: SEVEN_D_RESET });
  });

  it('picks the earliest reset among exhausted windows', () => {
    const { b } = breaker();
    b.observe(info({ fiveHourUtilization: 0.99, sevenDayUtilization: 0.99 }));
    expect(b.state()).toMatchObject({ until: FIVE_H_RESET });
  });

  it('pauses one model until its reset without closing the breaker for the others', () => {
    const { b, clock } = breaker();
    b.pauseModel('opus', info({ status: 'rejected' }));
    expect(b.modelPaused('opus')).toBe(true);
    expect(b.modelPaused('sonnet')).toBe(false);
    expect(b.canStart()).toBe(true);
    clock.now = new Date(FIVE_H_RESET.getTime() + 1000);
    expect(b.modelPaused('opus')).toBe(false);
  });

  it('probes a model again after the first backoff when no reset is known', () => {
    const { b, clock } = breaker();
    b.pauseModel('opus', null);
    clock.now = new Date(T0.getTime() + 4 * 60_000);
    expect(b.modelPaused('opus')).toBe(true);
    clock.now = new Date(T0.getTime() + 5 * 60_000);
    expect(b.modelPaused('opus')).toBe(false);
  });
});
