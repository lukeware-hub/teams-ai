import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RefineEvent } from '../../server/refine/events.js';
import { RefineJournal } from '../../server/refine/session.js';

const ids = { projectId: 'hello-app', specId: 'hello-app-001' };
const enable = { acFloor: 0, keyIds: true };

let dir = '';
let file = '';

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-hook-'));
  file = path.join(dir, 'events.ndjson');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Writes one boundary fact to a journal file and closes it, so a later open replays it. */
async function writeBacklogEnabled(): Promise<void> {
  const journal = await RefineJournal.open(file, ids);
  await journal.fact(RefineEvent.BacklogEnabled, enable);
  await journal.close();
}

describe('RefineJournal.onFact', () => {
  it('a replay of a boundary fact calls the hook zero times', async () => {
    await writeBacklogEnabled();
    const journal = await RefineJournal.open(file, ids);
    const seen: string[] = [];
    journal.onFact = (e) => seen.push(e.type);
    expect(journal.state.backlog?.enabled).toBe(true);
    expect(seen).toEqual([]);
    await journal.close();
  });

  it('a live boundary fact calls the hook once, after the state holds it', async () => {
    const journal = await RefineJournal.open(file, ids);
    const seen: Array<{ type: string; enabled: boolean | undefined }> = [];
    journal.onFact = (e) => seen.push({ type: e.type, enabled: journal.state.backlog?.enabled });
    await journal.fact(RefineEvent.BacklogEnabled, enable);
    expect(seen).toEqual([{ type: RefineEvent.BacklogEnabled, enabled: true }]);
    await journal.close();
  });

  it('a throwing hook does not fail the fact', async () => {
    const journal = await RefineJournal.open(file, ids);
    journal.onFact = () => {
      throw new Error('boom');
    };
    const stored = await journal.fact(RefineEvent.BacklogEnabled, enable);
    expect(stored.type).toBe(RefineEvent.BacklogEnabled);
    expect(journal.events.at(-1)?.type).toBe(RefineEvent.BacklogEnabled);
    expect(journal.state.backlog?.enabled).toBe(true);
    await journal.close();
  });
});
