import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Creates the empty HOME of one agent step, outside the worktree (audit C1). It starts empty so that
 * `~/.teams-ai/secrets`, `~/.config/gh`, `~/.kube` and friends do not exist for the agent. The only
 * thing copied in is what the `claude` CLI needs to log in with the subscription: a read-only copy
 * of `~/.claude/.credentials.json` (CLI 2.x reads it from $HOME/.claude; omniroute steps authenticate
 * through ANTHROPIC_AUTH_TOKEN and get no credential file at all).
 */
export async function createStepHome(parentDir: string, hostEnv: NodeJS.ProcessEnv, withClaudeLogin: boolean): Promise<string> {
  await fs.mkdir(parentDir, { recursive: true });
  const home = await fs.mkdtemp(path.join(parentDir, 'home-'));
  await fs.mkdir(path.join(home, 'tmp'), { recursive: true });
  const hostHome = hostEnv.HOME;
  if (withClaudeLogin && hostHome) {
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
