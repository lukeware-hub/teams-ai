import { promises as fs } from 'node:fs';
import path from 'node:path';

export type EventKind = 'fact' | 'intent' | 'confirm';

export interface EventInput {
  type: string;
  kind?: EventKind;
  intentId?: string;
  data?: Record<string, unknown>;
}

export interface StoredEvent {
  seq: number;
  at: string;
  runId: string;
  specHash: string;
  type: string;
  kind: EventKind;
  intentId?: string;
  data: Record<string, unknown>;
}

export class EventLogCorruptError extends Error {}
export class EventLogLockedError extends Error {}

const EVENT_KINDS: ReadonlySet<string> = new Set<EventKind>(['fact', 'intent', 'confirm']);

/** Every field the store writes must be present: a torn line that still parses (`{"seq":2}`) is corrupt. */
function isStoredEvent(value: unknown): value is StoredEvent {
  if (value === null || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return (
    Number.isInteger(e.seq) &&
    typeof e.at === 'string' &&
    typeof e.runId === 'string' &&
    typeof e.specHash === 'string' &&
    typeof e.type === 'string' &&
    typeof e.kind === 'string' &&
    EVENT_KINDS.has(e.kind) &&
    (e.intentId === undefined || typeof e.intentId === 'string') &&
    e.data !== null &&
    typeof e.data === 'object' &&
    !Array.isArray(e.data)
  );
}

function parseLine(line: string, lineNumber: number): StoredEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new EventLogCorruptError(`corrupt event at line ${lineNumber}`);
  }
  if (!isStoredEvent(parsed)) {
    throw new EventLogCorruptError(`corrupt event at line ${lineNumber}`);
  }
  return parsed;
}

function parseEventLog(text: string): StoredEvent[] {
  const events: StoredEvent[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    events.push(parseLine(line, i + 1));
  }
  events.forEach((event, index) => {
    if (event.seq !== index + 1) {
      throw new EventLogCorruptError(`expected seq ${index + 1}, found ${event.seq}`);
    }
  });
  return events;
}

/** Pure read: throws on any corruption. Use repairEventLog first after a crash. */
export async function loadEvents(file: string): Promise<StoredEvent[]> {
  try {
    return parseEventLog(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Drops a torn tail left by a crash: a last line without '\n', or a last line
 * that is complete but unreadable (zero-filled after power loss). Corruption
 * anywhere before the last line is not repairable and is reported.
 * Returns the number of bytes removed.
 */
export async function repairEventLog(file: string): Promise<number> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  if (text.length === 0) return 0;

  let complete = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1);
  // Walk back over trailing blank lines to the last real line, by offset (never by content search).
  let end = complete.length;
  while (end > 0) {
    const start = complete.lastIndexOf('\n', end - 2) + 1;
    const line = complete.slice(start, end - 1);
    if (line.trim() === '') {
      end = start;
      continue;
    }
    try {
      parseLine(line, 0);
    } catch {
      complete = complete.slice(0, start);
    }
    break;
  }
  if (complete.length === text.length) return 0;
  await fs.truncate(file, Buffer.byteLength(complete));
  return Buffer.byteLength(text) - Buffer.byteLength(complete);
}

export function unconfirmedIntents(events: readonly StoredEvent[]): StoredEvent[] {
  const confirmed = new Set(events.filter((e) => e.kind === 'confirm').map((e) => e.intentId));
  return events.filter((e) => e.kind === 'intent' && !confirmed.has(e.intentId));
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Takes the exclusive lock; a lock whose owner process is gone is reclaimed. */
async function acquireLock(file: string, lockFile: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(lockFile, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const owner = Number.parseInt(await fs.readFile(lockFile, 'utf8').catch(() => ''), 10);
      if (attempt === 0 && Number.isInteger(owner) && owner !== process.pid && !processAlive(owner)) {
        await fs.rm(lockFile, { force: true });
        continue;
      }
      throw new EventLogLockedError(`${file} is already open (lock: ${lockFile}, pid ${owner})`);
    }
  }
}

export class EventStore {
  private seq: number;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  private constructor(
    private readonly file: string,
    private readonly lockFile: string,
    private readonly runId: string,
    private readonly specHash: string,
    private readonly clock: () => Date,
    lastSeq: number,
  ) {
    this.seq = lastSeq;
  }

  static async open(opts: {
    file: string;
    runId: string;
    specHash: string;
    clock?: () => Date;
  }): Promise<EventStore> {
    await fs.mkdir(path.dirname(opts.file), { recursive: true });
    const lockFile = `${opts.file}.lock`;
    await acquireLock(opts.file, lockFile);
    let events: StoredEvent[];
    try {
      await repairEventLog(opts.file);
      events = await loadEvents(opts.file);
    } catch (err) {
      await fs.rm(lockFile, { force: true });
      throw err;
    }
    return new EventStore(
      opts.file,
      lockFile,
      opts.runId,
      opts.specHash,
      opts.clock ?? (() => new Date()),
      events.at(-1)?.seq ?? 0,
    );
  }

  append(input: EventInput): Promise<StoredEvent> {
    return this.enqueue(async () => {
      if (this.closed) throw new Error('event store is closed');
      const kind = input.kind ?? 'fact';
      if (kind !== 'fact' && !input.intentId) {
        throw new Error(`${kind} events require an intentId`);
      }
      const event: StoredEvent = {
        seq: this.seq + 1,
        at: this.clock().toISOString(),
        runId: this.runId,
        specHash: this.specHash,
        type: input.type,
        kind,
        ...(input.intentId ? { intentId: input.intentId } : {}),
        data: input.data ?? {},
      };
      const line = Buffer.from(`${JSON.stringify(event)}\n`);
      try {
        const handle = await fs.open(this.file, 'a');
        try {
          const { bytesWritten } = await handle.write(line);
          if (bytesWritten !== line.length) throw new Error(`short write: ${bytesWritten}/${line.length} bytes`);
          await handle.datasync();
        } finally {
          await handle.close();
        }
      } catch (err) {
        // The on-disk tail is now unknown; force a reopen, which repairs it. The lock goes with
        // the store, otherwise the reopen would be refused by our own live pid.
        this.closed = true;
        await fs.rm(this.lockFile, { force: true }).catch(() => undefined);
        throw err;
      }
      this.seq = event.seq;
      return event;
    });
  }

  readAll(): Promise<StoredEvent[]> {
    return this.enqueue(() => loadEvents(this.file));
  }

  async close(): Promise<void> {
    await this.enqueue(async () => {
      if (this.closed) return;
      this.closed = true;
      await fs.rm(this.lockFile, { force: true });
    });
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
