import { useEffect, useState } from 'react';
import type { SessionState } from './api.js';

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
