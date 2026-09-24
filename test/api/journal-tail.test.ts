import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
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
});
