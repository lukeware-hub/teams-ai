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
    const es = new EventSource(url);
    es.addEventListener('journal', (e) => {
      const ev = JSON.parse((e as MessageEvent).data) as StoredEvent;
      setEvents((list) => (list.some((x) => x.seq === ev.seq) ? list : [...list, ev]));
    });
    es.addEventListener('end', () => {
      setEnded(true);
      es.close();
    });
    es.onerror = () => setError('connection lost; retrying');
    es.onopen = () => setError(null);
    return () => es.close();
  }, [url]);
  return { events, ended, error };
}
