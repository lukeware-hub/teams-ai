import type { Exec } from '../exec/command.js';

export class GitHubError extends Error {}

const TIMEOUT = 120_000;

async function gh(cwd: string, args: readonly string[], exec: Exec, stdin?: string) {
  const r = await exec({ bin: 'gh', args, cwd, timeoutMs: TIMEOUT, stdin, env: { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' } });
  return r;
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

const prNumber = (url: string) => Number(url.trim().match(/\/pull\/(\d+)/)?.[1]);

export async function ensureRepo(
  input: { owner?: string; name: string; private: boolean; cwd: string },
  exec: Exec,
): Promise<{ fullName: string; url: string; created: boolean }> {
  const owner = input.owner ?? (await ghJson<{ login: string }>(input.cwd, ['api', 'user'], exec)).login;
  const fullName = `${owner}/${input.name}`;
  const view = await gh(input.cwd, ['repo', 'view', fullName, '--json', 'nameWithOwner,url'], exec);
  if (view.exitCode === 0) {
    const json = JSON.parse(view.stdout) as { nameWithOwner: string; url: string };
    return { fullName: json.nameWithOwner, url: json.url, created: false };
  }
  const create = await gh(input.cwd, ['repo', 'create', fullName, input.private ? '--private' : '--public', '--source', '.', '--remote', 'origin', '--push'], exec);
  if (create.exitCode !== 0) throw new GitHubError(`gh repo create failed: ${create.stderr.trim()}`);
  return { fullName, url: create.stdout.trim(), created: true };
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

export async function prState(input: { cwd: string; number: number }, exec: Exec): Promise<{ state: 'OPEN' | 'MERGED' | 'CLOSED'; headSha: string }> {
  const json = await ghJson<{ state: 'OPEN' | 'MERGED' | 'CLOSED'; headRefOid: string }>(input.cwd, ['pr', 'view', String(input.number), '--json', 'state,headRefOid'], exec);
  return { state: json.state, headSha: json.headRefOid };
}

/** Squash-merge guarded by the head commit the gates ran on; never forces (spec §6 step 5, §7.4). */
export async function mergePr(input: { cwd: string; number: number; headSha: string }, exec: Exec): Promise<{ merged: boolean; already: boolean; reason?: string }> {
  const state = await prState(input, exec);
  if (state.state === 'MERGED') return { merged: true, already: true };
  if (state.state === 'CLOSED') return { merged: false, already: false, reason: 'PR is closed' };
  if (state.headSha !== input.headSha) return { merged: false, already: false, reason: `head moved: expected ${input.headSha}, found ${state.headSha}` };
  const r = await gh(input.cwd, ['pr', 'merge', String(input.number), '--squash', '--match-head-commit', input.headSha], exec);
  if (r.exitCode !== 0) return { merged: false, already: false, reason: r.stderr.trim() || 'merge failed' };
  return { merged: true, already: false };
}
