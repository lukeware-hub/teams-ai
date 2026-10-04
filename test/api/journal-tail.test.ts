import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { tailJournal } from '../../server/api/journal-tail.js';
import type { StoredEvent } from '../../server/store/event-store.js';
import { appendEvents, writeRun } from '../fixtures/runs/write-run.js';

describe('tailJournal', () => {
  it('delivers only events after the given seq, tolerates a torn last line, and stops on close', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-tail-'));
    await writeRun(home, 'r1', [{ type: 'A' }, { type: 'B' }]);
    const file = path.join(home, 'r1', 'events.ndjson');
    const seen: StoredEvent[] = [];
    let wake: () => void = () => {};
    const sleep = () => new Promise<void>((r) => (wake = r));
    const t = tailJournal(file, 1, (e) => seen.push(e), { sleep });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen.map((e) => e.type)).toEqual(['B']);
    await appendEvents(home, 'r1', [{ type: 'C' }], 3);
    await fs.appendFile(file, '{"seq":4,"type":"D"'); // torn
    wake();
    await new Promise((r) => setTimeout(r, 10));
    expect(seen.map((e) => e.type)).toEqual(['B', 'C']);
    await fs.appendFile(file, ',"at":"x","runId":"r1","specHash":"h","kind":"fact","data":{}}\n');
    wake();
    await new Promise((r) => setTimeout(r, 10));
    expect(seen.map((e) => e.type)).toEqual(['B', 'C', 'D']);
    t.close();
    wake();
    await appendEvents(home, 'r1', [{ type: 'E' }], 5);
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(3);
    await fs.rm(home, { recursive: true, force: true });
  });

  it('shares one poller per file: late subscribers replay from their own seq, then every tick costs one read (audit M5)', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-tail-'));
    await writeRun(home, 'r1', [{ type: 'A' }, { type: 'B' }, { type: 'C' }]);
    const file = path.join(home, 'r1', 'events.ndjson');
    let wake: () => void = () => {};
    const sleep = () => new Promise<void>((r) => (wake = r));
    const settle = () => new Promise((r) => setTimeout(r, 40));
    const first: string[] = [];
    const late: string[] = [];
    const later: string[] = [];
    const t1 = tailJournal(file, 0, (e) => first.push(e.type), { sleep });
    await settle();
    expect(first).toEqual(['A', 'B', 'C']);
    const t2 = tailJournal(file, 1, (e) => late.push(e.type), { sleep });
    const t3 = tailJournal(file, 3, (e) => later.push(e.type), { sleep });
    await settle();
    expect(late).toEqual(['B', 'C']);
    expect(later).toEqual([]);
    const open = vi.spyOn(fs, 'open');
    await appendEvents(home, 'r1', [{ type: 'D' }], 4);
    for (let i = 0; i < 3; i++) {
      wake();
      await settle();
    }
    expect(open).toHaveBeenCalledTimes(3);
    expect(first).toEqual(['A', 'B', 'C', 'D']);
    expect(late).toEqual(['B', 'C', 'D']);
    expect(later).toEqual(['D']);
    t1.close();
    await appendEvents(home, 'r1', [{ type: 'E' }], 5);
    wake();
    await settle();
    expect(first).toHaveLength(4);
    expect(late.at(-1)).toBe('E');
    t2.close();
    t3.close();
    wake();
    await settle();
    const calls = open.mock.calls.length;
    wake();
    await settle();
    expect(open.mock.calls.length).toBe(calls);
    open.mockRestore();
    await fs.rm(home, { recursive: true, force: true });
  });
});
