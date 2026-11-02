import { describe, expect, it } from 'vitest';
import { GitHubError, createPrivateRepo, repoInfo } from '../../server/git/github.js';
import { FakeExec } from '../fixtures/fake-exec.js';

const VIEW = {
  nameWithOwner: 'acme/todo-api',
  url: 'https://github.com/acme/todo-api',
  isPrivate: true,
  isArchived: false,
  isEmpty: false,
  viewerPermission: 'ADMIN',
  defaultBranchRef: { name: 'main' },
};
const cwd = '/home/u/ws/repo';

describe('repoInfo', () => {
  it('parses the fields gh repo view prints as JSON', async () => {
    const fake = new FakeExec().onArgs('gh', ['repo', 'view'], () => ({ stdout: JSON.stringify(VIEW) }));
    expect(await repoInfo(cwd, 'acme/todo-api', fake.exec)).toEqual(VIEW);
    expect(fake.lines('gh')[0]).toBe('repo view acme/todo-api --json nameWithOwner,url,isPrivate,isArchived,isEmpty,viewerPermission,defaultBranchRef');
  });

  it('accepts an empty repository, which has no default branch', async () => {
    const empty = { ...VIEW, isEmpty: true, defaultBranchRef: null };
    const fake = new FakeExec().onArgs('gh', ['repo', 'view'], () => ({ stdout: JSON.stringify(empty) }));
    expect(await repoInfo(cwd, 'acme/todo-api', fake.exec)).toEqual(empty);
  });

  it('returns null when GitHub reports the repository as not found', async () => {
    const byName = new FakeExec().onArgs('gh', ['repo', 'view'], () => ({ exitCode: 1, stderr: 'GraphQL: Could not resolve to a Repository with the name acme/x' }));
    expect(await repoInfo(cwd, 'acme/x', byName.exec)).toBeNull();
    const byCode = new FakeExec().onArgs('gh', ['repo', 'view'], () => ({ exitCode: 1, stderr: 'HTTP 404: Not Found' }));
    expect(await repoInfo(cwd, 'acme/x', byCode.exec)).toBeNull();
  });

  it('throws on any other failure', async () => {
    const fake = new FakeExec().onArgs('gh', ['repo', 'view'], () => ({ exitCode: 1, stderr: 'HTTP 401: Bad credentials' }));
    await expect(repoInfo(cwd, 'acme/x', fake.exec)).rejects.toThrow(GitHubError);
  });

  it('throws when the JSON lacks a field', async () => {
    const { url: _url, ...partial } = VIEW;
    const fake = new FakeExec().onArgs('gh', ['repo', 'view'], () => ({ stdout: JSON.stringify(partial) }));
    await expect(repoInfo(cwd, 'acme/todo-api', fake.exec)).rejects.toThrow();
  });
});

describe('createPrivateRepo', () => {
  it('creates an empty private repository, never passing --source or --push, and returns its url', async () => {
    const fake = new FakeExec()
      .onArgs('gh', ['repo', 'create'], () => ({ stdout: 'https://github.com/acme/todo-api\n' }))
      .onArgs('gh', ['repo', 'view'], () => ({ stdout: JSON.stringify(VIEW) }));
    expect(await createPrivateRepo({ owner: 'acme', name: 'todo-api' }, fake.exec)).toBe('https://github.com/acme/todo-api');
    const create = fake.calls.find((c) => c.args[0] === 'repo' && c.args[1] === 'create')!;
    expect(create.args).toEqual(['repo', 'create', 'acme/todo-api', '--private']);
  });

  it('throws when gh cannot create the repository', async () => {
    const fake = new FakeExec().onArgs('gh', ['repo', 'create'], () => ({ exitCode: 1, stderr: 'name already exists' }));
    await expect(createPrivateRepo({ owner: 'acme', name: 'todo-api' }, fake.exec)).rejects.toThrow(GitHubError);
  });
});
