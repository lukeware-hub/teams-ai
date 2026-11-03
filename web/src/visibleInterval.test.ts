import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { visibleInterval } from './visibleInterval.js';

const hide = (hidden: boolean) => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  hide(false);
  vi.useRealTimers();
});

describe('visibleInterval', () => {
  it('runs on every period while the tab is visible', () => {
    const run = vi.fn();
    const stop = visibleInterval(run, 1000);
    vi.advanceTimersByTime(3000);
    expect(run).toHaveBeenCalledTimes(3);
    stop();
  });

  it('skips the periods while the tab is hidden, and runs once when it shows again', () => {
    const run = vi.fn();
    const stop = visibleInterval(run, 1000);
    hide(true);
    vi.advanceTimersByTime(3000);
    expect(run).not.toHaveBeenCalled();
    hide(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(run).toHaveBeenCalledTimes(1);
    stop();
  });

  it('stops for good when stopped', () => {
    const run = vi.fn();
    visibleInterval(run, 1000)();
    vi.advanceTimersByTime(3000);
    expect(run).not.toHaveBeenCalled();
  });
});
