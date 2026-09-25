import { promises as fs } from 'node:fs';
import type { StoredEvent } from '../store/event-store.js';

export interface TailOpts {
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Spec (run API) §4: after replay, follow events.ndjson. Only complete lines (ending in '\n') are
 * parsed, so a line the writer is still appending is picked up on the next poll. fs.watch is not
 * used: it is unreliable for appends on some WSL filesystems and the poll is cheap.
 */
export function tailJournal(file: string, afterSeq: number, onEvent: (e: StoredEvent) => void, opts: TailOpts = {}): { close(): void } {
  const pollMs = opts.pollMs ?? 500;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  let closed = false;
  let offset = 0;
  let last = afterSeq;
  const tick = async (): Promise<void> => {
    const handle = await fs.open(file, 'r').catch(() => null);
    if (!handle) return;
    try {
      const { size } = await handle.stat();
      if (size <= offset) return;
      const buf = Buffer.alloc(size - offset);
      await handle.read(buf, 0, buf.length, offset);
      const text = buf.toString('utf8');
      const end = text.lastIndexOf('\n');
      if (end < 0) return;
      offset += Buffer.byteLength(text.slice(0, end + 1), 'utf8');
      for (const line of text.slice(0, end).split('\n')) {
        if (line.trim() === '') continue;
        let e: StoredEvent;
        try {
          e = JSON.parse(line) as StoredEvent;
        } catch {
          continue;
        }
        if (typeof e.seq === 'number' && e.seq > last) {
          last = e.seq;
          if (!closed) onEvent(e);
        }
      }
    } finally {
      await handle.close();
    }
  };
  void (async () => {
    while (!closed) {
      await tick();
      if (closed) break;
      await sleep(pollMs);
    }
  })();
  return {
    close: () => {
      closed = true;
    },
  };
}
