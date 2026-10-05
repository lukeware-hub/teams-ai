import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Optional long-lived token (create one with `claude setup-token`, then `export CLAUDE_CODE_OAUTH_TOKEN=...` on the host).
 * When set, claude steps get it through their environment and the credential file is neither copied nor written back: no
 * refresh token rotates, so concurrent steps cannot race (plan 38).
 */
export const OAUTH_TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';

export function hasOauthToken(hostEnv: NodeJS.ProcessEnv): boolean {
  return (hostEnv[OAUTH_TOKEN_ENV] ?? '').trim() !== '';
}

/** expiresAt (epoch ms) of the host's stored login, or null when there is no readable credential. */
export async function hostTokenExpiresAt(hostEnv: NodeJS.ProcessEnv): Promise<number | null> {
  if (!hostEnv.HOME) return null;
  try {
    const raw = await fs.readFile(path.join(hostEnv.HOME, '.claude', '.credentials.json'), 'utf8');
    const at = (JSON.parse(raw) as { claudeAiOauth?: { expiresAt?: unknown } }).claudeAiOauth?.expiresAt;
    return typeof at === 'number' ? at : null;
  } catch {
    return null;
  }
}

/**
 * Creates the empty HOME of one agent step, outside the worktree (audit C1). It starts empty so that
 * `~/.teams-ai/secrets`, `~/.config/gh`, `~/.kube` and friends do not exist for the agent. The only
 * thing copied in is what the `claude` CLI needs to log in with the subscription: a read-only copy
 * of `~/.claude/.credentials.json` (CLI 2.x reads it from $HOME/.claude).
 */
export async function createStepHome(parentDir: string, hostEnv: NodeJS.ProcessEnv): Promise<string> {
  await fs.mkdir(parentDir, { recursive: true });
  const home = await fs.mkdtemp(path.join(parentDir, 'home-'));
  await fs.mkdir(path.join(home, 'tmp'), { recursive: true });
  const hostHome = hostEnv.HOME;
  if (hostHome && !hasOauthToken(hostEnv)) {
    const source = path.join(hostHome, '.claude', '.credentials.json');
    try {
      const data = await fs.readFile(source);
      await fs.mkdir(path.join(home, '.claude'), { recursive: true });
      await fs.writeFile(path.join(home, '.claude', '.credentials.json'), data, { mode: 0o400 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return home;
}

export async function removeStepHome(home: string): Promise<void> {
  await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * The CLI renews its OAuth token inside the step HOME, and the server rotates the refresh token: the copy this module
 * made at the start is then the only valid one, and deleting the HOME with it invalidates the host's login (live, 2026-10-04:
 * golden run 3 broke the WSL login after one step). So a newer, well-formed credential is written back to the host file,
 * atomically and with mode 0600, before the HOME goes away. Never throws: a failed write-back must not fail the step.
 */
export async function syncBackCredentials(home: string, hostEnv: NodeJS.ProcessEnv): Promise<void> {
  const hostHome = hostEnv.HOME;
  if (!hostHome || hasOauthToken(hostEnv)) return;
  const read = async (file: string): Promise<{ raw: string; expiresAt: number; refresh: boolean } | null> => {
    try {
      const raw = await fs.readFile(file, 'utf8');
      const o = (JSON.parse(raw) as { claudeAiOauth?: { expiresAt?: unknown; refreshToken?: unknown } }).claudeAiOauth;
      if (!o) return null;
      return { raw, expiresAt: typeof o.expiresAt === 'number' ? o.expiresAt : 0, refresh: typeof o.refreshToken === 'string' && o.refreshToken !== '' };
    } catch {
      return null;
    }
  };
  const step = await read(path.join(home, '.claude', '.credentials.json'));
  if (!step || !step.refresh) return;
  const hostFile = path.join(hostHome, '.claude', '.credentials.json');
  const host = await read(hostFile);
  if (host && host.expiresAt >= step.expiresAt) return;
  const tmp = `${hostFile}.${process.pid}.tmp`;
  try {
    await fs.mkdir(path.dirname(hostFile), { recursive: true });
    await fs.writeFile(tmp, step.raw, { mode: 0o600 });
    await fs.rename(tmp, hostFile);
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}
