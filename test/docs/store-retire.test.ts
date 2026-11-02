import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { retireAliases, type Store } from '../../server/docs/store.js';
import { git } from '../../server/git/git.js';
import { cloneStore, publish } from '../fixtures/docs-store-clone.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const FIVE: Record<string, string> = {
  'docs/project.md': '# Projeto\n',
  'docs/flow.md': '# Fluxo\n',
  'docs/briefing.md': '# Briefing\n',
  'docs/design.md': '# Design\n',
  'docs/stack.md': '# Stack\n',
};

let ws: { root: string };
let remote: Remote;
let store: Store;

beforeEach(async () => {
  ws = { root: await fs.mkdtemp(path.join(os.tmpdir(), 'docs-retire-')) };
  remote = await makeRemote({ 'README.md': '# readme\n' });
  store = await cloneStore(ws, remote);
  await publish(store, { draftId: 'alpha-001', stepKey: 'close', scope: 'refine', label: 'documents', files: { ...FIVE, 'docs/specify/alpha/spec.md': '# Alpha\n' } });
  await publish(store, { draftId: 'beta-001', stepKey: 'close', scope: 'refine', label: 'beta', files: { 'docs/specify/beta/spec.md': '# Beta\n' } });
});
afterEach(async () => {
  await remote.cleanup();
  await fs.rm(ws.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const headFiles = async (): Promise<string[]> => (await git(store.dir, ['ls-tree', '-r', '--name-only', 'HEAD'])).split('\n');

describe('retiring the aliases of a discarded draft', () => {
  it('removes exactly the alias folder the draft committed and leaves the five documents', async () => {
    const flushed = await retireAliases(store, 'beta-001');
    expect(flushed.sha).not.toBeNull();
    expect(await headFiles()).not.toContain('docs/specify/beta/spec.md');
    expect(await headFiles()).toContain('docs/specify/alpha/spec.md');
    for (const [rel, text] of Object.entries(FIVE)) expect(await git(store.dir, ['show', `HEAD:${rel}`])).toBe(text.trimEnd());
    await expect(fs.access(path.join(store.dir, 'docs', 'specify', 'beta'))).rejects.toThrow();
  });

  it('keeps the folders another draft committed', async () => {
    const flushed = await retireAliases(store, 'gamma-001');
    expect(flushed.sha).toBeNull();
    expect(await headFiles()).toContain('docs/specify/alpha/spec.md');
    expect(await headFiles()).toContain('docs/specify/beta/spec.md');
  });

  it('makes no commit when the draft committed no alias folder', async () => {
    const head = await git(store.dir, ['rev-parse', 'HEAD']);
    expect((await retireAliases(store, 'delta-001')).sha).toBeNull();
    expect(await git(store.dir, ['rev-parse', 'HEAD'])).toBe(head);
  });
});
