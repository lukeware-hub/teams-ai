import { useEffect, useState } from 'react';
import type { SessionState, StoredEvent } from './api.js';

export function useSse(url: string | null, initial: SessionState = { name: 'idle' }) {
  const [state, setState] = useState<SessionState>(initial);
  const [output, setOutput] = useState('');
  useEffect(() => {
    if (!url) return;
    const es = new EventSource(url);
    es.addEventListener('state', (e) => setState(JSON.parse((e as MessageEvent).data) as SessionState));
    es.addEventListener('output', (e) => setOutput((o) => (o + (JSON.parse((e as MessageEvent).data) as string)).slice(-4096)));
    return () => es.close();
  }, [url]);
  return { state, output, setState };
}

/** Spec (run API) §8: EventSource reconnects with Last-Event-ID; a seq already applied is dropped. */
export function useJournal(url: string | null) {
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reopened, setReopened] = useState(0);
  useEffect(() => {
    if (!url) return;
    setEvents([]);
    setEnded(false);
    // A replay sends hundreds of events at once: they are applied in one render per batch, not one per event.
    let pending: StoredEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      clearTimeout(timer);
      timer = undefined;
      const batch = pending;
      pending = [];
      setEvents((list) => {
        const seen = new Set(list.map((x) => x.seq));
        const fresh = batch.filter((ev) => !seen.has(ev.seq) && seen.add(ev.seq));
        return fresh.length === 0 ? list : [...list, ...fresh];
      });
    };
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let wait = 2_000;
    let opens = 0;
    // The browser retries a dropped stream by itself; one it has given up on (CLOSED) is opened again, waiting longer each time.
    const open = () => {
      const current = new EventSource(url);
      source = current;
      current.addEventListener('journal', (e) => {
        pending.push(JSON.parse((e as MessageEvent).data) as StoredEvent);
        timer ??= setTimeout(flush, 50);
      });
      current.addEventListener('end', () => {
        flush();
        setEnded(true);
        current.close();
      });
      current.onopen = () => {
        setError(null);
        wait = 2_000;
        opens += 1;
        // An open after the first may have missed document changes: the page reads the documents again.
        if (opens > 1) setReopened((n) => n + 1);
      };
      current.onerror = () => {
        if (current.readyState !== EventSource.CLOSED) return;
        setError('connection lost; retrying');
        retry = setTimeout(open, wait);
        wait = Math.min(wait * 2, 30_000);
      };
    };
    open();
    return () => {
      clearTimeout(timer);
      clearTimeout(retry);
      source?.close();
    };
  }, [url]);
  return { events, ended, error, reopened };
}
