import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changedFiles, commitAll, createWorktree, fetch, git, headSha, push, rebaseOnto, removeWorktree } from '../../server/git/git.js';

let root: string;
let origin: string;
let repo: string;

async function write(dir: string, file: string, text: string) {
  await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await fs.writeFile(path.join(dir, file), text);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-git-'));
  origin = path.join(root, 'origin.git');
  repo = path.join(root, 'repo');
  await git(root, ['init', '--bare', '-b', 'main', origin]);
  await git(root, ['clone', '-q', origin, repo]);
  await git(repo, ['checkout', '-q', '-b', 'main']);
  await write(repo, 'README.md', 'hello\n');
  await commitAll(repo, 'chore: init');
  await push(repo, 'main');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('commitAll', () => {
  it('commits with the fixed identity and returns the sha; returns null when clean', async () => {
    await write(repo, 'a.txt', 'a');
    const sha = await commitAll(repo, 'feat: a');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await git(repo, ['log', '-1', '--format=%an <%ae> %s'])).toBe('teams-ai <teams-ai@localhost> feat: a');
    expect(await commitAll(repo, 'nothing')).toBeNull();
  });
});

describe('worktrees', () => {
  it('creates a worktree on a new branch from main and removes it', async () => {
    const wt = path.join(root, 'wt-T1');
    await createWorktree(repo, wt, 'task/spec-001-T1-a', 'main');
    expect(await git(wt, ['branch', '--show-current'])).toBe('task/spec-001-T1-a');
    expect(await headSha(wt)).toBe(await headSha(repo));
    await createWorktree(repo, wt, 'task/spec-001-T1-a', 'main'); // idempotent
    await removeWorktree(repo, wt);
    await removeWorktree(repo, wt); // no error when absent
    await expect(fs.access(wt)).rejects.toThrow();
  });
});

describe('changedFiles and rebase', () => {
  it('lists files changed since the base and rebases cleanly when main moved elsewhere', async () => {
    const wt = path.join(root, 'wt');
    await createWorktree(repo, wt, 'task/x', 'main');
    await write(wt, 'src/a.ts', 'a');
    await commitAll(wt, 'feat: a');
    expect(await changedFiles(wt, 'main')).toEqual(['src/a.ts']);
    await write(repo, 'src/b.ts', 'b');
    await commitAll(repo, 'feat: b');
    const result = await rebaseOnto(wt, 'main');
    expect(result).toEqual({ ok: true });
    expect(await changedFiles(wt, 'main')).toEqual(['src/a.ts']);
    expect(await git(wt, ['log', '--format=%s', 'main..HEAD'])).toBe('feat: a');
  });

  it('aborts on conflict, leaves the worktree clean and lists the conflicting files', async () => {
    const wt = path.join(root, 'wt');
    await createWorktree(repo, wt, 'task/x', 'main');
    await write(wt, 'README.md', 'from task\n');
    await commitAll(wt, 'docs: task');
    await write(repo, 'README.md', 'from main\n');
    await commitAll(repo, 'docs: main');
    const result = await rebaseOnto(wt, 'main');
    expect(result).toEqual({ ok: false, conflicts: ['README.md'] });
    expect(await git(wt, ['status', '--porcelain'])).toBe('');
    expect(await fs.readFile(path.join(wt, 'README.md'), 'utf8')).toBe('from task\n');
  });
});

describe('push and fetch', () => {
  it('pushes a branch to origin with force-with-lease and fetch sees it', async () => {
    const wt = path.join(root, 'wt');
    await createWorktree(repo, wt, 'task/y', 'main');
    await write(wt, 'y.txt', 'y');
    const sha = await commitAll(wt, 'feat: y');
    await push(wt, 'task/y');
    expect(await git(origin, ['rev-parse', 'task/y'])).toBe(sha);
    await fetch(repo);
    expect(await git(repo, ['rev-parse', 'origin/task/y'])).toBe(sha);
  });
});
