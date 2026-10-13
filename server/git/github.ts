import type { Exec } from '../exec/command.js';

export class GitHubError extends Error {}

const TIMEOUT = 120_000;

/** git.ts SAFE_CONFIG through the environment, so it also reaches the git that gh runs: no clone hook runs on the host. */
const SAFE_GIT_ENV = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null', GIT_CONFIG_KEY_1: 'core.fsmonitor', GIT_CONFIG_VALUE_1: '' };

async function gh(cwd: string, args: readonly string[], exec: Exec, stdin?: string) {
  return exec({ bin: 'gh', args, cwd, timeoutMs: TIMEOUT, stdin, env: { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', ...SAFE_GIT_ENV } });
}

async function ghJson<T>(cwd: string, args: readonly string[], exec: Exec): Promise<T> {
  const r = await gh(cwd, args, exec);
  if (r.exitCode !== 0) throw new GitHubError(`gh ${args.join(' ')} failed (${r.exitCode}): ${r.stderr.trim()}`);
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    throw new GitHubError(`gh ${args.join(' ')} returned invalid JSON`);
  }
}

function prNumber(url: string): number {
  const n = Number(url.trim().match(/\/pull\/(\d+)/)?.[1]);
  if (!Number.isInteger(n) || n < 1) throw new GitHubError(`could not read the PR number from gh output: ${url.trim().slice(0, 200)}`);
  return n;
}

export const NOT_FOUND = /Could not resolve to a Repository|HTTP 404/i;

/**
 * Idempotent repository bootstrap (spec §7.4). A half-finished `gh repo create --push` (remote
 * created, origin missing or main never pushed) is reconciled instead of reported as "exists".
 */
export async function ensureRepo(
  input: { owner?: string; name: string; private: boolean; cwd: string },
  exec: Exec,
): Promise<{ fullName: string; url: string; created: boolean }> {
  const owner = input.owner ?? (await ghJson<{ login: string }>(input.cwd, ['api', 'user'], exec)).login;
  const fullName = `${owner}/${input.name}`;
  const view = await gh(input.cwd, ['repo', 'view', fullName, '--json', 'nameWithOwner,url'], exec);
  if (view.exitCode === 0) {
    const json = JSON.parse(view.stdout) as { nameWithOwner: string; url: string };
    await reconcileRemote(input.cwd, json.url, exec);
    return { fullName: json.nameWithOwner, url: json.url, created: false };
  }
  if (!NOT_FOUND.test(view.stderr)) throw new GitHubError(`gh repo view failed: ${view.stderr.trim()}`);
  const create = await gh(input.cwd, ['repo', 'create', fullName, input.private ? '--private' : '--public', '--source', '.', '--remote', 'origin', '--push'], exec);
  if (create.exitCode !== 0) throw new GitHubError(`gh repo create failed: ${create.stderr.trim()}`);
  // `--push` adds git progress lines after the URL.
  const url = create.stdout.match(/https?:\/\/\S+/)?.[0] ?? `https://github.com/${fullName}`;
  return { fullName, url, created: true };
}

async function reconcileRemote(cwd: string, url: string, exec: Exec): Promise<void> {
  const git = (args: string[]) => exec({ bin: 'git', args, cwd, timeoutMs: TIMEOUT, env: { GIT_TERMINAL_PROMPT: '0', ...SAFE_GIT_ENV } });
  const remote = await git(['remote', 'get-url', 'origin']);
  if (remote.exitCode !== 0) {
    const add = await git(['remote', 'add', 'origin', `${url}.git`]);
    if (add.exitCode !== 0) throw new GitHubError(`git remote add origin failed: ${add.stderr.trim()}`);
  }
  const main = await git(['ls-remote', 'origin', 'refs/heads/main']);
  if (main.exitCode !== 0) throw new GitHubError(`git ls-remote failed: ${main.stderr.trim()}`);
  if (main.stdout.trim() === '') {
    const push = await git(['push', '-u', 'origin', 'main']);
    if (push.exitCode !== 0) throw new GitHubError(`git push main failed: ${push.stderr.trim()}`);
  }
}

export async function ensurePr(
  input: { cwd: string; head: string; base: string; title: string; body: string },
  exec: Exec,
): Promise<{ number: number; url: string; created: boolean }> {
  const open = await ghJson<Array<{ number: number; url: string }>>(
    input.cwd,
    ['pr', 'list', '--head', input.head, '--base', input.base, '--state', 'open', '--json', 'number,url'],
    exec,
  );
  if (open[0]) return { number: open[0].number, url: open[0].url, created: false };
  const create = await gh(input.cwd, ['pr', 'create', '--head', input.head, '--base', input.base, '--title', input.title, '--body-file', '-'], exec, input.body);
  if (create.exitCode !== 0) throw new GitHubError(`gh pr create failed: ${create.stderr.trim()}`);
  const url = create.stdout.trim().split('\n').pop() ?? '';
  return { number: prNumber(url), url, created: true };
}

/** A PR for this head branch that already merged — the merge queue short-circuits on it (crash between merge and confirm). */
export async function findMergedPr(input: { cwd: string; head: string; base: string; headSha?: string }, exec: Exec): Promise<number | null> {
  const all = await ghJson<Array<{ number: number; state: string; headRefOid?: string }>>(
    input.cwd,
    ['pr', 'list', '--head', input.head, '--base', input.base, '--state', 'all', '--json', 'number,state,headRefOid'],
    exec,
  );
  // A reused branch name (a second run, a re-opened spec) must not match the PR that merged an older tip.
  return all.find((p) => p.state === 'MERGED' && (input.headSha === undefined || p.headRefOid === input.headSha))?.number ?? null;
}

export async function prState(input: { cwd: string; number: number }, exec: Exec): Promise<{ state: 'OPEN' | 'MERGED' | 'CLOSED'; headSha: string }> {
  const json = await ghJson<{ state: 'OPEN' | 'MERGED' | 'CLOSED'; headRefOid: string }>(input.cwd, ['pr', 'view', String(input.number), '--json', 'state,headRefOid'], exec);
  return { state: json.state, headSha: json.headRefOid };
}

/** Squash-merge guarded by the head commit the gates ran on; never forces (spec §6 step 5, §7.4). */
export async function mergePr(input: { cwd: string; number: number; headSha: string; body?: string }, exec: Exec): Promise<{ merged: boolean; already: boolean; reason?: string }> {
  const state = await prState(input, exec);
  if (state.state === 'MERGED') return { merged: true, already: true };
  if (state.state === 'CLOSED') return { merged: false, already: false, reason: 'PR is closed' };
  if (state.headSha !== input.headSha) return { merged: false, already: false, reason: `head moved: expected ${input.headSha}, found ${state.headSha}` };
  // The squash commit takes the pull request body, so main carries the spec line too.
  const r = await gh(input.cwd, ['pr', 'merge', String(input.number), '--squash', '--match-head-commit', input.headSha, ...(input.body ? ['--body-file', '-'] : [])], exec, input.body);
  if (r.exitCode !== 0) return { merged: false, already: false, reason: r.stderr.trim() || 'merge failed' };
  return { merged: true, already: false };
}
