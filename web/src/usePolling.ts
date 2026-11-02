import { useEffect, useRef } from 'react';

/**
 * Runs `tick` every `ms` while the page is visible, and once more when it becomes visible again.
 * A tick still running is not started twice; a failed tick is left to the caller, which keeps what it shows.
 */
export function usePolling(tick: () => Promise<unknown>, ms: number): void {
  const latest = useRef(tick);
  latest.current = tick;
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    let busy = false;
    const run = () => {
      if (busy) return;
      busy = true;
      latest.current().catch(() => undefined).finally(() => {
        busy = false;
      });
    };
    const start = () => {
      if (timer === undefined) timer = setInterval(run, ms);
    };
    const stop = () => {
      clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        run();
        start();
      } else stop();
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [ms]);
}
