import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lockFile, withFileLock } from '../../server/core/file-lock.js';

let dir = '';
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-lock-')); });
afterEach(() => fs.rm(dir, { recursive: true, force: true }));

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('withFileLock', () => {
  it('lets one holder at a time through, in the order they asked', async () => {
    const file = path.join(dir, 'a.lock');
    const log: string[] = [];
    const hold = (name: string) => withFileLock(file, async () => { log.push(`${name}+`); await pause(150); log.push(`${name}-`); });
    await Promise.all([hold('a'), pause(20).then(() => hold('b'))]);
    expect(log).toEqual(['a+', 'a-', 'b+', 'b-']);
  });

  it('releases the lock when the holder throws', async () => {
    const file = path.join(dir, 'a.lock');
    await expect(withFileLock(file, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await withFileLock(file, async () => 'next')).toBe('next');
  });

  it('takes over a lock its dead holder stopped refreshing', async () => {
    const file = path.join(dir, 'a.lock');
    await fs.writeFile(file, '');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(file, old, old);
    expect(await withFileLock(file, async () => 'taken', 1_000)).toBe('taken');
  });

  it('names one lock file per repository and kind, outside the repository', () => {
    expect(lockFile('/ws/shop/repo', 'repo')).toBe(lockFile('/ws/shop/repo', 'repo'));
    expect(lockFile('/ws/shop/repo', 'repo')).not.toBe(lockFile('/ws/shop/repo', 'checkout'));
    expect(lockFile('/ws/shop/repo', 'repo').startsWith(os.tmpdir())).toBe(true);
  });
});
