import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeRefinement, commitProjection, createStartTags, openStore, releaseDocs, type Projection, type Store } from '../../server/docs/store.js';
import { docsClosingPath, docsMarkerPath, docsMirrorDir, docsSnapshotDir, docsStoreDir, writeDocsMarker } from '../../server/docs/project-state.js';
import { execCommand } from '../../server/exec/command.js';
import { git, showFile } from '../../server/git/git.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

let base: Remote;
let ws: { root: string };
let origin: string;
let store: Store;

beforeAll(async () => {
  base = await makeRemote({ 'docs/project.md': 'v1\n' });
});
afterAll(() => base.cleanup());

beforeEach(async () => {
  ws = { root: await fs.mkdtemp(path.join(os.tmpdir(), 'docs-close-')) };
  origin = path.join(ws.root, 'origin.git');
  await git(ws.root, ['clone', '-q', '--bare', base.origin, origin]);
  await git(ws.root, ['clone', '-q', origin, docsStoreDir(ws)]);
  store = await openStore(ws, 'monolith', execCommand);
});

afterEach(() => fs.rm(ws.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const flush = (files: Record<string, string>, extra: Partial<Projection> = {}): Projection => ({
  draftId: 'draft-1',
  stepKey: 'close',
  scope: 'refine',
  label: 'documents',
  files,
  bases: { 'docs/project.md': 'v1\n' },
  ...extra,
});
const exists = (file: string): Promise<boolean> => fs.stat(file).then(() => true, () => false);

async function pushOther(text: string, file: string): Promise<void> {
  const other = path.join(ws.root, 'other');
  await git(ws.root, ['clone', '-q', origin, other]);
  await fs.writeFile(path.join(other, file), text);
  await git(other, ['add', '-A']);
  await git(other, ['commit', '-qm', 'docs: other side']);
  await git(other, ['push', '-q', 'origin', 'main']);
}

describe('closeRefinement', () => {
  it('makes an empty closing commit with its trailers, and publishes it to origin main', async () => {
    const r = await closeRefinement(ws, store, flush({ 'docs/project.md': 'v2\n' }), { summary: 'all good', aliases: ['alpha'] });
    expect(await git(store.dir, ['log', '-1', '--format=%s'])).toBe('docs: refinement closed, development starts [skip ci]');
    const body = await git(store.dir, ['log', '-1', '--format=%B']);
    expect(body).toContain('Closing-Draft: draft-1');
    expect(body).toContain('Summary: all good');
    expect(r.commit).toBe(await git(store.dir, ['rev-parse', 'HEAD']));
    expect(await git(origin, ['rev-parse', 'main'])).toBe(r.commit);
  });

  it('creates a detached snapshot of the documents at the closing commit, and writes the closing record', async () => {
    const r = await closeRefinement(ws, store, flush({ 'docs/project.md': 'v2\n' }), { summary: 'x', aliases: ['alpha'] });
    expect(r.snapshot).toBe(docsSnapshotDir(ws, 'draft-1'));
    expect(await fs.readFile(path.join(r.snapshot, 'docs/project.md'), 'utf8')).toBe('v2\n');
    expect(await git(r.snapshot, ['rev-parse', 'HEAD'])).toBe(r.commit);
    const record = JSON.parse(await fs.readFile(docsClosingPath(ws, 'draft-1'), 'utf8'));
    expect(record).toEqual({ commit: r.commit, aliases: ['alpha'], pendingTags: ['dev-start/alpha'] });
  });

  it('launches nothing when a document diverged under the draft', async () => {
    await fs.writeFile(path.join(store.dir, 'docs/project.md'), 'v3\n');
    await git(store.dir, ['commit', '-qam', 'docs: someone else']);
    const draft = flush({ 'docs/project.md': 'mine\n' }, { draftId: 'draft-2' });
    await expect(closeRefinement(ws, store, draft, { summary: 'x', aliases: [] })).rejects.toThrow(/nothing launches/);
    expect(await exists(docsClosingPath(ws, 'draft-2'))).toBe(false);
    expect(await exists(docsSnapshotDir(ws, 'draft-2'))).toBe(false);
  });

  it('publishes the closing commit after origin main moved on another document', async () => {
    await commitProjection(store, flush({ 'docs/flow.md': 'flow\n' }));
    await pushOther('other\n', 'docs/briefing.md');
    const r = await closeRefinement(ws, store, flush({}), { summary: 'x', aliases: [] });
    expect(await git(origin, ['rev-parse', 'main'])).toBe(r.commit);
    expect(await showFile(origin, 'main', 'docs/flow.md')).toBe('flow\n');
    expect(await showFile(origin, 'main', 'docs/briefing.md')).toBe('other\n');
  });
});

describe('createStartTags', () => {
  it('creates an annotated tag at the closing commit and publishes it', async () => {
    const r = await closeRefinement(ws, store, flush({}), { summary: 'x', aliases: ['alpha'] });
    expect(await createStartTags(store, ['alpha'], r.commit)).toEqual({ tags: ['dev-start/alpha'], pushed: true });
    expect(await git(origin, ['cat-file', '-t', 'refs/tags/dev-start/alpha'])).toBe('tag');
    expect(await git(origin, ['rev-parse', 'dev-start/alpha^{commit}'])).toBe(r.commit);
  });

  it('skips a tag already published at the closing commit', async () => {
    const r = await closeRefinement(ws, store, flush({}), { summary: 'x', aliases: ['alpha'] });
    await createStartTags(store, ['alpha'], r.commit);
    expect(await createStartTags(store, ['alpha'], r.commit)).toEqual({ tags: [], pushed: true });
  });

  it('takes the next free suffix for a name taken at another commit, and never moves it', async () => {
    const earlier = await git(store.dir, ['rev-parse', 'HEAD']);
    await git(store.dir, ['tag', '-a', 'dev-start/alpha', '-m', 'earlier start', earlier]);
    await git(store.dir, ['push', '-q', 'origin', 'dev-start/alpha']);
    const r = await closeRefinement(ws, store, flush({}), { summary: 'x', aliases: ['alpha'] });
    expect(await createStartTags(store, ['alpha'], r.commit)).toEqual({ tags: ['dev-start/alpha.2'], pushed: true });
    expect(await git(origin, ['rev-parse', 'dev-start/alpha^{commit}'])).toBe(earlier);
    expect(await git(origin, ['rev-parse', 'dev-start/alpha.2^{commit}'])).toBe(r.commit);
  });
});

describe('releaseDocs', () => {
  it('removes the store, the snapshots, the marker, the mirror and the closing records', async () => {
    await closeRefinement(ws, store, flush({ 'docs/project.md': 'v2\n' }), { summary: 'x', aliases: [] });
    await writeDocsMarker(ws, { layout: 'docs-repo', style: 'monolith', target: { owner: 'acme', name: 'kayron-hub' }, firstSha: null });
    await fs.mkdir(docsMirrorDir(ws), { recursive: true });
    await fs.writeFile(path.join(docsMirrorDir(ws), 'project.json'), '{}');
    await releaseDocs(ws);
    for (const p of [docsStoreDir(ws), docsSnapshotDir(ws, 'draft-1'), docsMarkerPath(ws), docsMirrorDir(ws), docsClosingPath(ws, 'draft-1')]) {
      expect(await exists(p)).toBe(false);
    }
    await expect(releaseDocs(ws)).resolves.toBeUndefined();
  });
});
