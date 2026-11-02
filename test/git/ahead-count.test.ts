import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aheadCount, git } from '../../server/git/git.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

let remote: Remote;
let clone: string;

beforeEach(async () => {
  remote = await makeRemote({ 'README.md': 'hello\n' });
  clone = path.join(remote.root, 'clone');
  await git(remote.root, ['clone', '-q', remote.origin, clone]);
});
afterEach(() => remote.cleanup());

async function commit(message: string): Promise<void> {
  await git(clone, ['commit', '--allow-empty', '-q', '-m', message]);
}

describe('aheadCount', () => {
  it('is zero on a fresh clone of origin main', async () => {
    expect(await aheadCount(clone, 'origin/main')).toBe(0);
  });

  it('counts the local commits that origin main lacks', async () => {
    await commit('docs: first');
    await commit('docs: second');
    expect(await aheadCount(clone, 'origin/main')).toBe(2);
  });

  it('counts every commit of HEAD when the ref is missing', async () => {
    expect(await aheadCount(clone, 'origin/missing')).toBe(1);
    await commit('docs: first');
    expect(await aheadCount(clone, 'origin/missing')).toBe(2);
  });
});
