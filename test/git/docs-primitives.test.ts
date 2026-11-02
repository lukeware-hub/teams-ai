import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAnnotatedTag, git, isAncestor, pushMain, pushTags, remoteTagTarget } from '../../server/git/git.js';
import { FakeExec } from '../fixtures/fake-exec.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

let remote: Remote;

beforeEach(async () => {
  remote = await makeRemote({ 'README.md': 'hello\n' });
});
afterEach(() => remote.cleanup());

const head = (dir: string) => git(dir, ['rev-parse', 'HEAD']);

async function commit(dir: string, message: string): Promise<string> {
  await git(dir, ['commit', '--allow-empty', '-q', '-m', message]);
  return head(dir);
}

describe('pushMain', () => {
  it('fast-forwards origin main to the given sha', async () => {
    const sha = await commit(remote.repo, 'docs: next');
    expect(await pushMain(remote.repo, sha)).toEqual({ ok: true });
    expect(await git(remote.origin, ['rev-parse', 'main'])).toBe(sha);
  });

  it('classifies a divergent push as non-fast-forward and leaves origin alone', async () => {
    const other = path.join(remote.root, 'other');
    await git(remote.root, ['clone', '-q', remote.origin, other]);
    await commit(other, 'docs: other side');
    await git(other, ['push', '-q', 'origin', 'main']);
    const before = await git(remote.origin, ['rev-parse', 'main']);
    const sha = await commit(remote.repo, 'docs: mine');
    const r = await pushMain(remote.repo, sha);
    expect(r).toMatchObject({ ok: false, kind: 'non-fast-forward' });
    expect(await git(remote.origin, ['rev-parse', 'main'])).toBe(before);
  });

  it('classifies a GH013 rule rejection as protected and does not retry', async () => {
    const fake = new FakeExec().on(
      (s) => s.args.includes('push'),
      () => ({ exitCode: 1, stderr: 'remote: error: GH013: Repository rule violations found for refs/heads/main.\n' }),
    );
    const r = await pushMain(remote.repo, 'abc123', fake.exec);
    expect(r).toMatchObject({ ok: false, kind: 'protected' });
    expect(fake.calls.filter((c) => c.args.includes('push'))).toHaveLength(1);
  });
});

describe('isAncestor', () => {
  it('is true for an earlier commit and false for a later one', async () => {
    const base = await head(remote.repo);
    const next = await commit(remote.repo, 'docs: next');
    expect(await isAncestor(remote.repo, base, next)).toBe(true);
    expect(await isAncestor(remote.repo, next, base)).toBe(false);
  });
});

describe('createAnnotatedTag and pushTags', () => {
  it('creates an annotated tag at the sha and pushes it to origin', async () => {
    const sha = await head(remote.repo);
    await createAnnotatedTag(remote.repo, 'dev-start/a', sha, 'start');
    expect(await git(remote.repo, ['cat-file', '-t', 'refs/tags/dev-start/a'])).toBe('tag');
    expect(await pushTags(remote.repo, ['dev-start/a'])).toEqual({ ok: true });
    expect(await git(remote.origin, ['rev-parse', 'refs/tags/dev-start/a^{commit}'])).toBe(sha);
  });
});

describe('remoteTagTarget', () => {
  it('gives the peeled commit of an annotated tag, and null for a missing tag', async () => {
    const sha = await head(remote.repo);
    await createAnnotatedTag(remote.repo, 'dev-start/b', sha, 'start');
    await pushTags(remote.repo, ['dev-start/b']);
    expect(await remoteTagTarget(remote.repo, 'dev-start/b')).toBe(sha);
    expect(await remoteTagTarget(remote.repo, 'dev-start/missing')).toBeNull();
  });
});

describe('timeout', () => {
  it('passes the given timeout to the command, and 120 seconds when none is given', async () => {
    const fake = new FakeExec();
    await git(remote.repo, ['status'], fake.exec, { timeoutMs: 4321 });
    await git(remote.repo, ['status'], fake.exec);
    expect(fake.calls.map((c) => c.timeoutMs)).toEqual([4321, 120_000]);
  });
});
