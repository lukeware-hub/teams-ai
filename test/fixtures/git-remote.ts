import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execCommand } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';

export interface Remote {
  root: string;
  origin: string;
  repo: string;
  cleanup(): Promise<void>;
}

/** Windows drops git transport and lock calls under parallel load: a transient failure is retried, any other is not. */
const TRANSIENT = /sideband|unexpected disconnect|index\.lock|could not lock|Permission denied/i;
async function gitRetry(cwd: string, args: readonly string[]): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await git(cwd, args, execCommand);
      return;
    } catch (err) {
      if (attempt >= 3 || !TRANSIENT.test(String(err))) throw err;
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
}

/** Bare origin plus a clone whose main carries `files`; everything local, git only. */
export async function makeRemote(files: Record<string, string>): Promise<Remote> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-remote-'));
  const origin = path.join(root, 'origin.git');
  const repo = path.join(root, 'repo');
  await fs.mkdir(origin);
  await git(origin, ['init', '--bare', '-b', 'main'], execCommand);
  await fs.mkdir(repo);
  await git(repo, ['init', '-b', 'main'], execCommand);
  await git(repo, ['remote', 'add', 'origin', origin], execCommand);
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
    await fs.writeFile(path.join(repo, rel), text);
  }
  await git(repo, ['add', '-A'], execCommand);
  await git(repo, ['commit', '-q', '-m', 'docs: initial'], execCommand);
  await gitRetry(repo, ['push', '-q', '-u', 'origin', 'main']);
  return { root, origin, repo, cleanup: () => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}
