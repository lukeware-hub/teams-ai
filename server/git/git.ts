import { realpathSync } from 'node:fs';
import { execCommand, type Exec } from '../exec/command.js';

export class GitError extends Error {}

/** Commits made by the orchestrator carry a fixed identity (agents never commit). */
export const GIT_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: 'teams-ai',
  GIT_AUTHOR_EMAIL: 'teams-ai@localhost',
  GIT_COMMITTER_NAME: 'teams-ai',
  GIT_COMMITTER_EMAIL: 'teams-ai@localhost',
  GIT_TERMINAL_PROMPT: '0',
  // The orchestrator never rewrites line endings; agents own file content.
  GIT_CONFIG_PARAMETERS: "'core.autocrlf=false'",
};

/** Canonical form for comparing paths git prints (long, forward slashes) with paths we were given. */
async function canonical(p: string): Promise<string> {
  let real = p;
  try {
    real = realpathSync.native(p); // expands Windows 8.3 short names too
  } catch {
    /* not created yet */
  }
  const s = real.replace(/\\/g, '/').replace(/\/$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

const TIMEOUT = 120_000;

async function run(cwd: string, args: readonly string[], exec: Exec) {
  return exec({ bin: 'git', args, cwd, env: GIT_IDENTITY, timeoutMs: TIMEOUT });
}

export async function git(cwd: string, args: readonly string[], exec: Exec = execCommand): Promise<string> {
  const r = await run(cwd, args, exec);
  if (r.exitCode !== 0) throw new GitError(`git ${args.join(' ')} failed (${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout.trim();
}

export const headSha = (cwd: string, exec: Exec = execCommand) => git(cwd, ['rev-parse', 'HEAD'], exec);
export const currentBranch = (cwd: string, exec: Exec = execCommand) => git(cwd, ['branch', '--show-current'], exec);

export async function createWorktree(repo: string, dir: string, branch: string, base: string, exec: Exec = execCommand): Promise<void> {
  const list = await git(repo, ['worktree', 'list', '--porcelain'], exec);
  const wanted = await canonical(dir);
  const listed = await Promise.all(list.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => canonical(l.slice(9))));
  if (listed.includes(wanted)) {
    if ((await currentBranch(dir, exec)) === branch) return;
    throw new GitError(`worktree ${dir} exists on another branch`);
  }
  await git(repo, ['worktree', 'add', '-B', branch, dir, base], exec);
}

export async function removeWorktree(repo: string, dir: string, exec: Exec = execCommand): Promise<void> {
  const r = await run(repo, ['worktree', 'remove', '--force', dir], exec);
  if (r.exitCode !== 0 && !/is not a working tree|No such file|does not exist/i.test(r.stderr)) {
    throw new GitError(`git worktree remove failed: ${r.stderr.trim()}`);
  }
  await git(repo, ['worktree', 'prune'], exec);
}

export async function commitAll(dir: string, message: string, exec: Exec = execCommand): Promise<string | null> {
  await git(dir, ['add', '-A'], exec);
  const staged = await run(dir, ['diff', '--cached', '--quiet'], exec);
  if (staged.exitCode === 0) return null;
  await git(dir, ['commit', '-q', '-m', message], exec);
  return headSha(dir, exec);
}

export async function changedFiles(dir: string, base: string, exec: Exec = execCommand): Promise<string[]> {
  const out = await git(dir, ['diff', '--name-only', `${base}...HEAD`], exec);
  return out === '' ? [] : out.split('\n');
}

export async function rebaseOnto(dir: string, base: string, exec: Exec = execCommand): Promise<{ ok: true } | { ok: false; conflicts: string[] }> {
  const r = await run(dir, ['rebase', base], exec);
  if (r.exitCode === 0) return { ok: true };
  const unmerged = await git(dir, ['diff', '--name-only', '--diff-filter=U'], exec).catch(() => '');
  await run(dir, ['rebase', '--abort'], exec);
  return { ok: false, conflicts: unmerged === '' ? [] : unmerged.split('\n') };
}

export async function push(dir: string, branch: string, exec: Exec = execCommand): Promise<void> {
  await git(dir, ['push', '-q', '--force-with-lease', '-u', 'origin', branch], exec);
}

export async function fetch(repo: string, exec: Exec = execCommand): Promise<void> {
  await git(repo, ['fetch', '-q', '--prune', 'origin'], exec);
}
