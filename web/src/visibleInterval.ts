/** Calls `run` every `ms` while the tab is visible, and once when it becomes visible again; returns the stop function. */
export function visibleInterval(run: () => void, ms: number): () => void {
  const tick = () => {
    if (!document.hidden) run();
  };
  const timer = setInterval(tick, ms);
  document.addEventListener('visibilitychange', tick);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', tick);
  };
}
