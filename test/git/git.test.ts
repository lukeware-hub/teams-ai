import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_COMMIT_EXCLUDES,
  GitError,
  changedFiles,
  commitAll,
  createWorktree,
  fetch,
  git,
  headSha,
  push,
  rebaseOnto,
  remoteMainSha,
  removeWorktree,
  replayOnto,
  conflictMarkerFiles,
} from '../../server/git/git.js';

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

  it('never stages secrets, dependency trees or gate reports', async () => {
    await write(repo, '.env', 'SECRET=1');
    await write(repo, '.env.local', 'SECRET=2');
    await write(repo, 'node_modules/x/index.js', '');
    await write(repo, 'reports/junit.xml', '<testsuite/>');
    await write(repo, 'src/ok.ts', 'ok');
    const sha = await commitAll(repo, 'feat: ok', { exclude: [...DEFAULT_COMMIT_EXCLUDES, 'reports/junit.xml'] });
    expect(sha).not.toBeNull();
    expect((await git(repo, ['show', '--name-only', '--format=', 'HEAD'])).split('\n')).toEqual(['src/ok.ts']);
  });

  it('commits the .env templates, which hold no secret by convention, while the real .env files stay out (live-run finding)', async () => {
    await write(repo, '.env', 'SECRET=1');
    await write(repo, '.env.production', 'SECRET=2');
    await write(repo, '.env.example', 'PORT=8080');
    await write(repo, 'svc/.env.sample', 'PORT=9090');
    await write(repo, 'svc/.env', 'SECRET=3');
    const sha = await commitAll(repo, 'feat: env');
    expect(sha).not.toBeNull();
    expect((await git(repo, ['show', '--name-only', '--format=', 'HEAD'])).split('\n').sort()).toEqual(['.env.example', 'svc/.env.sample']);
    expect(await git(repo, ['status', '--porcelain'])).not.toContain('.env.example');
  });

  it('commits when an excluded path is also ignored by the repository .gitignore (live-run finding)', async () => {
    await write(repo, '.gitignore', 'reports/\nnode_modules/\n');
    await write(repo, 'reports/junit.xml', '<testsuite/>');
    await write(repo, 'src/ok.ts', 'ok');
    const sha = await commitAll(repo, 'feat: ok');
    expect(sha).not.toBeNull();
    expect((await git(repo, ['show', '--name-only', '--format=', 'HEAD'])).split('\n').sort()).toEqual(['.gitignore', 'src/ok.ts']);
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

  it('refuses to reset a branch that carries commits not on the base, unless asked to', async () => {
    const wt = path.join(root, 'wt-T2');
    await createWorktree(repo, wt, 'task/spec-001-T2-b', 'main');
    await write(wt, 'work.txt', 'in progress');
    const sha = await commitAll(wt, 'feat: in progress');
    await removeWorktree(repo, wt);
    await expect(createWorktree(repo, wt, 'task/spec-001-T2-b', 'main')).rejects.toThrow(/commits not on main/);
    expect(await git(repo, ['rev-parse', 'task/spec-001-T2-b'])).toBe(sha);
    await createWorktree(repo, wt, 'task/spec-001-T2-b', 'main', undefined, { reset: true });
    expect(await headSha(wt)).toBe(await headSha(repo));
  });

  it('recreates a worktree whose directory vanished (stale registration)', async () => {
    const wt = path.join(root, 'wt-gone');
    await createWorktree(repo, wt, 'task/gone', 'main');
    await fs.rm(wt, { recursive: true, force: true });
    await createWorktree(repo, wt, 'task/gone', 'main');
    expect(await git(wt, ['branch', '--show-current'])).toBe('task/gone');
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
    expect(result).toEqual({ ok: true, baseSha: await headSha(repo) });
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

  it('keeps both sides of a file named as unionable when both changed the same lines', async () => {
    const wt = path.join(root, 'wt');
    await createWorktree(repo, wt, 'task/x', 'main');
    await write(wt, 'docs/README.md', '# Docs\n\nfrom task\n');
    await commitAll(wt, 'docs: task');
    await write(repo, 'docs/README.md', '# Docs\n\nfrom main\n');
    await commitAll(repo, 'docs: main');
    const result = await rebaseOnto(wt, 'main', undefined, { union: ['docs/*.md'] });
    expect(result.ok).toBe(true);
    const text = await fs.readFile(path.join(wt, 'docs/README.md'), 'utf8');
    expect(text).toContain('from main');
    expect(text).toContain('from task');
    expect(text).not.toContain('<<<<<<<');
    expect(await git(wt, ['status', '--porcelain'])).toBe('');
  });

  it('still reports a conflict in a file the union does not name', async () => {
    const wt = path.join(root, 'wt');
    await createWorktree(repo, wt, 'task/x', 'main');
    await write(wt, 'docs/README.md', '# Docs\n\nfrom task\n');
    await write(wt, 'src/a.ts', 'task\n');
    await commitAll(wt, 'docs: task');
    await write(repo, 'docs/README.md', '# Docs\n\nfrom main\n');
    await write(repo, 'src/a.ts', 'main\n');
    await commitAll(repo, 'docs: main');
    expect(await rebaseOnto(wt, 'main', undefined, { union: ['docs/*.md'] })).toEqual({ ok: false, conflicts: ['src/a.ts'] });
  });

  it('replays a conflicting branch onto the base as one commit, with markers where both sides changed the same lines', async () => {
    const wt = path.join(root, 'wt');
    await createWorktree(repo, wt, 'task/x', 'main');
    await write(wt, 'README.md', 'from task\n');
    await write(wt, 'src/a.ts', 'task only\n');
    await commitAll(wt, 'docs: task');
    const previous = await headSha(wt);
    await write(repo, 'README.md', 'from main\n');
    await commitAll(repo, 'docs: main');
    expect(await replayOnto(repo, wt, 'main', 'T1: replay onto main')).toEqual({ previous, files: ['README.md'] });
    expect(await git(wt, ['log', '-1', '--format=%s'])).toBe('T1: replay onto main');
    expect(await git(wt, ['rev-parse', 'HEAD~1'])).toBe(await headSha(repo));
    expect(await fs.readFile(path.join(wt, 'README.md'), 'utf8')).toMatch(/^<<<<<<< [\s\S]*from main[\s\S]*from task[\s\S]*^>>>>>>> /m);
    expect(await fs.readFile(path.join(wt, 'src/a.ts'), 'utf8')).toBe('task only\n');
    expect(await git(wt, ['status', '--porcelain'])).toBe('');
  });

  it('replays clean when the two sides changed different lines', async () => {
    await write(repo, 'notes.txt', 'one\ntwo\nthree\nfour\nfive\n');
    await commitAll(repo, 'docs: notes');
    const wt = path.join(root, 'wt');
    await createWorktree(repo, wt, 'task/x', 'main');
    await write(wt, 'notes.txt', 'ONE\ntwo\nthree\nfour\nfive\n');
    await commitAll(wt, 'docs: task');
    await write(repo, 'notes.txt', 'one\ntwo\nthree\nfour\nFIVE\n');
    await commitAll(repo, 'docs: main');
    expect((await replayOnto(repo, wt, 'main', 'T1: replay'))!.files).toEqual([]);
    expect(await fs.readFile(path.join(wt, 'notes.txt'), 'utf8')).toBe('ONE\ntwo\nthree\nfour\nFIVE\n');
  });

  it('leaves the branch untouched when git cannot replay the change, such as a file deleted on one side and edited on the other', async () => {
    const wt = path.join(root, 'wt');
    await createWorktree(repo, wt, 'task/x', 'main');
    await git(wt, ['rm', '-q', 'README.md']);
    await git(wt, ['commit', '-q', '-m', 'docs: drop readme']);
    const before = await headSha(wt);
    await write(repo, 'README.md', 'edited on main\n');
    await commitAll(repo, 'docs: main');
    expect(await replayOnto(repo, wt, 'main', 'T1: replay')).toBeNull();
    expect(await headSha(wt)).toBe(before);
    expect(await git(repo, ['worktree', 'list', '--porcelain'])).not.toContain('teams-ai-replay-');
  });

  it('lists the files whose changes against the base add a conflict marker line, whatever their names', async () => {
    // A marker line main already holds is legitimate content, and a Markdown underline is not a marker.
    await write(repo, 'docs/git.md', 'how a conflict looks:\n<<<<<<< ours\n');
    await commitAll(repo, 'docs: git');
    const wt = path.join(root, 'wt');
    await createWorktree(repo, wt, 'task/x', 'main');
    await write(wt, 'docs/introdução.md', 'title\n<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs\n');
    await write(wt, 'docs/heading.md', 'Title\n=======\n');
    await write(wt, 'docs/git.md', 'how a conflict looks:\n<<<<<<< ours\nmore text\n');
    await commitAll(wt, 'docs: task');
    expect(await conflictMarkerFiles(wt, 'main')).toEqual(['docs/introdução.md']);
  });

  it('replays a change bigger than one mebibyte, and every file before it, byte for byte', async () => {
    const wt = path.join(root, 'wt');
    await createWorktree(repo, wt, 'task/x', 'main');
    const big = `{"line":"${'x'.repeat(60)}"}\n`.repeat(20_000);
    await write(wt, 'a-first.md', 'first\n');
    await write(wt, 'big.json', big);
    await commitAll(wt, 'feat: big');
    await write(repo, 'README.md', 'main moved\n');
    await commitAll(repo, 'docs: main');
    expect(await replayOnto(repo, wt, 'main', 'T1: replay')).toMatchObject({ files: [] });
    expect(await fs.readFile(path.join(wt, 'big.json'), 'utf8')).toBe(big);
    expect(await fs.readFile(path.join(wt, 'a-first.md'), 'utf8')).toBe('first\n');
  });

  it('keeps the bytes of a file that is not UTF-8', async () => {
    const wt = path.join(root, 'wt');
    await createWorktree(repo, wt, 'task/x', 'main');
    const latin1 = Buffer.from([0x61, 0xe7, 0xe3, 0x6f, 0x0a]);
    await fs.writeFile(path.join(wt, 'acao.txt'), latin1);
    await commitAll(wt, 'feat: latin1');
    await write(repo, 'README.md', 'main moved\n');
    await commitAll(repo, 'docs: main');
    await replayOnto(repo, wt, 'main', 'T1: replay');
    expect(await fs.readFile(path.join(wt, 'acao.txt'))).toEqual(latin1);
  });

  it('leaves the branch untouched when a binary file changed on both sides, since git can keep only one of them', async () => {
    await fs.writeFile(path.join(repo, 'logo.bin'), Buffer.from([0, 1, 2, 3]));
    await commitAll(repo, 'chore: logo');
    const wt = path.join(root, 'wt');
    await createWorktree(repo, wt, 'task/x', 'main');
    await fs.writeFile(path.join(wt, 'logo.bin'), Buffer.from([0, 9, 9, 9]));
    await commitAll(wt, 'feat: task logo');
    const before = await headSha(wt);
    await fs.writeFile(path.join(repo, 'logo.bin'), Buffer.from([0, 7, 7, 7]));
    await commitAll(repo, 'chore: main logo');
    expect(await replayOnto(repo, wt, 'main', 'T1: replay')).toBeNull();
    expect(await headSha(wt)).toBe(before);
  });

  it("replays the same bytes whatever the operator's git config says about diffs and whitespace", async () => {
    const xdg = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-xdg-'));
    await fs.mkdir(path.join(xdg, 'git'));
    await fs.writeFile(path.join(xdg, 'git', 'config'), '[apply]\n\twhitespace = fix\n[diff]\n\tnoprefix = true\n[color]\n\tdiff = always\n');
    const saved = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      const wt = path.join(root, 'wt');
      await createWorktree(repo, wt, 'task/x', 'main');
      await write(wt, 'notes.md', 'line with a break  \nnext\n');
      await commitAll(wt, 'docs: notes');
      await write(repo, 'README.md', 'main moved\n');
      await commitAll(repo, 'docs: main');
      expect(await replayOnto(repo, wt, 'main', 'T1: replay')).toMatchObject({ files: [] });
      expect(await fs.readFile(path.join(wt, 'notes.md'), 'utf8')).toBe('line with a break  \nnext\n');
    } finally {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved;
      await fs.rm(xdg, { recursive: true, force: true });
    }
  });

  it('writes conflict markers when both sides created the same file', async () => {
    const wt = path.join(root, 'wt');
    await createWorktree(repo, wt, 'task/x', 'main');
    await write(wt, 'src/new.ts', 'task\n');
    await commitAll(wt, 'feat: task new');
    await write(repo, 'src/new.ts', 'main\n');
    await commitAll(repo, 'feat: main new');
    expect(await replayOnto(repo, wt, 'main', 'T1: replay')).toMatchObject({ files: ['src/new.ts'] });
    expect(await fs.readFile(path.join(wt, 'src/new.ts'), 'utf8')).toMatch(/^<<<<<<< [\s\S]*^>>>>>>> /m);
  });

  it('throws GitError (infra) when the rebase fails for a reason that is not a conflict', async () => {
    const wt = path.join(root, 'wt');
    await createWorktree(repo, wt, 'task/x', 'main');
    await write(wt, 'src/a.ts', 'a');
    await commitAll(wt, 'feat: a');
    await write(repo, 'reports/junit.xml', 'tracked-on-main');
    await commitAll(repo, 'chore: track report', { exclude: [] });
    await write(wt, 'reports/junit.xml', 'untracked-in-worktree'); // would be overwritten by the rebase
    await expect(rebaseOnto(wt, 'main')).rejects.toThrow(GitError);
  });
});

describe('push, fetch and remote main', () => {
  it('pushes a branch to origin with force-with-lease and fetch sees it', async () => {
    const wt = path.join(root, 'wt');
    await createWorktree(repo, wt, 'task/y', 'main');
    await write(wt, 'y.txt', 'y');
    const sha = await commitAll(wt, 'feat: y');
    await push(wt, 'task/y');
    expect(await git(origin, ['rev-parse', 'task/y'])).toBe(sha);
    await fetch(repo);
    expect(await git(repo, ['rev-parse', 'origin/task/y'])).toBe(sha);
    // No upstream is written to the shared .git/config, and a rewritten branch still force-pushes.
    await expect(git(repo, ['config', '--get', 'branch.task/y.remote'])).rejects.toThrow();
    await git(wt, ['commit', '-q', '--amend', '-m', 'feat: y again']);
    await push(wt, 'task/y');
    expect(await git(origin, ['rev-parse', 'task/y'])).toBe(await headSha(wt));
  });

  it('overwrites a remote branch this clone never fetched', async () => {
    const wt = path.join(root, 'wt');
    await createWorktree(repo, wt, 'docs/x', 'main');
    await write(wt, 'a.txt', 'a');
    await commitAll(wt, 'docs: a');
    await push(wt, 'docs/x');
    await git(repo, ['update-ref', '-d', 'refs/remotes/origin/docs/x']);
    await git(wt, ['commit', '-q', '--amend', '-m', 'docs: a again']);
    await push(wt, 'docs/x');
    expect(await git(origin, ['rev-parse', 'docs/x'])).toBe(await headSha(wt));
  });

  it('reads the remote main sha', async () => {
    expect(await remoteMainSha(repo)).toBe(await headSha(repo));
    await write(repo, 'z.txt', 'z');
    const local = await commitAll(repo, 'feat: z');
    expect(await remoteMainSha(repo)).not.toBe(local);
    await push(repo, 'main');
    expect(await remoteMainSha(repo)).toBe(local);
  });
});
