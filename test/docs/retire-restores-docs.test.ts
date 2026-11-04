import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { retireAliases, type Store } from '../../server/docs/store.js';
import { git } from '../../server/git/git.js';
import { cloneStore, publish } from '../fixtures/docs-store-clone.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const MAIN_BRIEFING = '# Briefing\n\nO pedido do projeto.\n';
let root = '';
let remote: Remote;
let store: Store;

beforeEach(async () => {
  remote = await makeRemote({ 'docs/project.md': '# Projeto\n', 'docs/briefing.md': MAIN_BRIEFING });
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'docs-retire-'));
  store = await cloneStore({ root }, remote);
});
afterEach(async () => {
  await remote.cleanup();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('discarding a draft puts back the documents it changed', () => {
  it("restores main's copy of the briefing that the discarded request wrote into the store", async () => {
    await publish(store, {
      draftId: 'shop-pedido-1',
      stepKey: 'docs',
      scope: 'refine',
      label: 'request',
      files: { 'docs/briefing.md': `${MAIN_BRIEFING}\n## Nova demanda (shop-pedido-1)\n\nExportar.\n` },
      bases: { 'docs/briefing.md': MAIN_BRIEFING },
    });
    await retireAliases(store, 'shop-pedido-1', [], { 'docs/briefing.md': MAIN_BRIEFING });
    const briefing = await git(store.dir, ['show', 'HEAD:docs/briefing.md']);
    expect(briefing).toBe(MAIN_BRIEFING.trimEnd());
    expect(briefing).not.toContain('Nova demanda');
  });
});
