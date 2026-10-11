import { readFileSync } from 'node:fs';

/** A zombie has exited but nobody reaped it yet, so it must not count as alive: it would hold a run lock forever. */
function isZombie(pid: number): boolean {
  try {
    return /\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return false;
  }
}

/** `process.kill(pid, 0)` that treats a zombie as gone; "no permission" still means the process exists. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
  return !isZombie(pid);
}
