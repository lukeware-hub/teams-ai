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
    const source = new EventSource(url);
    source.addEventListener('journal', (e) => {
      pending.push(JSON.parse((e as MessageEvent).data) as StoredEvent);
      timer ??= setTimeout(flush, 50);
    });
    source.addEventListener('end', () => {
      flush();
      setEnded(true);
      source.close();
    });
    source.onerror = () => setError('connection lost; retrying');
    source.onopen = () => setError(null);
    return () => {
      clearTimeout(timer);
      source.close();
    };
  }, [url]);
  return { events, ended, error };
}
