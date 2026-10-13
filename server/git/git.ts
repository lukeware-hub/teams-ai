import { promises as fs, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lockFile, withFileLock } from '../core/file-lock.js';
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
 * The caller adds the plan's report paths through `commitExcludes`. Pathspecs use the exclude magic so `add -A` stays otherwise complete.
 */
/** The `.env` files meant to be committed: they list the variables with no real value. */
const ENV_TEMPLATES: readonly string[] = ['.env.example', '.env.sample', '.env.template', '.env.dist'].map((n) => `:(glob)**/${n}`);

export const DEFAULT_COMMIT_EXCLUDES: readonly string[] = ['.env', '.env.*', '**/.env', '**/.env.*', 'node_modules', '**/node_modules', 'reports/junit.xml', '.tools'];

/** The default excludes plus the gate reports the plan places elsewhere (its junitPath and coveragePath). */
export const commitExcludes = (...reports: Array<string | undefined>): string[] => [...DEFAULT_COMMIT_EXCLUDES, ...reports.filter((p): p is string => p !== undefined)];

/** Hardening applied to every git command: hooks and fsmonitor from a (possibly agent-written) config never execute. */
const SAFE_CONFIG = ['-c', 'core.fsmonitor=', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'core.quotePath=false'];

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

/** A file at a revision byte for byte: `git()` trims its output, which drops the final newline. */
export async function showFile(cwd: string, rev: string, rel: string, exec: Exec = execCommand): Promise<string> {
  const r = await run(cwd, ['show', `${rev}:${rel}`], exec);
  if (r.exitCode !== 0) throw new GitError(`git show ${rev}:${rel} failed (${r.exitCode}): ${r.stderr.trim()}`);
  return r.stdout;
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
/**
 * Serializes worktree bookkeeping and fetches per repository: concurrent `git worktree add`
 * calls race on `.git/config` ("could not lock config file") when two task runners start at once.
 * The file lock extends that to the runs of other specs, which are other processes on the same clone.
 */
const repoLocks = new Map<string, Promise<unknown>>();
export function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(repo) ?? Promise.resolve();
  const locked = () => withFileLock(lockFile(repo, 'repo'), fn);
  const next = prev.then(locked, locked);
  repoLocks.set(repo, next.catch(() => undefined));
  return next;
}

/**
 * Holds the main checkout of `repo` still: a deploy builds from it while another spec's run would reset it after a merge.
 * Always taken before the repo lock, never inside it.
 */
export function withCheckoutLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  return withFileLock(lockFile(repo, 'checkout'), fn);
}

export async function createWorktree(
  repo: string,
  dir: string,
  branch: string,
  base: string,
  exec: Exec = execCommand,
  opts: { reset?: boolean } = {},
): Promise<void> {
  return withRepoLock(repo, () => createWorktreeUnlocked(repo, dir, branch, base, exec, opts));
}

async function createWorktreeUnlocked(repo: string, dir: string, branch: string, base: string, exec: Exec, opts: { reset?: boolean }): Promise<void> {
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
  // --no-track: a remote base would otherwise write the branch upstream into the shared .git/config, racing any other git process (live: config.lock blocked tasks).
  await git(repo, ['worktree', 'add', '--no-track', '-B', branch, dir, base], exec);
}

export async function removeWorktree(repo: string, dir: string, exec: Exec = execCommand): Promise<void> {
  return withRepoLock(repo, async () => {
    const r = await run(repo, ['worktree', 'remove', '--force', dir], exec);
    if (r.exitCode !== 0 && !/is not a working tree|No such file|does not exist/i.test(r.stderr)) {
      throw new GitError(`git worktree remove failed: ${r.stderr.trim()}`);
    }
    await git(repo, ['worktree', 'prune'], exec);
  });
}

export async function commitAll(
  dir: string,
  message: string,
  opts: { exclude?: readonly string[] } = {},
  exec: Exec = execCommand,
): Promise<string | null> {
  const exclude = opts.exclude ?? DEFAULT_COMMIT_EXCLUDES;
  // Stage everything, then drop the excluded paths from the index. An `:(exclude)` pathspec that
  // names a path the repository's own .gitignore already ignores makes `git add` exit 1
  // ("paths are ignored by one of your .gitignore files"), which the first live run hit.
  await git(dir, ['add', '-A', '--', '.'], exec);
  if (exclude.length > 0) {
    // The `.env.*` exclusion is for real secrets: the templates it also matches go back in, unless the repository ignores them.
    const templates = exclude.some((p) => p.endsWith('.env.*')) ? (await git(dir, ['ls-files', '--cached', '--', ...ENV_TEMPLATES], exec)).split('\n').filter((f) => f !== '') : [];
    await git(dir, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...exclude.map((p) => `:(glob)${p}`)], exec);
    if (templates.length > 0) await git(dir, ['add', '-f', '--', ...templates.map((f) => `:(literal)${f}`)], exec);
  }
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
  opts: { union?: readonly string[] } = {},
): Promise<{ ok: true; baseSha: string } | { ok: false; conflicts: string[] }> {
  const baseSha = await git(dir, ['rev-parse', base], exec);
  // `union` names files (pathspecs of .gitattributes) where both sides' lines are kept when they changed the same ones: shared docs two specs extend at once.
  const attrs = opts.union?.length ? path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-attrs-')), 'attributes') : null;
  if (attrs) await fs.writeFile(attrs, `${opts.union!.map((p) => `${p} merge=union`).join('\n')}\n`);
  let r;
  try {
    r = await run(dir, [...(attrs ? ['-c', `core.attributesFile=${attrs.replace(/\\/g, '/')}`] : []), 'rebase', base], exec);
  } finally {
    if (attrs) await fs.rm(path.dirname(attrs), { recursive: true, force: true });
  }
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

/**
 * Moves a branch whose rebase conflicted onto `base` as one commit. Its whole change since the merge base is applied
 * three-way in a scratch worktree, so a hunk both sides changed stays in its file between conflict markers, and the
 * branch moves only once that commit exists. Returns the previous head and the files holding markers, or null when git
 * cannot replay the change (a file deleted on one side and edited on the other, or a binary file both sides changed).
 */
export async function replayOnto(repo: string, dir: string, base: string, message: string, exec: Exec = execCommand): Promise<{ previous: string; files: string[] } | null> {
  const previous = await headSha(dir, exec);
  const mergeBase = await git(dir, ['merge-base', 'HEAD', base], exec);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-replay-'));
  // The patch stays a file: through a JavaScript string it would be cut to the output cap and re-encoded as UTF-8.
  const patch = path.join(tmp, 'change.patch');
  const scratch = path.join(tmp, 'wt');
  try {
    // The same bytes whatever the operator's git config says: no external diff, text conversion, colors or other prefixes.
    await git(dir, ['diff', '--binary', '--no-textconv', '--no-ext-diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', `--output=${patch}`, mergeBase, 'HEAD'], exec);
    if ((await fs.stat(patch)).size === 0) return null;
    await withRepoLock(repo, () => git(repo, ['worktree', 'add', '--detach', scratch, base], exec));
    const applied = await run(scratch, ['apply', '--3way', '--whitespace=nowarn', patch], exec);
    const unmerged = await git(scratch, ['diff', '--name-only', '--diff-filter=U'], exec);
    const files = unmerged === '' ? [] : unmerged.split('\n');
    if (applied.exitCode !== 0 && files.length === 0) return null;
    // A binary file both sides changed conflicts without markers: git kept main's side, so the task's change would be lost.
    for (const file of files) if (!(await holdsMarkers(path.join(scratch, file)))) return null;
    await git(scratch, ['add', '-A'], exec);
    await git(scratch, ['commit', '-q', '-m', message], exec);
    await git(dir, ['reset', '-q', '--hard', await headSha(scratch, exec)], exec);
    return { previous, files };
  } finally {
    await withRepoLock(repo, () => git(repo, ['worktree', 'remove', '--force', scratch], exec)).catch(() => undefined);
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** True when the file holds an opening and a closing conflict marker line. */
const holdsMarkers = async (file: string): Promise<boolean> =>
  /^<<<<<<< [\s\S]*^>>>>>>> /m.test(await fs.readFile(file, 'latin1').catch(() => ''));

/**
 * The files whose changes against `base` add an opening or closing conflict marker line, as git's own whitespace check
 * reports it; a marker line the base already holds is content, and a lone `=======` is a Markdown underline.
 */
export async function conflictMarkerFiles(dir: string, base: string, exec: Exec = execCommand): Promise<string[]> {
  const r = await run(dir, ['diff', '--check', '--no-color', `${base}...HEAD`], exec);
  const found = new Set<string>();
  for (const [, file, line] of r.stdout.matchAll(/^(.+):(\d+): leftover conflict marker$/gm)) {
    const lines = (await fs.readFile(path.join(dir, file!), 'latin1').catch(() => '')).split('\n');
    if (/^(<<<<<<<|>>>>>>>)( |$)/.test(lines[Number(line) - 1] ?? '')) found.add(file!);
  }
  return [...found];
}

export async function push(dir: string, branch: string, exec: Exec = execCommand): Promise<void> {
  // No -u: an upstream setting writes the .git/config every worktree shares, racing a parallel task's worktree add (live: config.lock).
  // The lease names the sha origin holds now: a bare lease is "stale info" when this clone never fetched a branch an earlier run pushed.
  const remote = (await git(dir, ['ls-remote', 'origin', `refs/heads/${branch}`], exec)).split(/\s+/)[0] ?? '';
  await git(dir, ['push', '-q', `--force-with-lease=${branch}:${remote}`, 'origin', branch], exec);
}

export async function fetch(repo: string, exec: Exec = execCommand): Promise<void> {
  await withRepoLock(repo, () => git(repo, ['fetch', '-q', '--prune', 'origin'], exec));
}

/** The sha of `main` on the remote right now — compared with the rebase base before merging. */
export async function remoteMainSha(repo: string, exec: Exec = execCommand, branch = 'main'): Promise<string> {
  const out = await git(repo, ['ls-remote', 'origin', `refs/heads/${branch}`], exec);
  const sha = out.split(/\s+/)[0];
  if (!sha) throw new GitError(`origin has no branch ${branch}`);
  return sha;
}
