import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePolling } from './usePolling.js';

const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
};

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility('visible');
});
afterEach(() => {
  vi.useRealTimers();
  setVisibility('visible');
});

describe('usePolling', () => {
  it('calls the tick every interval while the page is visible', async () => {
    const tick = vi.fn(() => Promise.resolve());
    renderHook(() => usePolling(tick, 5000));
    await act(async () => vi.advanceTimersByTime(5000));
    await act(async () => undefined);
    await act(async () => vi.advanceTimersByTime(5000));
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('stops while the page is hidden and calls once when it is visible again', async () => {
    const tick = vi.fn(() => Promise.resolve());
    renderHook(() => usePolling(tick, 5000));
    setVisibility('hidden');
    await act(async () => vi.advanceTimersByTime(20_000));
    expect(tick).toHaveBeenCalledTimes(0);
    setVisibility('visible');
    expect(tick).toHaveBeenCalledTimes(1);
    await act(async () => undefined);
    await act(async () => vi.advanceTimersByTime(5000));
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('does not start a tick while the previous one is still running', async () => {
    let finish: () => void = () => undefined;
    const tick = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    renderHook(() => usePolling(tick, 5000));
    await act(async () => vi.advanceTimersByTime(15_000));
    expect(tick).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    await act(async () => vi.advanceTimersByTime(5000));
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('stops when the page that uses it goes away', async () => {
    const tick = vi.fn(() => Promise.resolve());
    const { unmount } = renderHook(() => usePolling(tick, 5000));
    unmount();
    await act(async () => vi.advanceTimersByTime(20_000));
    expect(tick).toHaveBeenCalledTimes(0);
  });
});
