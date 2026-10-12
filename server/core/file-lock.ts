import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Exclusive locks shared by every process on this machine: the UI server and each run process are separate, and two
 * runs of one project share its clone. A holder refreshes its lock file; one not refreshed within `staleMs` died.
 */

/** The lock file of a repository for one kind of work; kept in the temp dir, so it never lands in the repository. */
export const lockFile = (repo: string, kind: 'repo' | 'checkout') =>
  path.join(os.tmpdir(), 'teams-ai-locks', `${createHash('sha256').update(path.resolve(repo)).digest('hex').slice(0, 16)}.${kind}.lock`);

export async function withFileLock<T>(file: string, fn: () => Promise<T>, staleMs = 120_000): Promise<T> {
  await acquire(file, staleMs);
  const beat = setInterval(() => {
    const now = new Date();
    void fs.utimes(file, now, now).catch(() => undefined);
  }, staleMs / 4);
  beat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(beat);
    await fs.rm(file, { force: true });
  }
}

async function acquire(file: string, staleMs: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  for (;;) {
    try {
      await (await fs.open(file, 'wx')).close();
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const since = (await fs.stat(file).catch(() => null))?.mtimeMs;
      // ponytail: two waiters may both judge one dead lock stale; only after a crash, and the window is a few ms.
      if (since !== undefined && Date.now() - since > staleMs) await fs.rm(file, { force: true });
      else await new Promise((r) => setTimeout(r, 100));
    }
  }
}
