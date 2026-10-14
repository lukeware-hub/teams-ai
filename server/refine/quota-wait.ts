import type { QuotaBreaker } from '../budget/quota-breaker.js';
import { EMPTY_SUMMARY } from '../runner/step.js';
import type { RunAgent } from './cycle.js';

/** The 5 hour usage window plus a margin; a longer reset (the 7 day window) is left to the human. */
export const QUOTA_WAIT_MAX_MS = 5.5 * 3_600_000;
export const QUOTA_RETRIES = 3;

export interface QuotaWaitIo {
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  now(): Date;
  log(line: string): void;
}

/** Sleeps for `ms`, or less when the signal aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Waits for the quota breaker, and repeats a step the quota rejected once the window resets. */
export function withQuotaWait(inner: RunAgent, breaker: QuotaBreaker, io: QuotaWaitIo): RunAgent {
  const remaining = () => {
    breaker.tick();
    const s = breaker.state();
    return s.status === 'paused' ? Math.max(0, s.until.getTime() - io.now().getTime()) : 0;
  };
  return async (req, ctx) => {
    for (let retries = 0; ; retries++) {
      const wait = remaining();
      // A person is waiting at the screen: a quota the CLI rejected answers at once instead of holding the question for hours.
      // A window merely close to its limit (the CLI still says allowed) does not stop a small step: only a real rejection does.
      if (wait > 0 && ctx.noQuotaWait && breaker.state().status === 'paused' && (breaker.state() as { reason: string }).reason !== 'window') return { ok: false, failure: 'quota', errors: ['the Claude quota is paused'], summary: EMPTY_SUMMARY, sandboxDisabled: false };
      if (wait > 0 && wait <= QUOTA_WAIT_MAX_MS && !ctx.noQuotaWait) {
        io.log(`refinement waits ${Math.round(wait / 1000)}s for the Claude quota`);
        await io.sleep(wait, ctx.signal);
      }
      const out = await inner(req, ctx);
      if (out.ok || out.failure !== 'quota' || ctx.noQuotaWait) return out;
      const next = remaining();
      if (next > QUOTA_WAIT_MAX_MS) {
        const s = breaker.state();
        const until = s.status === 'paused' ? ` retry after ${s.until.toISOString()}` : '';
        return { ...out, errors: [...out.errors, `the Claude quota window resets too late to wait;${until}`] };
      }
      if (retries >= QUOTA_RETRIES || ctx.signal?.aborted) return out;
    }
  };
}
