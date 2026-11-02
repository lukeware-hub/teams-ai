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

  it('unstages what a crash left in the index and keeps the file', async () => {
    await fs.writeFile(path.join(store.dir, 'docs/project.md'), 'staged\n');
    await git(store.dir, ['add', 'docs/project.md']);
    await openStore(ws, 'monolith', execCommand);
    expect(await git(store.dir, ['diff', '--cached', '--name-only'])).toBe('');
    expect(await fs.readFile(path.join(store.dir, 'docs/project.md'), 'utf8')).toBe('staged\n');
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

  it('excludes temporary files from the status', async () => {
    await fs.writeFile(path.join(store.dir, 'docs/project.md.123.tmp'), 'x');
    await openStore(ws, 'monolith', execCommand);
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

  it('refuses the whole commit when a document holds a credential, and names only the document', async () => {
    const before = await head();
    const token = `ghp_${'a'.repeat(36)}`;
    const err = await commitProjection(store, flush({ 'docs/project.md': `token ${token}\n`, 'docs/flow.md': 'ok\n' })).catch((e: Error) => e);
    expect(String(err)).toContain('docs/project.md');
    expect(String(err)).not.toContain(token);
    expect(await head()).toBe(before);
    expect(await exists('docs/flow.md')).toBe(false);
  });

  it('refuses a known secret value of 12 characters or more, without naming it', async () => {
    const before = await head();
    const secret = 'correct-horse-battery';
    const err = await commitProjection(store, flush({ 'docs/project.md': `note ${secret}\n` }, { known: [secret] })).catch((e: Error) => e);
    expect(String(err)).toContain('docs/project.md');
    expect(String(err)).not.toContain(secret);
    expect(await head()).toBe(before);
  });

  it('refuses a staged link that the flush does not own, and unstages it', async () => {
    const before = await head();
    const sha = await git(store.dir, ['hash-object', '-w', 'docs/project.md']);
    await git(store.dir, ['update-index', '--add', '--cacheinfo', `120000,${sha},docs/specify/alpha/spec.md`]);
    await expect(commitProjection(store, flush({ 'docs/project.md': 'v2\n' }))).rejects.toThrow(/not a document path or a link/);
    expect(await head()).toBe(before);
    expect(await git(store.dir, ['diff', '--cached', '--name-only'])).toBe('');
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
