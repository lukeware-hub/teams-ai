import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureSession } from './auth.js';
import { useJournal, useSse } from './useSse.js';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  closed = false;
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
  sessionStorage.clear();
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ensureSession', () => {
  it('POSTs the session endpoint as JSON with the stored bearer', async () => {
    sessionStorage.setItem('teams-ai-ui-token', 'tok');
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    await ensureSession();
    const [path, init] = f.mock.calls[0]!;
    expect(path).toBe('/api/auth/session');
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('authorization')).toBe('Bearer tok');
  });
  it('never rejects when the request fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    await expect(ensureSession()).resolves.toBeUndefined();
  });
});

describe('useSse', () => {
  it('opens the EventSource only after the session call, applies events and closes on unmount', async () => {
    let finish: () => void = () => {};
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((r) => (finish = () => r(new Response(null, { status: 204 })))));
    const { result, unmount } = renderHook(() => useSse('/api/x/events'));
    expect(FakeEventSource.instances).toHaveLength(0);
    finish();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const es = FakeEventSource.instances[0]!;
    expect(es.url).toBe('/api/x/events');
    es.listeners.state!({ data: JSON.stringify({ name: 'awaiting-browser' }) } as MessageEvent);
    es.listeners.output!({ data: JSON.stringify('hello') } as MessageEvent);
    await waitFor(() => expect(result.current.state.name).toBe('awaiting-browser'));
    expect(result.current.output).toBe('hello');
    unmount();
    expect(es.closed).toBe(true);
  });
  it('does not open a stream when unmounted before the session resolves, nor without a url', async () => {
    let finish: () => void = () => {};
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((r) => (finish = () => r(new Response(null, { status: 204 })))));
    const { unmount } = renderHook(() => useSse('/api/x/events'));
    unmount();
    finish();
    await new Promise((r) => setTimeout(r, 10));
    expect(FakeEventSource.instances).toHaveLength(0);
    renderHook(() => useSse(null));
    await new Promise((r) => setTimeout(r, 10));
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});

describe('useJournal reconnection (audit M5)', () => {
  it('keeps the EventSource open on a server reconnect, drops replayed seqs, and closes only on end', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const { result } = renderHook(() => useJournal('/api/x/events'));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
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
});
