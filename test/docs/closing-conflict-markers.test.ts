import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeRefinement, DocsStoreError, openStore, releaseDocs, type Projection, type Store } from '../../server/docs/store.js';
import { docsClosingPath, docsStoreDir } from '../../server/docs/project-state.js';
import { execCommand } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

let base: Remote;
let ws: { root: string };
let store: Store;

beforeAll(async () => {
  base = await makeRemote({ 'docs/stack.md': 'one\n' });
});
afterAll(() => base.cleanup());

beforeEach(async () => {
  ws = { root: await fs.mkdtemp(path.join(os.tmpdir(), 'lane2-markers-')) };
  const origin = path.join(ws.root, 'origin.git');
  await git(ws.root, ['clone', '-q', '--bare', base.origin, origin]);
  await git(ws.root, ['clone', '-q', origin, docsStoreDir(ws)]);
  store = await openStore(ws, 'monolith', execCommand);
});

afterEach(() => releaseDocs(ws));

const closing = (files: Record<string, string>): Projection => ({
  draftId: 'draft-1',
  stepKey: 'close',
  scope: 'refine',
  label: 'documents',
  files,
  bases: { 'docs/stack.md': 'one\n' },
});

const CLOSING = { summary: 'x', aliases: ['alpha'] };
const exists = (file: string): Promise<boolean> => fs.stat(file).then(() => true, () => false);

describe('closing refuses a document that still holds conflict markers', () => {
  it('refuses the closing and names the document that holds a marker, launching nothing', async () => {
    const marked = 'one\n<<<<<<< main\nmine\n=======\ntheirs\n>>>>>>> rascunho\n';
    const refused = closeRefinement(ws, store, closing({ 'docs/stack.md': marked }), CLOSING);
    await expect(refused).rejects.toBeInstanceOf(DocsStoreError);
    await expect(refused).rejects.toThrow(/docs\/stack\.md still holds conflict markers/);
    expect(await exists(docsClosingPath(ws, 'draft-1'))).toBe(false);
    expect(await git(store.dir, ['log', '-1', '--format=%s'])).not.toContain('refinement closed');
  });

  it('closes a document whose text has no conflict marker line', async () => {
    const r = await closeRefinement(ws, store, closing({ 'docs/stack.md': 'two\n' }), CLOSING);
    expect(r.commit).toBe(await git(store.dir, ['rev-parse', 'HEAD']));
  });
});
