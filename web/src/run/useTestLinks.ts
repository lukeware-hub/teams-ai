import { useEffect, useState } from 'react';
import { runApi, type StoredEvent, type TestLink } from '../api.js';

/** A row of a gate's JUnit report, as the journal keeps it. */
interface JunitRow {
  id: string;
  acIds: string[];
}

/** What the links depend on: the acceptance tests reported so far, and the merges, since each merge moves main. */
function signature(events: readonly StoredEvent[]): string {
  const ids = new Set<string>();
  let merges = 0;
  for (const e of events) {
    if (e.type === 'PR_MERGED') merges += 1;
    if (e.type !== 'GATE_PASSED' && e.type !== 'GATE_FAILED') continue;
    for (const row of (e.data.junit as JunitRow[] | undefined) ?? []) if (row.acIds.length > 0) ids.add(row.id);
  }
  return ids.size === 0 ? '' : `${ids.size}:${merges}`;
}

/**
 * The GitHub links of the run's acceptance tests. A burst of journal events asks once, a second after the last one,
 * and a run that has ended is asked for at once.
 */
export function useTestLinks(runId: string | undefined, events: readonly StoredEvent[], ended: boolean): Record<string, TestLink> {
  const sig = signature(events);
  const [links, setLinks] = useState<Record<string, TestLink>>({});
  useEffect(() => {
    if (!runId || sig === '') return;
    let current = true;
    const timer = setTimeout(
      () => {
        runApi
          .testLinks(runId)
          .then((next) => {
            if (current) setLinks(next);
          })
          .catch(() => undefined);
      },
      ended ? 0 : 1_000,
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [runId, sig, ended]);
  return links;
}
