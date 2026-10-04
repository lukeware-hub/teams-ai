import { promises as fs } from 'node:fs';
import type { StoredEvent } from '../store/event-store.js';

export interface TailOpts {
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Complete lines of `file` from byte `from` (only lines ending in '\n'), parsed; `end` is the offset after the last complete line. */
async function readEvents(file: string, from: number, to?: number): Promise<{ events: StoredEvent[]; end: number }> {
  const handle = await fs.open(file, 'r').catch(() => null);
  if (!handle) return { events: [], end: from };
  try {
    const size = Math.min((await handle.stat()).size, to ?? Infinity);
    if (size <= from) return { events: [], end: from };
    const buf = Buffer.alloc(size - from);
    await handle.read(buf, 0, buf.length, from);
    const text = buf.toString('utf8');
    const end = text.lastIndexOf('\n');
    if (end < 0) return { events: [], end: from };
    const events: StoredEvent[] = [];
    for (const line of text.slice(0, end).split('\n')) {
      if (line.trim() === '') continue;
      try {
        const e = JSON.parse(line) as StoredEvent;
        if (typeof e.seq === 'number') events.push(e);
      } catch {
        continue;
      }
    }
    return { events, end: from + Buffer.byteLength(text.slice(0, end + 1), 'utf8') };
  } finally {
    await handle.close();
  }
}

interface Subscriber {
  last: number;
  onEvent: (e: StoredEvent) => void;
  /** Events that arrive while the subscriber is still replaying what the poller had read before it joined. */
  queue: StoredEvent[] | null;
  closed: boolean;
}

interface Shared {
  subscribers: Set<Subscriber>;
  offset: number;
  stopped: boolean;
}

const shared = new Map<string, Shared>();

function deliver(sub: Subscriber, e: StoredEvent): void {
  if (sub.queue) {
    sub.queue.push(e);
    return;
  }
  if (e.seq > sub.last) {
    sub.last = e.seq;
    sub.onEvent(e);
  }
}

/**
 * Spec (run API) §4: after replay, follow events.ndjson. Only complete lines (ending in '\n') are
 * parsed, so a line the writer is still appending is picked up on the next poll. fs.watch is not
 * used: it is unreliable for appends on some WSL filesystems and the poll is cheap.
 *
 * Audit M5: one poller per file serves every subscriber. A subscriber that joins after the poller has
 * advanced first replays the bytes already read (events after its own `afterSeq`), then goes live.
 */
export function tailJournal(file: string, afterSeq: number, onEvent: (e: StoredEvent) => void, opts: TailOpts = {}): { close(): void } {
  const pollMs = opts.pollMs ?? 500;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const sub: Subscriber = { last: afterSeq, onEvent, queue: null, closed: false };
  let state = shared.get(file);
  if (state) {
    sub.queue = [];
    const upTo = state.offset;
    state.subscribers.add(sub);
    void (async () => {
      const { events } = await readEvents(file, 0, upTo);
      const queued = sub.queue ?? [];
      sub.queue = null;
      if (sub.closed) return;
      // Events the poller produced during the replay come after the replayed ones; deliver() de-duplicates by seq.
      for (const e of [...events, ...queued]) deliver(sub, e);
    })();
  } else {
    state = { subscribers: new Set([sub]), offset: 0, stopped: false };
    shared.set(file, state);
    const own = state;
    void (async () => {
      while (!own.stopped) {
        const { events, end } = await readEvents(file, own.offset);
        own.offset = end;
        for (const e of events) for (const s of [...own.subscribers]) deliver(s, e);
        if (own.stopped) break;
        await sleep(pollMs);
      }
    })();
  }
  const owner = state;
  return {
    close: () => {
      owner.subscribers.delete(sub);
      sub.closed = true;
      sub.queue = null;
      if (owner.subscribers.size === 0) {
        owner.stopped = true;
        if (shared.get(file) === owner) shared.delete(file);
      }
    },
  };
}
