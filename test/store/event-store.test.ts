import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EventLogCorruptError,
  EventLogLockedError,
  EventStore,
  loadEvents,
  repairEventLog,
  unconfirmedIntents,
} from '../../server/store/event-store.js';

const HASH = `sha256:${'a'.repeat(64)}`;
const fixedClock = () => new Date('2026-09-23T12:00:00.000Z');

let dir: string;
let file: string;
const opened: EventStore[] = [];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-events-'));
  file = path.join(dir, 'runs', 'run-1', 'events.ndjson');
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((s) => s.close()));
  await fs.rm(dir, { recursive: true, force: true });
});

async function open() {
  const store = await EventStore.open({ file, runId: 'run-1', specHash: HASH, clock: fixedClock });
  opened.push(store);
  return store;
}

async function writeLines(...lines: string[]) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, lines.join(''));
}

const rawEvent = (seq: number, type = 'A') =>
  `${JSON.stringify({ seq, at: 'x', runId: 'run-1', specHash: HASH, type, kind: 'fact', data: {} })}\n`;

describe('EventStore', () => {
  it('assigns sequential seq numbers and persists events', async () => {
    const store = await open();
    const first = await store.append({ type: 'RUN_STARTED' });
    const second = await store.append({ type: 'TASK_READY', data: { taskId: 'T1-create' } });
    expect(first).toMatchObject({ seq: 1, type: 'RUN_STARTED', kind: 'fact', runId: 'run-1', specHash: HASH });
    expect(second.seq).toBe(2);
    expect(first.at).toBe('2026-09-23T12:00:00.000Z');
    expect((await loadEvents(file)).map((e) => e.type)).toEqual(['RUN_STARTED', 'TASK_READY']);
  });

  it('continues numbering after close and reopen', async () => {
    const first = await open();
    await first.append({ type: 'A' });
    await first.close();
    const reopened = await open();
    expect((await reopened.append({ type: 'B' })).seq).toBe(2);
  });

  it('refuses a second writer on the same log', async () => {
    await open();
    await expect(EventStore.open({ file, runId: 'run-1', specHash: HASH })).rejects.toThrow(EventLogLockedError);
  });

  it('reclaims a lock whose pid was reused after a container restart', async () => {
    await writeLines(rawEvent(1));
    await fs.writeFile(`${file}.lock`, String(process.pid));
    const reopened = await open();
    expect((await reopened.append({ type: 'B' })).seq).toBe(2);
  });

  it('reclaims a lock taken on another host even when a live process here wears its pid', async () => {
    await writeLines(rawEvent(1));
    // A previous container wrote this; its pid restarted from 1 there and is now some unrelated live process.
    await fs.writeFile(`${file}.lock`, `${process.ppid}@some-other-container`);
    const reopened = await open();
    expect((await reopened.append({ type: 'B' })).seq).toBe(2);
    expect(await fs.readFile(`${file}.lock`, 'utf8')).toBe(`${process.pid}@${(await import('node:os')).default.hostname()}`);
  });

  it('refuses appends after close', async () => {
    const store = await open();
    await store.close();
    await expect(store.append({ type: 'A' })).rejects.toThrow(/closed/);
  });

  it('serializes concurrent appends without gaps', async () => {
    const store = await open();
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.append({ type: `E${i}` })));
    const seqs = (await store.readAll()).map((e) => e.seq);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('drops a torn tail left by a crash and keeps appending', async () => {
    const first = await open();
    await first.append({ type: 'A' });
    await first.close();
    await fs.appendFile(file, '{"seq":2,"type":"PARTI');
    const reopened = await open();
    const next = await reopened.append({ type: 'B' });
    expect(next.seq).toBe(2);
    expect((await loadEvents(file)).map((e) => e.type)).toEqual(['A', 'B']);
  });

  it('drops a complete but unreadable last line', async () => {
    await writeLines(rawEvent(1), `${'\0'.repeat(40)}\n`);
    const removed = await repairEventLog(file);
    expect(removed).toBe(41);
    expect((await loadEvents(file)).map((e) => e.seq)).toEqual([1]);
  });

  it('requires an intentId for intent and confirm events', async () => {
    const store = await open();
    await expect(store.append({ type: 'PR_CREATE', kind: 'intent' })).rejects.toThrow(/intentId/);
    expect((await store.append({ type: 'AFTER' })).seq).toBe(1);
  });
});

describe('loadEvents', () => {
  it('rejects a corrupt first line', async () => {
    await writeLines('not json\n', rawEvent(1));
    await expect(loadEvents(file)).rejects.toThrow(EventLogCorruptError);
  });

  it('rejects a line that is not an object with a seq', async () => {
    await writeLines('null\n', rawEvent(1));
    await expect(loadEvents(file)).rejects.toThrow(EventLogCorruptError);
    await writeLines('42\n');
    await expect(loadEvents(file)).rejects.toThrow(EventLogCorruptError);
  });

  it('rejects an event missing stored fields or with an unknown kind', async () => {
    await writeLines('{"seq":1,"type":"A"}\n');
    await expect(loadEvents(file)).rejects.toThrow(EventLogCorruptError);
    await writeLines(rawEvent(1).replace('"kind":"fact"', '"kind":"guess"'));
    await expect(loadEvents(file)).rejects.toThrow(EventLogCorruptError);
  });

  it('rejects non-contiguous seq numbers', async () => {
    await writeLines(rawEvent(1), rawEvent(3));
    await expect(loadEvents(file)).rejects.toThrow(EventLogCorruptError);
  });

  it('does not truncate the file', async () => {
    await writeLines(rawEvent(1), '{"seq":2,"type":"PARTI');
    await expect(loadEvents(file)).rejects.toThrow(EventLogCorruptError);
    expect((await fs.readFile(file, 'utf8')).endsWith('PARTI')).toBe(true);
  });

  it('returns an empty list for a missing log', async () => {
    expect(await loadEvents(path.join(dir, 'missing.ndjson'))).toEqual([]);
  });
});

describe('repairEventLog', () => {
  it('does not repair corruption before the last line', async () => {
    await writeLines(rawEvent(1), 'garbage\n', rawEvent(3));
    expect(await repairEventLog(file)).toBe(0);
    await expect(loadEvents(file)).rejects.toThrow(EventLogCorruptError);
  });

  it('is a no-op on a clean or missing log', async () => {
    expect(await repairEventLog(file)).toBe(0);
    await writeLines(rawEvent(1));
    expect(await repairEventLog(file)).toBe(0);
  });
});

describe('unconfirmedIntents', () => {
  it('returns intents that have no matching confirm', async () => {
    const store = await open();
    await store.append({ type: 'PR_CREATE', kind: 'intent', intentId: 'pr-t1' });
    await store.append({ type: 'PR_CREATE', kind: 'confirm', intentId: 'pr-t1' });
    await store.append({ type: 'MERGE', kind: 'intent', intentId: 'merge-t1' });
    const pending = unconfirmedIntents(await store.readAll());
    expect(pending.map((e) => e.intentId)).toEqual(['merge-t1']);
  });
});

describe('EventStore crash recovery', () => {
  it('reclaims a lock left by a dead process and repairs the torn tail', async () => {
    const first = await open();
    await first.append({ type: 'A' });
    // Simulate a crash: torn tail and a lock file whose owner is gone.
    await fs.appendFile(file, '{"seq":2,"type":"PARTI');
    await fs.writeFile(`${file}.lock`, '999999');
    opened.splice(opened.indexOf(first), 1);
    const reopened = await open();
    expect((await reopened.append({ type: 'B' })).seq).toBe(2);
  });

  it('releases the lock when open fails on a corrupt log', async () => {
    await writeLines(rawEvent(1), 'garbage\n', rawEvent(3));
    await expect(EventStore.open({ file, runId: 'run-1', specHash: HASH })).rejects.toThrow(EventLogCorruptError);
    await expect(EventStore.open({ file, runId: 'run-1', specHash: HASH })).rejects.toThrow(EventLogCorruptError);
  });

  it('closes itself and releases the lock after a failed append so the same process can reopen', async () => {
    const store = await open();
    await store.append({ type: 'A' });
    const failing = { ...store, file: path.join(dir, 'missing-dir', 'x', 'events.ndjson') } as unknown as EventStore;
    Object.setPrototypeOf(failing, EventStore.prototype);
    await expect(failing.append({ type: 'B' })).rejects.toThrow();
    await expect(failing.append({ type: 'C' })).rejects.toThrow(/closed/);
    opened.splice(opened.indexOf(store), 1);
    const reopened = await open();
    expect((await reopened.append({ type: 'B' })).seq).toBe(2);
  });

  it('drops a torn tail that still parses as JSON but lacks the stored fields', async () => {
    await writeLines(rawEvent(1), '{"seq":2}\n');
    expect(await repairEventLog(file)).toBe(10);
    expect((await loadEvents(file)).map((e) => e.seq)).toEqual([1]);
  });

  it('repairs an unreadable last line that has whitespace around it', async () => {
    await writeLines(rawEvent(1), `  ${'\0'.repeat(10)}  \n\n`);
    await repairEventLog(file);
    expect((await loadEvents(file)).map((e) => e.seq)).toEqual([1]);
    expect(await fs.readFile(file, 'utf8')).toBe(rawEvent(1));
  });

  it('reclaims a stale lock whose reclaimer crashed and left its guard behind', async () => {
    await writeLines(rawEvent(1));
    await fs.writeFile(`${file}.lock`, '999999');
    await fs.writeFile(`${file}.lock.reclaim`, '999998');
    const reopened = await open();
    expect((await reopened.append({ type: 'B' })).seq).toBe(2);
    await expect(fs.access(`${file}.lock.reclaim`)).rejects.toThrow();
  });

  it('leaves a stale lock alone while a live process holds the reclaim guard', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.lock`, '999999');
    await fs.writeFile(`${file}.lock.reclaim`, String(process.ppid));
    await expect(EventStore.open({ file, runId: 'run-1', specHash: HASH })).rejects.toThrow(EventLogLockedError);
    expect(await fs.readFile(`${file}.lock`, 'utf8')).toBe('999999');
  });

  it('lets exactly one of four processes reclaim the same stale lock', async () => {
    // Each child opens every journal at the same instant as its siblings and stays alive (its locks stay live)
    // until the parent kills it, so a second opener can only come from a broken reclaim.
    const contender = `
      const [storeUrl, ...files] = process.argv.slice(1);
      const { EventStore } = await import(storeUrl);
      process.send('ready');
      const goAt = await new Promise((resolve) => process.once('message', resolve));
      const opened = [];
      for (const [i, file] of files.entries()) {
        while (Date.now() < goAt + i * 20) { /* spin: start together */ }
        opened.push(await EventStore.open({ file, runId: 'run-1', specHash: 'h' }).then(() => true, () => false));
      }
      process.send(opened);
      await new Promise((resolve) => process.once('disconnect', resolve));
    `;
    const journals = Array.from({ length: 40 }, (_, i) => path.join(dir, `r${i}`, 'events.ndjson'));
    for (const journal of journals) {
      await fs.mkdir(path.dirname(journal), { recursive: true });
      await fs.writeFile(`${journal}.lock`, '999999');
    }
    const storeUrl = new URL('../../server/store/event-store.ts', import.meta.url).href;
    const children = Array.from({ length: 4 }, () =>
      spawn(process.execPath, ['--input-type=module', '-e', contender, storeUrl, ...journals], {
        env: { ...process.env, NODE_OPTIONS: '--import tsx' },
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      }),
    );
    try {
      const next = (child: (typeof children)[number]) => once(child, 'message').then(([message]) => message as unknown);
      await Promise.all(children.map(next));
      const goAt = Date.now() + 200;
      for (const child of children) child.send(goAt);
      const results = (await Promise.all(children.map(next))) as boolean[][];
      const openers = journals.map((_, round) => results.filter((opened) => opened[round]).length);
      expect(openers).toEqual(journals.map(() => 1));
    } finally {
      for (const child of children) child.kill();
    }
  }, 30_000);
});
