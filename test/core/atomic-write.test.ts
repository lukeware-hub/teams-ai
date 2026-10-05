import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateFileAtomic, writeFileAtomic } from '../../server/core/atomic-write.js';

let dir = '';
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-atomic-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

const rejected = (results: PromiseSettledResult<unknown>[]) => results.filter((r) => r.status === 'rejected');

describe('writeFileAtomic', () => {
  it('survives concurrent writers of one file: none rejects, the file holds one complete write, no tmp file is left', async () => {
    // A tmp name shared by the writers of one file made the slower rename fail (ENOENT, or EPERM on Windows).
    const file = path.join(dir, 'data.json');
    const results = await Promise.allSettled(
      Array.from({ length: 100 }, (_, writer) => writeFileAtomic(file, JSON.stringify({ writer, filler: 'x'.repeat(4000) }))),
    );
    expect(rejected(results)).toEqual([]);
    const written = JSON.parse(await fs.readFile(file, 'utf8')) as { filler: string };
    expect(written.filler).toHaveLength(4000);
    expect(await fs.readdir(dir)).toEqual(['data.json']);
  });

  it('removes its tmp file when the rename fails and does not block the writer queued behind it', async () => {
    const file = path.join(dir, 'data.txt');
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('boom'));
    const results = await Promise.allSettled([writeFileAtomic(file, 'first'), writeFileAtomic(file, 'second')]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
    expect(await fs.readFile(file, 'utf8')).toBe('second');
    expect(await fs.readdir(dir)).toEqual(['data.txt']);
  });
});

describe('updateFileAtomic', () => {
  it('serializes concurrent read-modify-write cycles of one file, so none is lost', async () => {
    const file = path.join(dir, 'counter.txt');
    const bump = (current: string | undefined) => String(Number(current ?? '0') + 1);
    const results = await Promise.allSettled(Array.from({ length: 50 }, () => updateFileAtomic(file, bump)));
    expect(rejected(results)).toEqual([]);
    expect(await fs.readFile(file, 'utf8')).toBe('50');
    expect(await fs.readdir(dir)).toEqual(['counter.txt']);
  });

  it('leaves the file alone, and does not create it, when the update returns undefined', async () => {
    const file = path.join(dir, 'data.txt');
    await updateFileAtomic(file, (current) => {
      expect(current).toBeUndefined();
      return undefined;
    });
    expect(await fs.readdir(dir)).toEqual([]);
    await fs.writeFile(file, 'keep');
    await updateFileAtomic(file, () => undefined);
    expect(await fs.readFile(file, 'utf8')).toBe('keep');
    expect(await fs.readdir(dir)).toEqual(['data.txt']);
  });

  it('re-reads the file right before the rename and redoes the change on top of a foreign write', async () => {
    const file = path.join(dir, 'claude.json');
    await fs.writeFile(file, JSON.stringify({ projects: {} }));
    const writeFile = fs.writeFile.bind(fs);
    let tmpWrites = 0;
    vi.spyOn(fs, 'writeFile').mockImplementation(async (target, data, options) => {
      await writeFile(target, data, options);
      // Another process (the claude CLI) saves the file after this update read it and before it renames.
      if (String(target).endsWith('.tmp') && ++tmpWrites === 1) await writeFile(file, JSON.stringify({ projects: {}, foreign: true }));
    });
    await updateFileAtomic(file, (current) => JSON.stringify({ ...JSON.parse(current ?? '{}'), own: true }));
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ projects: {}, foreign: true, own: true });
    expect(await fs.readdir(dir)).toEqual(['claude.json']);
  });

  it('gives up re-checking after a few attempts instead of chasing a writer that never stops', async () => {
    const file = path.join(dir, 'busy.txt');
    await fs.writeFile(file, 'start');
    const writeFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementation(async (target, data, options) => {
      await writeFile(target, data, options);
      if (String(target).endsWith('.tmp')) await writeFile(file, `foreign ${Math.random()}`);
    });
    let runs = 0;
    await updateFileAtomic(file, (current) => {
      runs++;
      return `${current}+own`;
    });
    expect(runs).toBeGreaterThan(1);
    expect(runs).toBeLessThanOrEqual(5);
    expect(await fs.readFile(file, 'utf8')).toMatch(/\+own$/);
    expect(await fs.readdir(dir)).toEqual(['busy.txt']);
  });
});
