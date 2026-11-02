import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../server/docs/store.js';
import { git } from '../../server/git/git.js';
import { cloneStore, publish } from '../fixtures/docs-store-clone.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

let roots: string[] = [];
let remote: Remote;
let first: Store;
let second: Store;

beforeEach(async () => {
  remote = await makeRemote({ 'README.md': '# readme\n' });
  const [a, b] = await Promise.all([fs.mkdtemp(path.join(os.tmpdir(), 'docs-two-a-')), fs.mkdtemp(path.join(os.tmpdir(), 'docs-two-b-'))]);
  roots = [a, b];
  first = await cloneStore({ root: a }, remote);
  second = await cloneStore({ root: b }, remote);
});
afterEach(async () => {
  await remote.cleanup();
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});

describe('two drafts of one project flush to the same origin', () => {
  it('take their turns and keep the history linear, without a merge commit or a forced push', async () => {
    await publish(first, { draftId: 'alpha-001', stepKey: 'docs', scope: 'refine', label: 'alpha', files: { 'docs/specify/alpha/spec.md': '# Alpha\n' } });
    await publish(second, { draftId: 'beta-001', stepKey: 'docs', scope: 'refine', label: 'beta', files: { 'docs/specify/beta/spec.md': '# Beta\n' } });
    await publish(first, { draftId: 'alpha-001', stepKey: 'docs', scope: 'refine', label: 'alpha plan', files: { 'docs/specify/alpha/plan.md': '# Plan\n' } });
    const parents = (await git(remote.origin, ['rev-list', '--parents', 'main'])).split('\n');
    expect(parents).toHaveLength(4);
    expect(parents.filter((line) => line.split(' ').length > 2)).toEqual([]);
    const files = await git(remote.origin, ['ls-tree', '-r', '--name-only', 'main']);
    expect(files).toContain('docs/specify/alpha/spec.md');
    expect(files).toContain('docs/specify/beta/spec.md');
    expect(files).toContain('docs/specify/alpha/plan.md');
    expect(await git(first.dir, ['rev-parse', 'HEAD'])).toBe(await git(remote.origin, ['rev-parse', 'main']));
  });
});
