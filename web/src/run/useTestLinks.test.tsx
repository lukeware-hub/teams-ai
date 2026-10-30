import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runApi, type StoredEvent, type TestLink } from '../api.js';
import { useTestLinks } from './useTestLinks.js';

const link: TestLink = { url: 'https://github.com/acme/hello-app/blob/abc/src/a.ts#L1', path: 'src/a.ts', line: 1 };

/** A unit-test gate result whose rows carry the given ids, each with an acceptance criterion. */
const gate = (...ids: string[]): StoredEvent => ({
  seq: 1,
  at: '',
  runId: 'r',
  specHash: '',
  type: 'GATE_PASSED',
  kind: 'fact',
  data: { junit: ids.map((id) => ({ id, name: id, classname: 'c', status: 'passed', acIds: ['AC-001'] })) },
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useTestLinks', () => {
  it('asks nothing while no acceptance test has reported', () => {
    const spy = vi.spyOn(runApi, 'testLinks').mockResolvedValue({});
    renderHook(() => useTestLinks('run-1', [], false));
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('asks once for a burst of new results, a second after the last one', () => {
    const spy = vi.spyOn(runApi, 'testLinks').mockResolvedValue({});
    const { rerender } = renderHook(({ events }) => useTestLinks('run-1', events, false), { initialProps: { events: [gate('a')] } });
    rerender({ events: [gate('a'), gate('b')] });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    rerender({ events: [gate('a'), gate('b'), gate('c')] });
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(spy).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('run-1');
  });

  it('asks at once when the run has ended', () => {
    const spy = vi.spyOn(runApi, 'testLinks').mockResolvedValue({});
    renderHook(() => useTestLinks('run-1', [gate('a')], true));
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('keeps the answer of the last request and ignores an earlier one that arrives late', async () => {
    let answerFirst: (links: Record<string, TestLink>) => void = () => undefined;
    const spy = vi
      .spyOn(runApi, 'testLinks')
      .mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve)))
      .mockResolvedValueOnce({ b: link });
    const { result, rerender } = renderHook(({ events }) => useTestLinks('run-1', events, false), { initialProps: { events: [gate('a')] } });
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    rerender({ events: [gate('a'), gate('b')] });
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current).toEqual({ b: link });
    await act(async () => {
      answerFirst({ a: link });
    });
    expect(result.current).toEqual({ b: link });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('keeps the links it has when a request fails', async () => {
    const spy = vi.spyOn(runApi, 'testLinks').mockResolvedValueOnce({ a: link }).mockRejectedValueOnce(new Error('offline'));
    const { result, rerender } = renderHook(({ events }) => useTestLinks('run-1', events, false), { initialProps: { events: [gate('a')] } });
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current).toEqual({ a: link });
    rerender({ events: [gate('a'), gate('b')] });
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual({ a: link });
  });

  it('stops waiting when unmounted', () => {
    const spy = vi.spyOn(runApi, 'testLinks').mockResolvedValue({});
    const { unmount } = renderHook(() => useTestLinks('run-1', [gate('a')], false));
    unmount();
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(spy).not.toHaveBeenCalled();
  });
});
