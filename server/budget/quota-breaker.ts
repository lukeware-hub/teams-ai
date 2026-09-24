import type { RateLimitInfo } from '../runner/stream-events.js';

export interface BreakerConfig {
  /** Window utilization at or above which the orchestrator stops starting steps. */
  pauseThreshold: number;
  probeBackoffMinutes: readonly number[];
}

export const DEFAULT_BREAKER: BreakerConfig = { pauseThreshold: 0.95, probeBackoffMinutes: [5, 10, 20, 40, 60] };

export type BreakerState = { status: 'closed' } | { status: 'paused'; until: Date; reason: 'window' | 'rejected' | 'probe' };

/**
 * Proactive quota circuit breaker (spec §8.7, findings row 7): every CLI run reports the
 * subscription windows, so the orchestrator pauses before a step would be rejected.
 */
export class QuotaBreaker {
  private current: BreakerState = { status: 'closed' };
  private backoffIndex = 0;

  constructor(
    private readonly cfg: BreakerConfig = DEFAULT_BREAKER,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  state(): BreakerState {
    return this.current;
  }

  canStart(): boolean {
    this.tick();
    return this.current.status === 'closed';
  }

  tick(): void {
    if (this.current.status === 'paused' && this.clock() >= this.current.until) this.current = { status: 'closed' };
  }

  observe(info: RateLimitInfo | null): void {
    if (!info) return;
    const exhausted = this.exhaustedResets(info);
    if (info.status !== 'allowed') {
      const reset = exhausted[0] ?? this.knownResets(info)[0];
      this.pauseUntil(reset ?? this.nextProbe(), reset ? 'rejected' : 'probe');
      return;
    }
    if (exhausted.length > 0) {
      this.pauseUntil(exhausted[0]!, 'window');
      return;
    }
    // Healthy reading: the API just accepted a request, so any pause is over and the probe ladder resets.
    this.backoffIndex = 0;
    this.current = { status: 'closed' };
  }

  onQuotaFailure(info: RateLimitInfo | null): void {
    const resets = info ? this.knownResets(info) : [];
    if (resets.length > 0) {
      this.pauseUntil(resets[0]!, 'rejected');
      return;
    }
    this.pauseUntil(this.nextProbe(), 'probe');
  }

  private pauseUntil(until: Date, reason: 'window' | 'rejected' | 'probe'): void {
    this.current = { status: 'paused', until, reason };
  }

  private nextProbe(): Date {
    const minutes = this.cfg.probeBackoffMinutes[Math.min(this.backoffIndex, this.cfg.probeBackoffMinutes.length - 1)]!;
    this.backoffIndex += 1;
    return new Date(this.clock().getTime() + minutes * 60_000);
  }

  private knownResets(info: RateLimitInfo): Date[] {
    return [info.fiveHourResetsAt, info.sevenDayResetsAt]
      .filter((t): t is number => typeof t === 'number')
      .map((t) => new Date(t * 1000))
      .sort((a, b) => a.getTime() - b.getTime());
  }

  private exhaustedResets(info: RateLimitInfo): Date[] {
    const windows: Array<[number | null, number | null]> = [
      [info.fiveHourUtilization, info.fiveHourResetsAt],
      [info.sevenDayUtilization, info.sevenDayResetsAt],
    ];
    return windows
      .filter(([u, r]) => u !== null && r !== null && u >= this.cfg.pauseThreshold)
      .map(([, r]) => new Date((r as number) * 1000))
      .sort((a, b) => a.getTime() - b.getTime());
  }
}
