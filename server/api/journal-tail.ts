import { promises as fs } from 'node:fs';
import type { StoredEvent } from '../store/event-store.js';

export interface TailOpts {
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** File size the caller took before its own replay; the tail starts at the line holding it instead of byte 0. */
  from?: number;
}

/** One read's size: a journal of hundreds of MB is never held in memory at once. */
const CHUNK = 1 << 20;

/** Parses the complete lines (ending in '\n') of `file` from byte `from` up to `to`, a chunk at a time; returns the offset after the last one. */
async function readEvents(file: string, from: number, each: (e: StoredEvent) => void, to = Infinity): Promise<number> {
  const handle = await fs.open(file, 'r').catch(() => null);
  if (!handle) return from;
  try {
    const size = Math.min((await handle.stat()).size, to);
    let offset = from;
    let length = CHUNK;
    while (offset < size) {
      const buf = Buffer.alloc(Math.min(length, size - offset));
      const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
      const end = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (end < 0) {
        // A torn last line waits for the next poll; a line longer than the chunk is read again with a bigger one.
        if (offset + bytesRead >= size) break;
        length *= 2;
        continue;
      }
      for (const line of buf.toString('utf8', 0, end).split('\n')) {
        if (line.trim() === '') continue;
        try {
          const e = JSON.parse(line) as StoredEvent;
          if (typeof e.seq === 'number') each(e);
        } catch {
          continue;
        }
      }
      offset += end + 1;
      length = CHUNK;
    }
    return offset;
  } finally {
    await handle.close();
  }
}

/** The start of the line that holds byte `offset - 1`, so a size taken mid-append never starts a parse inside a line. */
async function lineStart(file: string, offset: number): Promise<number> {
  const handle = await fs.open(file, 'r').catch(() => null);
  if (!handle) return 0;
  try {
    for (let pos = offset; pos > 0; pos -= CHUNK) {
      const buf = Buffer.alloc(Math.min(CHUNK, pos));
      await handle.read(buf, 0, buf.length, pos - buf.length);
      const nl = buf.lastIndexOf(0x0a);
      if (nl >= 0) return pos - buf.length + nl + 1;
    }
    return 0;
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
 * advanced first replays the bytes already read from its own `from` (events after its own `afterSeq`), then goes live.
 */
export function tailJournal(file: string, afterSeq: number, onEvent: (e: StoredEvent) => void, opts: TailOpts = {}): { close(): void } {
  const pollMs = opts.pollMs ?? 500;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const sub: Subscriber = { last: afterSeq, onEvent, queue: null, closed: false };
  const start = () => (opts.from ? lineStart(file, opts.from) : Promise.resolve(0));
  let state = shared.get(file);
  if (state) {
    sub.queue = [];
    const upTo = state.offset;
    state.subscribers.add(sub);
    void (async () => {
      const events: StoredEvent[] = [];
      await readEvents(file, await start(), (e) => events.push(e), upTo);
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
      own.offset = await start();
      while (!own.stopped) {
        own.offset = await readEvents(file, own.offset, (e) => {
          for (const s of [...own.subscribers]) deliver(s, e);
        });
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
