import { describe, expect, it } from 'vitest';
import { GitHubError, ensurePr, ensureRepo, mergePr, prState } from '../../server/git/github.js';
import { FakeExec } from '../fixtures/fake-exec.js';

const cwd = '/home/u/ws/repo';

describe('ensureRepo', () => {
  it('returns the existing repository without creating', async () => {
    const fake = new FakeExec().onArgs('gh', ['repo', 'view'], () => ({ stdout: '{"nameWithOwner":"acme/todo-api","url":"https://github.com/acme/todo-api"}' }));
    const r = await ensureRepo({ owner: 'acme', name: 'todo-api', private: true, cwd }, fake.exec);
    expect(r).toEqual({ fullName: 'acme/todo-api', url: 'https://github.com/acme/todo-api', created: false });
    expect(fake.lines('gh').some((l) => l.startsWith('repo create'))).toBe(false);
  });

  it('creates a private repository when missing', async () => {
    const fake = new FakeExec()
      .onArgs('gh', ['repo', 'view'], () => ({ exitCode: 1, stderr: 'GraphQL: Could not resolve to a Repository' }))
      .onArgs('gh', ['repo', 'create'], () => ({ stdout: 'https://github.com/acme/todo-api\n' }));
    const r = await ensureRepo({ owner: 'acme', name: 'todo-api', private: true, cwd }, fake.exec);
    expect(r).toEqual({ fullName: 'acme/todo-api', url: 'https://github.com/acme/todo-api', created: true });
    expect(fake.lines('gh')[1]).toBe('repo create acme/todo-api --private --source . --remote origin --push');
  });

  it('uses the authenticated user when no owner is given', async () => {
    const fake = new FakeExec()
      .onArgs('gh', ['api', 'user'], () => ({ stdout: '{"login":"me"}' }))
      .onArgs('gh', ['repo', 'view'], () => ({ stdout: '{"nameWithOwner":"me/todo-api","url":"u"}' }));
    const r = await ensureRepo({ name: 'todo-api', private: true, cwd }, fake.exec);
    expect(r.fullName).toBe('me/todo-api');
  });
});

describe('ensurePr', () => {
  const input = { cwd, head: 'task/spec-001-T1-a', base: 'main', title: 'T1', body: 'body' };

  it('reuses an open PR for the head branch', async () => {
    const fake = new FakeExec().onArgs('gh', ['pr', 'list'], () => ({ stdout: '[{"number":45,"url":"https://github.com/acme/todo-api/pull/45"}]' }));
    expect(await ensurePr(input, fake.exec)).toEqual({ number: 45, url: 'https://github.com/acme/todo-api/pull/45', created: false });
    expect(fake.lines('gh')).toHaveLength(1);
  });

  it('creates the PR with the body on stdin when none is open', async () => {
    const fake = new FakeExec()
      .onArgs('gh', ['pr', 'list'], () => ({ stdout: '[]' }))
      .onArgs('gh', ['pr', 'create'], () => ({ stdout: 'https://github.com/acme/todo-api/pull/46\n' }));
    const r = await ensurePr(input, fake.exec);
    expect(r).toEqual({ number: 46, url: 'https://github.com/acme/todo-api/pull/46', created: true });
    const create = fake.calls.find((c) => c.args[1] === 'create')!;
    expect(create.args).toEqual(['pr', 'create', '--head', input.head, '--base', 'main', '--title', 'T1', '--body-file', '-']);
    expect(create.stdin).toBe('body');
  });

  it('throws when gh fails', async () => {
    const fake = new FakeExec().onArgs('gh', ['pr', 'list'], () => ({ exitCode: 1, stderr: 'not logged in' }));
    await expect(ensurePr(input, fake.exec)).rejects.toThrow(GitHubError);
  });
});

describe('prState and mergePr', () => {
  it('reads the PR state and head sha', async () => {
    const fake = new FakeExec().onArgs('gh', ['pr', 'view'], () => ({ stdout: '{"state":"OPEN","headRefOid":"abc"}' }));
    expect(await prState({ cwd, number: 45 }, fake.exec)).toEqual({ state: 'OPEN', headSha: 'abc' });
  });

  it('merges with squash and the head commit guard', async () => {
    const fake = new FakeExec()
      .onArgs('gh', ['pr', 'view'], () => ({ stdout: '{"state":"OPEN","headRefOid":"abc"}' }))
      .onArgs('gh', ['pr', 'merge'], () => ({ stdout: '' }));
    expect(await mergePr({ cwd, number: 45, headSha: 'abc' }, fake.exec)).toEqual({ merged: true, already: false });
    expect(fake.lines('gh')[1]).toBe('pr merge 45 --squash --match-head-commit abc');
  });

  it('reports an already merged PR without calling merge', async () => {
    const fake = new FakeExec().onArgs('gh', ['pr', 'view'], () => ({ stdout: '{"state":"MERGED","headRefOid":"abc"}' }));
    expect(await mergePr({ cwd, number: 45, headSha: 'abc' }, fake.exec)).toEqual({ merged: true, already: true });
    expect(fake.lines('gh')).toHaveLength(1);
  });

  it('refuses when the head moved and reports the reason', async () => {
    const fake = new FakeExec()
      .onArgs('gh', ['pr', 'view'], () => ({ stdout: '{"state":"OPEN","headRefOid":"def"}' }))
      .onArgs('gh', ['pr', 'merge'], () => ({ exitCode: 1, stderr: 'head commit mismatch' }));
    const r = await mergePr({ cwd, number: 45, headSha: 'abc' }, fake.exec);
    expect(r.merged).toBe(false);
    expect(r.reason).toMatch(/head/);
    expect(fake.lines('gh')).toHaveLength(1);
  });
});
