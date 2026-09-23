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

function parseLine(line: string, lineNumber: number): StoredEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new EventLogCorruptError(`corrupt event at line ${lineNumber}`);
  }
  if (parsed === null || typeof parsed !== 'object' || !Number.isInteger((parsed as StoredEvent).seq)) {
    throw new EventLogCorruptError(`corrupt event at line ${lineNumber}`);
  }
  return parsed as StoredEvent;
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
  const lines = complete.split('\n').filter((l) => l.trim() !== '');
  const last = lines.at(-1);
  if (last !== undefined) {
    try {
      parseLine(last, lines.length);
    } catch {
      complete = complete.slice(0, complete.lastIndexOf(`${last}\n`));
    }
  }
  if (complete.length === text.length) return 0;
  await fs.truncate(file, Buffer.byteLength(complete));
  return Buffer.byteLength(text) - Buffer.byteLength(complete);
}

export function unconfirmedIntents(events: readonly StoredEvent[]): StoredEvent[] {
  const confirmed = new Set(events.filter((e) => e.kind === 'confirm').map((e) => e.intentId));
  return events.filter((e) => e.kind === 'intent' && !confirmed.has(e.intentId));
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
    try {
      const handle = await fs.open(lockFile, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new EventLogLockedError(`${opts.file} is already open (lock: ${lockFile})`);
      }
      throw err;
    }
    await repairEventLog(opts.file);
    const events = await loadEvents(opts.file);
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
      const handle = await fs.open(this.file, 'a');
      try {
        await handle.write(`${JSON.stringify(event)}\n`);
        await handle.datasync();
      } finally {
        await handle.close();
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
