import { describe, expect, it } from 'vitest';
import { DEFAULT_BREAKER, QuotaBreaker } from '../../server/budget/quota-breaker.js';
import type { RateLimitInfo } from '../../server/runner/stream-events.js';

const T0 = new Date('2026-09-24T10:00:00.000Z');
const epoch = (d: Date) => Math.floor(d.getTime() / 1000);
const info = (over: Partial<RateLimitInfo> = {}): RateLimitInfo => ({
  status: 'allowed',
  fiveHourUtilization: 0.1,
  fiveHourResetsAt: epoch(new Date('2026-09-24T12:00:00.000Z')),
  sevenDayUtilization: 0.64,
  sevenDayResetsAt: epoch(new Date('2026-09-26T00:00:00.000Z')),
  ...over,
});

function breaker(times: Date[]) {
  let i = 0;
  const clock = () => times[Math.min(i++, times.length - 1)]!;
  return new QuotaBreaker(DEFAULT_BREAKER, clock);
}

describe('QuotaBreaker', () => {
  it('stays closed while every window is under the threshold', () => {
    const b = breaker([T0]);
    b.observe(info());
    expect(b.canStart()).toBe(true);
    expect(b.state()).toEqual({ status: 'closed' });
  });

  it('pauses until the reset of a window at or above the threshold', () => {
    const b = breaker([T0, T0]);
    b.observe(info({ fiveHourUtilization: 0.97 }));
    expect(b.canStart()).toBe(false);
    expect(b.state()).toEqual({ status: 'paused', until: new Date('2026-09-24T12:00:00.000Z'), reason: 'window' });
  });

  it('pauses on a rejected status even with low utilization', () => {
    const b = breaker([T0, T0]);
    b.observe(info({ status: 'rejected', fiveHourUtilization: 0.2 }));
    expect(b.state()).toMatchObject({ status: 'paused', reason: 'rejected' });
  });

  it('closes again once the reset time has passed', () => {
    const b = breaker([T0, T0, new Date('2026-09-24T12:00:01.000Z')]);
    b.observe(info({ fiveHourUtilization: 1 }));
    expect(b.canStart()).toBe(false);
    b.tick();
    expect(b.canStart()).toBe(true);
  });

  it('uses backoff probes when a quota failure carries no reset time', () => {
    const b = breaker([T0, T0, T0, T0]);
    b.onQuotaFailure(null);
    expect(b.state()).toEqual({ status: 'paused', until: new Date('2026-09-24T10:05:00.000Z'), reason: 'probe' });
    b.onQuotaFailure(null);
    expect(b.state()).toEqual({ status: 'paused', until: new Date('2026-09-24T10:10:00.000Z'), reason: 'probe' });
  });

  it('caps the backoff at the last value and resets after a healthy observation', () => {
    const b = breaker(Array(10).fill(T0));
    for (let i = 0; i < 7; i++) b.onQuotaFailure(null);
    expect(b.state()).toEqual({ status: 'paused', until: new Date('2026-09-24T11:00:00.000Z'), reason: 'probe' });
    b.observe(info());
    expect(b.canStart()).toBe(true);
    b.onQuotaFailure(null);
    expect(b.state()).toMatchObject({ until: new Date('2026-09-24T10:05:00.000Z') });
  });

  it('prefers the reset time when a quota failure carries one', () => {
    const b = breaker([T0, T0]);
    b.onQuotaFailure(info({ status: 'rejected' }));
    expect(b.state()).toEqual({ status: 'paused', until: new Date('2026-09-24T12:00:00.000Z'), reason: 'rejected' });
  });

  it('picks the earliest reset among exhausted windows', () => {
    const b = breaker([T0, T0]);
    b.observe(info({ fiveHourUtilization: 0.99, sevenDayUtilization: 0.99 }));
    expect(b.state()).toMatchObject({ until: new Date('2026-09-24T12:00:00.000Z') });
  });
});
