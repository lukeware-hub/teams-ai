import { isRateLimitRejected, type RateLimitInfo } from '../runner/stream-events.js';

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
 *
 * While paused, only `tick()` (time passing) closes the breaker: a healthy reading may belong to
 * a step that started before the pause. A pause is never shortened by a later reading.
 */
export class QuotaBreaker {
  private current: BreakerState = { status: 'closed' };
  private backoffIndex = 0;
  private readonly modelUntil = new Map<string, Date>();

  constructor(
    private readonly cfg: BreakerConfig = DEFAULT_BREAKER,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** The account changed: what the old account's quota said no longer applies. */
  reset(): void {
    this.current = { status: 'closed' };
    this.backoffIndex = 0;
    this.modelUntil.clear();
  }

  state(): BreakerState {
    return this.current;
  }

  canStart(): boolean {
    this.tick();
    return this.current.status === 'closed';
  }

  /** A model whose own quota is out until its reset (or the first probe time); the others keep working. */
  pauseModel(model: string, info: RateLimitInfo | null): void {
    const reset = info ? (this.exhaustedResets(info)[0] ?? this.topLevelReset(info)) : null;
    this.modelUntil.set(model, reset ?? new Date(this.clock().getTime() + this.cfg.probeBackoffMinutes[0]! * 60_000));
  }

  modelPaused(model: string): boolean {
    const until = this.modelUntil.get(model);
    if (until && this.clock() < until) return true;
    this.modelUntil.delete(model);
    return false;
  }

  tick(): void {
    if (this.current.status === 'paused' && this.clock() >= this.current.until) this.current = { status: 'closed' };
  }

  observe(info: RateLimitInfo | null): void {
    if (!info) return;
    this.tick();
    const exhausted = this.exhaustedResets(info);
    if (isRateLimitRejected(info.status)) {
      const reset = exhausted[0] ?? this.topLevelReset(info);
      this.pauseUntil(reset ?? this.nextProbe(), reset ? 'rejected' : 'probe');
      return;
    }
    if (exhausted.length > 0) {
      this.pauseUntil(exhausted[0]!, 'window');
      return;
    }
    if (this.current.status === 'closed') this.backoffIndex = 0;
  }

  onQuotaFailure(info: RateLimitInfo | null): void {
    this.tick();
    const reset = info ? (this.exhaustedResets(info)[0] ?? this.topLevelReset(info)) : null;
    this.pauseUntil(reset ?? this.nextProbe(), reset ? 'rejected' : 'probe');
  }

  /** Extends the pause; never shortens one already in place. */
  private pauseUntil(until: Date, reason: 'window' | 'rejected' | 'probe'): void {
    if (this.current.status === 'paused' && this.current.until > until) return;
    this.current = { status: 'paused', until, reason };
  }

  private nextProbe(): Date {
    const minutes = this.cfg.probeBackoffMinutes[Math.min(this.backoffIndex, this.cfg.probeBackoffMinutes.length - 1)]!;
    this.backoffIndex += 1;
    return new Date(this.clock().getTime() + minutes * 60_000);
  }

  private topLevelReset(info: RateLimitInfo): Date | null {
    return typeof info.resetsAt === 'number' ? new Date(info.resetsAt * 1000) : null;
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
