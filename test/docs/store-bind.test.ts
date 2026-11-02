import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bind } from '../../server/docs/store.js';
import { docsStoreDir, readDocsMarker } from '../../server/docs/project-state.js';
import type { Exec } from '../../server/exec/command.js';
import { git, showFile } from '../../server/git/git.js';
import { FakeGhRepos } from '../fixtures/fake-gh-repos.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const target = { owner: 'acme', name: 'kayron-hub' };
const documents = {
  'docs/project.md': 'project\n',
  'docs/flow.md': 'flow\n',
  'docs/briefing.md': 'briefing\n',
  'docs/design.md': 'design\n',
  'docs/stack.md': 'stack\n',
};
const input = { style: 'monolith' as const, target, draftId: 'draft-1', documents };

let ws: { root: string };
let gh: FakeGhRepos;
let remotes: Remote[];

beforeEach(async () => {
  ws = { root: await fs.mkdtemp(path.join(os.tmpdir(), 'docs-bind-')) };
  gh = new FakeGhRepos(ws.root);
  remotes = [];
});

afterEach(async () => {
  await Promise.all(remotes.map((r) => r.cleanup()));
  await fs.rm(ws.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A bare origin that already exists on the fake GitHub, empty or with unrelated history. */
async function existing(withHistory: boolean): Promise<string> {
  if (withHistory) {
    const remote = await makeRemote({ 'README.md': 'unrelated\n' });
    remotes.push(remote);
    return remote.origin;
  }
  const origin = path.join(ws.root, 'empty.git');
  await fs.mkdir(origin, { recursive: true });
  await git(origin, ['init', '--bare', '-b', 'main']);
  return origin;
}

const originMain = (origin: string) => git(origin, ['rev-parse', 'main']).catch(() => null);

describe('bind', () => {
  it('writes the marker before any remote effect, and sets its first sha after the push', async () => {
    const seen: unknown[] = [];
    const probe: Exec = async (spec) => {
      if (spec.bin === 'gh') seen.push(await readDocsMarker(ws));
      return gh.exec(spec);
    };
    const r = await bind(ws, input, probe);
    expect(seen[0]).toEqual({ layout: 'docs-repo', style: 'monolith', target, firstSha: null });
    expect(await readDocsMarker(ws)).toEqual({ layout: 'docs-repo', style: 'monolith', target, firstSha: r.sha });
  });

  it('creates one private repository when GitHub reports it missing, and publishes the documents', async () => {
    const r = await bind(ws, input, gh.exec);
    expect(r.created).toBe(true);
    expect(gh.creates).toEqual(['acme/kayron-hub']);
    const origin = gh.repos.get('acme/kayron-hub')!.origin;
    expect(gh.repos.get('acme/kayron-hub')!.isPrivate).toBe(true);
    expect(await originMain(origin)).toBe(r.sha);
    expect(await showFile(origin, 'main', 'docs/project.md')).toBe('project\n');
    expect(await git(docsStoreDir(ws), ['log', '-1', '--format=%s'])).toBe('docs(refine): initial documents [skip ci]');
  });

  it('adopts an existing empty repository without creating one', async () => {
    const origin = await existing(false);
    gh.register('acme/kayron-hub', origin);
    const r = await bind(ws, input, gh.exec);
    expect(r.created).toBe(false);
    expect(gh.creates).toEqual([]);
    expect(await originMain(origin)).toBe(r.sha);
  });

  it('refuses a repository with other history, and pushes nothing to it', async () => {
    const origin = await existing(true);
    gh.register('acme/kayron-hub', origin);
    const before = await originMain(origin);
    await expect(bind(ws, input, gh.exec)).rejects.toThrow(/other history/);
    expect(await originMain(origin)).toBe(before);
    expect(await readDocsMarker(ws)).toBeNull();
  });

  it('refuses when the repository create answers HTTP 422, and enables nothing: no repository, no marker', async () => {
    const refuse: Exec = async (spec) => {
      if (spec.bin === 'gh' && spec.args[0] === 'repo' && spec.args[1] === 'create') {
        return { exitCode: 1, signal: null, stdout: '', stderr: 'HTTP 422: Repository creation failed.', timedOut: false, durationMs: 1, truncated: false };
      }
      return gh.exec(spec);
    };
    await expect(bind(ws, input, refuse)).rejects.toThrow(/não foi possível criar o repositório privado/);
    expect(gh.creates).toEqual([]);
    expect(await readDocsMarker(ws)).toBeNull();
  });

  it('refuses a repository that is not private', async () => {
    gh.register('acme/kayron-hub', await existing(false), { isPrivate: false });
    await expect(bind(ws, input, gh.exec)).rejects.toThrow(/é público/);
  });

  it('leaves no marker after a refused attach, so a later bind can pick another target', async () => {
    gh.register('acme/kayron-hub', await existing(false), { isPrivate: false });
    await expect(bind(ws, input, gh.exec)).rejects.toThrow(/é público/);
    expect(await readDocsMarker(ws)).toBeNull();
    const r = await bind(ws, { ...input, target: { owner: 'acme', name: 'other' } }, gh.exec);
    expect(r.created).toBe(true);
    expect((await readDocsMarker(ws))?.target).toEqual({ owner: 'acme', name: 'other' });
  });

  it('refuses a later bind with another style or target, and keeps the first one', async () => {
    await bind(ws, input, gh.exec);
    await expect(bind(ws, { ...input, style: 'microservices' }, gh.exec)).rejects.toThrow(/fixed/);
    await expect(bind(ws, { ...input, target: { owner: 'acme', name: 'other' } }, gh.exec)).rejects.toThrow(/fixed/);
    expect((await readDocsMarker(ws))?.target).toEqual(target);
  });
});
