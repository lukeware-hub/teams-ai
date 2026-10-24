import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useJournal, useSse } from './useSse.js';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static CLOSED = 2;
  closed = false;
  readyState = 0;
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  listeners: Record<string, (e: MessageEvent) => void> = {};
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, cb: (e: MessageEvent) => void) {
    this.listeners[name] = cb;
  }
  close() {
    this.closed = true;
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useSse', () => {
  it('opens the EventSource, applies events and closes on unmount', async () => {
    const { result, unmount } = renderHook(() => useSse('/api/x/events'));
    expect(FakeEventSource.instances).toHaveLength(1);
    const es = FakeEventSource.instances[0]!;
    expect(es.url).toBe('/api/x/events');
    es.listeners.state!({ data: JSON.stringify({ name: 'awaiting-browser' }) } as MessageEvent);
    es.listeners.output!({ data: JSON.stringify('hello') } as MessageEvent);
    await waitFor(() => expect(result.current.state.name).toBe('awaiting-browser'));
    expect(result.current.output).toBe('hello');
    unmount();
    expect(es.closed).toBe(true);
  });
  it('does not open a stream without a url', () => {
    renderHook(() => useSse(null));
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});

describe('useJournal reconnection (audit M5)', () => {
  it('keeps the EventSource open on a server reconnect, drops replayed seqs, and closes only on end', async () => {
    const { result } = renderHook(() => useJournal('/api/x/events'));
    expect(FakeEventSource.instances).toHaveLength(1);
    const es = FakeEventSource.instances[0]!;
    const ev = (seq: number) => ({ data: JSON.stringify({ seq, type: 'X' }) }) as MessageEvent;
    es.listeners.journal!(ev(1));
    // The browser resumes with Last-Event-ID and the server may replay: seq 1 is not applied twice.
    es.listeners.journal!(ev(1));
    es.listeners.journal!(ev(2));
    await waitFor(() => expect(result.current.events.map((e) => e.seq)).toEqual([1, 2]));
    expect(es.closed).toBe(false);
    es.listeners.end!({} as MessageEvent);
    await waitFor(() => expect(result.current.ended).toBe(true));
    expect(es.closed).toBe(true);
  });
  it('renders a replay of many events in a few batches, not once per event, and applies the batch before the end', async () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useJournal('/api/x/events');
    });
    expect(FakeEventSource.instances).toHaveLength(1);
    const es = FakeEventSource.instances[0]!;
    const before = renders;
    // The browser delivers each server-sent message in its own task.
    for (let seq = 1; seq <= 300; seq += 1) {
      es.listeners.journal!({ data: JSON.stringify({ seq, type: 'X' }) } as MessageEvent);
      await Promise.resolve();
      await new Promise((r) => setImmediate(r));
    }
    es.listeners.end!({} as MessageEvent);
    await waitFor(() => expect(result.current.ended).toBe(true));
    expect(result.current.events).toHaveLength(300);
    expect(renders - before).toBeLessThan(100); // one render per event would be 300
  });
  it('opens the stream again once the browser gives up, and counts the reopen', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useJournal('/api/x/events'));
    const first = FakeEventSource.instances[0]!;
    first.onopen?.({} as Event);
    // A stream the browser is still retrying is left to the browser.
    first.readyState = 0;
    first.onerror?.({} as Event);
    expect(FakeEventSource.instances).toHaveLength(1);
    first.readyState = FakeEventSource.CLOSED;
    act(() => first.onerror?.({} as Event));
    expect(result.current.error).toBe('connection lost; retrying');
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(FakeEventSource.instances).toHaveLength(2);
    act(() => FakeEventSource.instances[1]!.onopen?.({} as Event));
    vi.useRealTimers();
    await waitFor(() => expect(result.current.reopened).toBe(1));
    expect(result.current.error).toBeNull();
  });
});
