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

/**
 * Repository content that must never reach a commit: secrets, dependency trees and gate artifacts.
 * The caller adds the plan's junitPath. Pathspecs use the exclude magic so `add -A` stays otherwise complete.
 */
export const DEFAULT_COMMIT_EXCLUDES: readonly string[] = ['.env', '.env.*', '**/.env', '**/.env.*', 'node_modules', '**/node_modules', 'reports/junit.xml'];

/** Hardening applied to every git command: hooks and fsmonitor from a (possibly agent-written) config never execute. */
const SAFE_CONFIG = ['-c', 'core.fsmonitor=', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false'];

const TIMEOUT = 120_000;

/** Canonical form for comparing paths git prints (long, forward slashes) with paths we were given. */
function canonical(p: string): string {
  let real = p;
  try {
    real = realpathSync.native(p); // expands Windows 8.3 short names too
  } catch {
    /* not created yet */
  }
  const s = real.replace(/\\/g, '/').replace(/\/$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

async function run(cwd: string, args: readonly string[], exec: Exec) {
  return exec({ bin: 'git', args: [...SAFE_CONFIG, ...args], cwd, env: GIT_IDENTITY, timeoutMs: TIMEOUT });
}

export async function git(cwd: string, args: readonly string[], exec: Exec = execCommand): Promise<string> {
  const r = await run(cwd, args, exec);
  if (r.exitCode !== 0) throw new GitError(`git ${args.join(' ')} failed (${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout.trim();
}

export const headSha = (cwd: string, exec: Exec = execCommand) => git(cwd, ['rev-parse', 'HEAD'], exec);
export const currentBranch = (cwd: string, exec: Exec = execCommand) => git(cwd, ['branch', '--show-current'], exec);

async function branchExists(repo: string, branch: string, exec: Exec): Promise<boolean> {
  return (await run(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], exec)).exitCode === 0;
}

/**
 * Creates the task worktree on `branch` from `base`; idempotent for an existing worktree on the
 * same branch. A branch that already carries commits not on `base` (a previous attempt whose
 * worktree is gone) is refused unless `reset` is set, because `-B` would discard them silently.
 */
export async function createWorktree(
  repo: string,
  dir: string,
  branch: string,
  base: string,
  exec: Exec = execCommand,
  opts: { reset?: boolean } = {},
): Promise<void> {
  // Drop registrations whose directory vanished (crash, manual cleanup) before deciding anything.
  await git(repo, ['worktree', 'prune'], exec);
  const list = await git(repo, ['worktree', 'list', '--porcelain'], exec);
  const wanted = canonical(dir);
  const listed = list.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => canonical(l.slice(9)));
  if (listed.includes(wanted)) {
    if ((await currentBranch(dir, exec)) === branch) return;
    throw new GitError(`worktree ${dir} exists on another branch`);
  }
  if (!opts.reset && (await branchExists(repo, branch, exec))) {
    const contained = await run(repo, ['merge-base', '--is-ancestor', branch, base], exec);
    if (contained.exitCode !== 0) {
      throw new GitError(`branch ${branch} has commits not on ${base}; refusing to reset it (pass reset to discard them)`);
    }
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

export async function commitAll(
  dir: string,
  message: string,
  opts: { exclude?: readonly string[] } = {},
  exec: Exec = execCommand,
): Promise<string | null> {
  const exclude = opts.exclude ?? DEFAULT_COMMIT_EXCLUDES;
  await git(dir, ['add', '-A', '--', '.', ...exclude.map((p) => `:(exclude,glob)${p}`)], exec);
  const staged = await run(dir, ['diff', '--cached', '--quiet'], exec);
  if (staged.exitCode === 0) return null;
  await git(dir, ['commit', '-q', '-m', message], exec);
  return headSha(dir, exec);
}

export async function changedFiles(dir: string, base: string, exec: Exec = execCommand): Promise<string[]> {
  const out = await git(dir, ['diff', '--name-only', `${base}...HEAD`], exec);
  return out === '' ? [] : out.split('\n');
}

/**
 * Rebases the worktree onto `base`. Conflicts abort the rebase and are returned as `ok: false`
 * with the files; any other failure (untracked files in the way, a rebase already in progress,
 * a failed abort) is infrastructure and throws GitError, so the Dev is not charged an attempt.
 */
export async function rebaseOnto(
  dir: string,
  base: string,
  exec: Exec = execCommand,
): Promise<{ ok: true; baseSha: string } | { ok: false; conflicts: string[] }> {
  const baseSha = await git(dir, ['rev-parse', base], exec);
  const r = await run(dir, ['rebase', base], exec);
  if (r.exitCode === 0) return { ok: true, baseSha };
  const unmerged = await git(dir, ['diff', '--name-only', '--diff-filter=U'], exec).catch(() => '');
  const conflicts = unmerged === '' ? [] : unmerged.split('\n');
  const abort = await run(dir, ['rebase', '--abort'], exec);
  if (conflicts.length === 0) {
    throw new GitError(`git rebase ${base} failed without conflicts: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  if (abort.exitCode !== 0) throw new GitError(`git rebase --abort failed: ${abort.stderr.trim()}`);
  return { ok: false, conflicts };
}

export async function push(dir: string, branch: string, exec: Exec = execCommand): Promise<void> {
  await git(dir, ['push', '-q', '--force-with-lease', '-u', 'origin', branch], exec);
}

export async function fetch(repo: string, exec: Exec = execCommand): Promise<void> {
  await git(repo, ['fetch', '-q', '--prune', 'origin'], exec);
}

/** The sha of `main` on the remote right now — compared with the rebase base before merging. */
export async function remoteMainSha(repo: string, exec: Exec = execCommand, branch = 'main'): Promise<string> {
  const out = await git(repo, ['ls-remote', 'origin', `refs/heads/${branch}`], exec);
  const sha = out.split(/\s+/)[0];
  if (!sha) throw new GitError(`origin has no branch ${branch}`);
  return sha;
}
