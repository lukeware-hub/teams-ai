import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasSession, restoreSession, saveSession } from '../../server/runner/session-store.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-session-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function homeWith(name: string, id: string): Promise<string> {
  const home = path.join(dir, name);
  await fs.mkdir(path.join(home, '.claude', 'projects', '-work'), { recursive: true });
  await fs.writeFile(path.join(home, '.claude', 'projects', '-work', `${id}.jsonl`), '{"turn":1}\n');
  return home;
}

describe('session store', () => {
  it('keeps the transcript of a step HOME and restores it into another', async () => {
    const store = path.join(dir, 'store');
    await saveSession(await homeWith('h1', 'abc'), store, '/work');
    expect(await hasSession(store, 'abc', '/work')).toBe(true);
    const h2 = path.join(dir, 'h2');
    await restoreSession(store, h2);
    expect(await fs.readFile(path.join(h2, '.claude', 'projects', '-work', 'abc.jsonl'), 'utf8')).toBe('{"turn":1}\n');
  });

  it('does not offer a session saved for another cwd or id, or never saved', async () => {
    const store = path.join(dir, 'store');
    expect(await hasSession(store, 'abc', '/work')).toBe(false);
    await saveSession(await homeWith('h1', 'abc'), store, '/work');
    expect(await hasSession(store, 'abc', '/elsewhere')).toBe(false);
    expect(await hasSession(store, 'other', '/work')).toBe(false);
  });

  it('keeps nothing, without failing, when the step left no transcript', async () => {
    const store = path.join(dir, 'store');
    await saveSession(path.join(dir, 'empty-home'), store, '/work');
    expect(await hasSession(store, 'abc', '/work')).toBe(false);
  });

  it('replaces the stored transcript with the newest one', async () => {
    const store = path.join(dir, 'store');
    await saveSession(await homeWith('h1', 'abc'), store, '/work');
    const h2 = await homeWith('h2', 'abc');
    await fs.appendFile(path.join(h2, '.claude', 'projects', '-work', 'abc.jsonl'), '{"turn":2}\n');
    await saveSession(h2, store, '/work');
    const h3 = path.join(dir, 'h3');
    await restoreSession(store, h3);
    expect(await fs.readFile(path.join(h3, '.claude', 'projects', '-work', 'abc.jsonl'), 'utf8')).toBe('{"turn":1}\n{"turn":2}\n');
  });
});
