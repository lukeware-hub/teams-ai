import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { commitProjection, openStore, projectFiles, pushWithRecovery, type Projection, type Store } from '../../server/docs/store.js';
import { docsStoreDir } from '../../server/docs/project-state.js';
import { execCommand, type CommandResult, type Exec } from '../../server/exec/command.js';
import { git, showFile } from '../../server/git/git.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

/** One shared origin; each test clones its own copy, so tests stay independent and cheap to set up. */
let base: Remote;
let ws: { root: string };
let origin: string;
let store: Store;

beforeAll(async () => {
  base = await makeRemote({ 'docs/project.md': 'v1\n' });
});
afterAll(() => base.cleanup());

/** Gives each test a fresh origin and a store clone of it, opened the way the app opens it. */
function useStore(): void {
  beforeEach(async () => {
    ws = { root: await fs.mkdtemp(path.join(os.tmpdir(), 'docs-store-')) };
    origin = path.join(ws.root, 'origin.git');
    await git(ws.root, ['clone', '-q', '--bare', base.origin, origin]);
    const dir = docsStoreDir(ws);
    await git(ws.root, ['clone', '-q', origin, dir]);
    store = await openStore(ws, 'monolith', execCommand);
  });
  afterEach(() => fs.rm(ws.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
}

const head = () => git(store.dir, ['rev-parse', 'HEAD']);
const exists = (rel: string): Promise<boolean> => fs.stat(path.join(store.dir, rel)).then(() => true, () => false);
const flush = (files: Record<string, string>, extra: Partial<Projection> = {}): Projection => ({
  draftId: 'draft-1',
  stepKey: 'step-1',
  scope: 'refine',
  label: 'project updated',
  files,
  bases: { 'docs/project.md': 'v1\n' },
  ...extra,
});
const result = (exitCode: number, stderr = ''): Promise<CommandResult> =>
  Promise.resolve({ exitCode, signal: null, stdout: '', stderr, timedOut: false, durationMs: 1, truncated: false });

/** A second clone of origin, to move origin main while the store stands still. */
async function pushOther(text: string, file = 'docs/project.md'): Promise<void> {
  const other = path.join(ws.root, 'other');
  await git(ws.root, ['clone', '-q', origin, other]);
  await fs.writeFile(path.join(other, file), text);
  await git(other, ['commit', '-qam', 'docs: other side']);
  await git(other, ['push', '-q', 'origin', 'main']);
}

describe('projectFiles', () => {
  it('accepts the five documents and the three files of a spec in a monolith', () => {
    const files = { 'docs/project.md': 'a', 'docs/specify/alpha/spec.md': 'b' };
    expect(projectFiles('monolith', files).map((f) => f.path)).toEqual(Object.keys(files));
  });

  it('refuses any other path', () => {
    expect(() => projectFiles('monolith', { 'docs/other.md': 'x' })).toThrow(/not a document path/);
    expect(() => projectFiles('monolith', { 'README.md': 'x' })).toThrow(/not a document path/);
    expect(() => projectFiles('monolith', { 'docs/billing-api/specify/alpha/plan.md': 'x' })).toThrow(/not a document path/);
  });

  it('accepts service folders only for microservices', () => {
    expect(() => projectFiles('microservices', { 'docs/billing-api/specify/alpha/plan.md': 'x' })).not.toThrow();
    expect(() => projectFiles('microservices', { 'docs/project.md': 'x' })).not.toThrow();
  });

  it('refuses a file above 1 MiB', () => {
    expect(() => projectFiles('monolith', { 'docs/project.md': 'x'.repeat(1024 * 1024 + 1) })).toThrow(/1 MiB/);
  });
});

describe('openStore', () => {
  useStore();

  it('removes an index lock left by a crash, and refuses to open over a recent one', async () => {
    const lock = path.join(store.dir, '.git', 'index.lock');
    await fs.writeFile(lock, '');
    await fs.utimes(lock, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
    await openStore(ws, 'monolith', execCommand);
    expect(await exists('.git/index.lock')).toBe(false);
    await fs.writeFile(lock, '');
    await expect(openStore(ws, 'monolith', execCommand)).rejects.toThrow();
    expect(await exists('.git/index.lock')).toBe(true);
  });

  it('unstages what a crash left in the index, keeps the file, and ignores temporary files', async () => {
    await fs.writeFile(path.join(store.dir, 'docs/project.md'), 'staged\n');
    await git(store.dir, ['add', 'docs/project.md']);
    await fs.writeFile(path.join(store.dir, 'docs/project.md.123.tmp'), 'x');
    await openStore(ws, 'monolith', execCommand);
    expect(await git(store.dir, ['diff', '--cached', '--name-only'])).toBe('');
    expect(await fs.readFile(path.join(store.dir, 'docs/project.md'), 'utf8')).toBe('staged\n');
    expect(await git(store.dir, ['status', '--porcelain'])).toBe('M docs/project.md');
  });

  it('lists the temporary files once in the local exclude file, however often it opens', async () => {
    await openStore(ws, 'monolith', execCommand);
    const lines = (await fs.readFile(path.join(store.dir, '.git', 'info', 'exclude'), 'utf8')).split('\n');
    expect(lines.filter((line) => line === '*.tmp')).toHaveLength(1);
  });

  it('aborts a rebase a crash left in progress', async () => {
    await commitProjection(store, flush({ 'docs/project.md': 'local\n' }));
    await pushOther('remote\n');
    await git(store.dir, ['fetch', '-q', 'origin']);
    await expect(git(store.dir, ['rebase', 'origin/main'])).rejects.toThrow();
    await openStore(ws, 'monolith', execCommand);
    expect(await exists('.git/rebase-merge')).toBe(false);
    expect(await git(store.dir, ['status', '--porcelain'])).toBe('');
  });

});

describe('commitProjection', () => {
  useStore();

  it('commits the documents with the subject and the trailers', async () => {
    const r = await commitProjection(store, flush({ 'docs/project.md': 'v2\n' }));
    expect(r.sha).toBe(await head());
    expect(await git(store.dir, ['log', '-1', '--format=%s'])).toBe('docs(refine): project updated [skip ci]');
    const body = await git(store.dir, ['log', '-1', '--format=%B']);
    expect(body).toContain('Refine-Draft: draft-1');
    expect(body).toContain('Step: step-1');
    expect(await showFile(store.dir, 'HEAD', 'docs/project.md')).toBe('v2\n');
  });

  it('makes no commit for an empty diff, and an empty commit only for a milestone', async () => {
    const before = await head();
    expect((await commitProjection(store, flush({ 'docs/project.md': 'v1\n' }))).sha).toBeNull();
    expect(await head()).toBe(before);
    expect((await commitProjection(store, flush({ 'docs/project.md': 'v1\n' }, { milestone: true }))).sha).not.toBeNull();
    expect(await head()).not.toBe(before);
  });

  it('refuses the whole commit for a credential or a known secret value, and names only the document', async () => {
    const before = await head();
    const token = `ghp_${'a'.repeat(36)}`;
    const secret = 'correct-horse-battery';
    const shape = await commitProjection(store, flush({ 'docs/project.md': `token ${token}\n`, 'docs/flow.md': 'ok\n' })).catch((e: Error) => e);
    const known = await commitProjection(store, flush({ 'docs/project.md': `note ${secret}\n` }, { known: [secret] })).catch((e: Error) => e);
    expect(String(shape)).toContain('docs/project.md');
    expect(String(shape)).not.toContain(token);
    expect(String(known)).toContain('docs/project.md');
    expect(String(known)).not.toContain(secret);
    expect(await head()).toBe(before);
    expect(await exists('docs/flow.md')).toBe(false);
  });

  it('refuses a staged link that the flush does not own, and unstages it', async () => {
    const before = await head();
    const sha = await git(store.dir, ['hash-object', '-w', 'docs/project.md']);
    await git(store.dir, ['update-index', '--add', '--cacheinfo', `120000,${sha},docs/specify/alpha/spec.md`]);
    await expect(commitProjection(store, flush({ 'docs/project.md': 'v2\n' }))).rejects.toThrow(/not a document path or a link/);
    expect(await head()).toBe(before);
    expect(await git(store.dir, ['diff', '--cached', '--name-only'])).toBe('');
  });

  it('leaves the working tree as HEAD has it after a refused flush', async () => {
    const before = await head();
    const sha = await git(store.dir, ['hash-object', '-w', 'docs/project.md']);
    await git(store.dir, ['update-index', '--add', '--cacheinfo', `120000,${sha},docs/specify/alpha/spec.md`]);
    await expect(commitProjection(store, flush({ 'docs/project.md': 'v2\n', 'docs/flow.md': 'flow\n' }))).rejects.toThrow(/not a document path or a link/);
    expect(await head()).toBe(before);
    expect(await git(store.dir, ['status', '--porcelain'])).toBe('');
    expect(await exists('docs/flow.md')).toBe(false);
  });
});

describe('pushWithRecovery', () => {
  useStore();

  it('pushes the new commit to origin main', async () => {
    await commitProjection(store, flush({ 'docs/project.md': 'v2\n' }));
    const r = await pushWithRecovery(store);
    expect(r).toEqual({ ok: true, sha: await head() });
    expect(await git(origin, ['rev-parse', 'main'])).toBe(await head());
  });

  it('rebases onto a newer origin main and pushes again', async () => {
    await commitProjection(store, flush({ 'docs/flow.md': 'flow\n' }));
    await pushOther('other\n');
    const r = await pushWithRecovery(store);
    expect(r.ok).toBe(true);
    expect(await showFile(origin, 'main', 'docs/flow.md')).toBe('flow\n');
    expect(await showFile(origin, 'main', 'docs/project.md')).toBe('other\n');
  });

  it('resets to origin main and reports busy when the rebase conflicts', async () => {
    await commitProjection(store, flush({ 'docs/project.md': 'mine\n' }));
    await pushOther('theirs\n');
    const r = await pushWithRecovery(store);
    expect(r).toMatchObject({ ok: false, kind: 'busy' });
    expect(await head()).toBe(await git(store.dir, ['rev-parse', 'origin/main']));
    expect(await showFile(origin, 'main', 'docs/project.md')).toBe('theirs\n');
  });

  it('reports a protected branch at once, without retrying', async () => {
    const pushes: string[] = [];
    const guarded: Exec = (spec) => {
      if (!spec.args.includes('push')) return execCommand(spec);
      pushes.push('push');
      return result(1, 'remote: error: GH006: Protected branch update failed');
    };
    await commitProjection(store, flush({ 'docs/project.md': 'v2\n' }));
    const r = await pushWithRecovery({ ...store, exec: guarded });
    expect(r).toMatchObject({ ok: false, kind: 'protected' });
    expect(pushes).toHaveLength(1);
  });
});

describe('ownership', () => {
  useStore();

  const spec = (alias: string, text: string) => ({ [`docs/specify/${alias}/spec.md`]: text });

  it('writes a document only when the store still holds what the draft started from', async () => {
    await commitProjection(store, flush({ 'docs/project.md': 'v2\n' }));
    await fs.writeFile(path.join(store.dir, 'docs/project.md'), 'v3\n');
    await git(store.dir, ['commit', '-qam', 'docs: someone else']);
    const r = await commitProjection(store, flush({ 'docs/project.md': 'mine\n', 'docs/flow.md': 'flow\n' }, { draftId: 'draft-2' }));
    expect(r.diverged).toEqual(['docs/project.md']);
    expect(await showFile(store.dir, 'HEAD', 'docs/project.md')).toBe('v3\n');
    expect(await showFile(store.dir, 'HEAD', 'docs/flow.md')).toBe('flow\n');
  });

  it('writes a document the same draft last committed, even from an older base', async () => {
    await commitProjection(store, flush({ 'docs/project.md': 'v2\n' }));
    const r = await commitProjection(store, flush({ 'docs/project.md': 'v3\n' }, { bases: { 'docs/project.md': 'v0\n' } }));
    expect(r.diverged).toEqual([]);
    expect(await showFile(store.dir, 'HEAD', 'docs/project.md')).toBe('v3\n');
  });

  it('gives an alias to the draft that committed it first', async () => {
    await commitProjection(store, flush(spec('alpha', 'one\n')));
    const other = await commitProjection(store, flush(spec('alpha', 'two\n'), { draftId: 'draft-2' }));
    expect(other.aliasTaken).toEqual(['alpha']);
    expect(await showFile(store.dir, 'HEAD', 'docs/specify/alpha/spec.md')).toBe('one\n');
    const own = await commitProjection(store, flush(spec('alpha', 'three\n')));
    expect(own.aliasTaken).toEqual([]);
    expect(await showFile(store.dir, 'HEAD', 'docs/specify/alpha/spec.md')).toBe('three\n');
  });

  it('retires the folder of an alias that moved to another service', async () => {
    store = await openStore(ws, 'microservices', execCommand);
    await commitProjection(store, flush({ 'docs/billing-api/specify/alpha/spec.md': 'one\n' }));
    await commitProjection(store, flush({ 'docs/web-bff/specify/alpha/spec.md': 'one\n' }));
    expect(await exists('docs/billing-api/specify/alpha/spec.md')).toBe(false);
    expect(await exists('docs/web-bff/specify/alpha/spec.md')).toBe(true);
  });

  it('refuses a frozen alias even to the draft that owns it', async () => {
    await commitProjection(store, flush(spec('alpha', 'one\n')));
    const r = await commitProjection(store, flush(spec('alpha', 'two\n'), { frozen: ['alpha'] }));
    expect(r).toMatchObject({ sha: null, aliasTaken: ['alpha'] });
  });

  it('retires only the alias folders its draft owns', async () => {
    await commitProjection(store, flush(spec('alpha', 'one\n')));
    const other = await commitProjection(store, flush({}, { draftId: 'draft-2', retire: ['docs/specify/alpha'] }));
    expect(other.aliasTaken).toEqual(['alpha']);
    expect(await exists('docs/specify/alpha/spec.md')).toBe(true);
    await commitProjection(store, flush({}, { retire: ['docs/specify/alpha'] }));
    expect(await exists('docs/specify/alpha/spec.md')).toBe(false);
  });

  it('refuses the whole flush when a retire folder is not an alias folder, and removes nothing', async () => {
    await commitProjection(store, flush(spec('alpha', 'one\n')));
    const before = await head();
    await expect(commitProjection(store, flush({}, { retire: ['docs'] }))).rejects.toThrow(/not an alias folder, so nothing is removed: docs$/);
    await expect(commitProjection(store, flush({}, { retire: ['docs/specify'] }))).rejects.toThrow(/not an alias folder, so nothing is removed: docs\/specify$/);
    expect(await head()).toBe(before);
    expect(await exists('docs/specify/alpha/spec.md')).toBe(true);
    expect(await exists('docs/project.md')).toBe(true);
  });
});

describe('draft id of a flush', () => {
  useStore();

  it('refuses a draft id that is not a slug before anything is written', async () => {
    const before = await head();
    await expect(commitProjection(store, { ...flush({ 'docs/project.md': 'x\n' }), draftId: '../escape' })).rejects.toThrow(RangeError);
    expect(await head()).toBe(before);
  });
});
