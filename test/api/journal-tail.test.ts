import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { tailJournal } from '../../server/api/journal-tail.js';
import type { StoredEvent } from '../../server/store/event-store.js';
import { appendEvents, writeRun } from '../fixtures/runs/write-run.js';

/** A poller's sleep under the test's control: `tick` wakes it and waits until it has read and gone back to sleep, however slow the disk. */
function stepper() {
  let wake: () => void = () => {};
  let sleeps = 0;
  const asleep = (n: number) => vi.waitFor(() => expect(sleeps).toBeGreaterThanOrEqual(n));
  return {
    sleep: () => {
      sleeps += 1;
      return new Promise<void>((r) => (wake = r));
    },
    /** The first read is done once the poller sleeps for the first time. */
    started: () => asleep(1),
    tick: async () => {
      const n = sleeps;
      wake();
      await asleep(n + 1);
    },
    /** Wakes a poller that has nothing left to tail, so it ends without sleeping again. */
    release: () => wake(),
  };
}
/** Only for checks that nothing more arrives: they pass however long the disk takes. */
const quiet = () => new Promise((r) => setTimeout(r, 40));

describe('tailJournal', () => {
  it('delivers only events after the given seq, tolerates a torn last line, and stops on close', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-tail-'));
    await writeRun(home, 'r1', [{ type: 'A' }, { type: 'B' }]);
    const file = path.join(home, 'r1', 'events.ndjson');
    const seen: StoredEvent[] = [];
    const s = stepper();
    const t = tailJournal(file, 1, (e) => seen.push(e), { sleep: s.sleep });
    await s.started();
    expect(seen.map((e) => e.type)).toEqual(['B']);
    await appendEvents(home, 'r1', [{ type: 'C' }], 3);
    await fs.appendFile(file, '{"seq":4,"type":"D"'); // torn
    await s.tick();
    expect(seen.map((e) => e.type)).toEqual(['B', 'C']);
    await fs.appendFile(file, ',"at":"x","runId":"r1","specHash":"h","kind":"fact","data":{}}\n');
    await s.tick();
    expect(seen.map((e) => e.type)).toEqual(['B', 'C', 'D']);
    t.close();
    s.release();
    await appendEvents(home, 'r1', [{ type: 'E' }], 5);
    await quiet();
    expect(seen).toHaveLength(3);
    await fs.rm(home, { recursive: true, force: true });
  });

  it('shares one poller per file: late subscribers replay from their own seq, then every tick costs one read (audit M5)', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-tail-'));
    await writeRun(home, 'r1', [{ type: 'A' }, { type: 'B' }, { type: 'C' }]);
    const file = path.join(home, 'r1', 'events.ndjson');
    const s = stepper();
    const first: string[] = [];
    const late: string[] = [];
    const later: string[] = [];
    const t1 = tailJournal(file, 0, (e) => first.push(e.type), { sleep: s.sleep });
    await s.started();
    expect(first).toEqual(['A', 'B', 'C']);
    const t2 = tailJournal(file, 1, (e) => late.push(e.type), { sleep: s.sleep });
    const t3 = tailJournal(file, 3, (e) => later.push(e.type), { sleep: s.sleep });
    await vi.waitFor(() => expect(late).toEqual(['B', 'C']));
    expect(later).toEqual([]);
    const open = vi.spyOn(fs, 'open');
    await appendEvents(home, 'r1', [{ type: 'D' }], 4);
    for (let i = 0; i < 3; i++) await s.tick();
    expect(open).toHaveBeenCalledTimes(3);
    expect(first).toEqual(['A', 'B', 'C', 'D']);
    expect(late).toEqual(['B', 'C', 'D']);
    expect(later).toEqual(['D']);
    t1.close();
    await appendEvents(home, 'r1', [{ type: 'E' }], 5);
    await s.tick();
    expect(first).toHaveLength(4);
    expect(late.at(-1)).toBe('E');
    t2.close();
    t3.close();
    s.release();
    await quiet();
    const calls = open.mock.calls.length;
    s.release();
    await quiet();
    expect(open.mock.calls.length).toBe(calls);
    open.mockRestore();
    await fs.rm(home, { recursive: true, force: true });
  });
});
