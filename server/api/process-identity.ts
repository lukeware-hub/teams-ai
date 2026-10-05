import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** One look at a running process. `start` stays fixed for the life of the process and differs for any later process that
 * gets the same pid (reuse, reboot, container restart); `argv` is how it was launched. */
export interface ProcessInfo {
  start: string;
  argv: string[];
}
/** null: there is no such process, or this platform cannot tell. */
export type ProbeProcess = (pid: number) => Promise<ProcessInfo | null>;

/** Field 22 of /proc/<pid>/stat, in clock ticks since boot. The command name (field 2) is free text that may hold spaces
 * and parentheses, so the fields are counted from the last ')'. */
export function procStartTicks(stat: string): string | null {
  const close = stat.lastIndexOf(')');
  const ticks = close < 0 ? undefined : stat.slice(close + 2).split(' ')[19];
  return ticks !== undefined && /^\d+$/.test(ticks) ? ticks : null;
}

/** Linux. Ticks count from boot and the same number can repeat after a reboot, so the boot id is part of the start. */
export async function probeProc(pid: number, read: (file: string) => Promise<string> = (file) => fs.readFile(file, 'utf8')): Promise<ProcessInfo | null> {
  try {
    const ticks = procStartTicks(await read(`/proc/${pid}/stat`));
    if (ticks === null) return null;
    const boot = (await read('/proc/sys/kernel/random/boot_id').catch(() => '')).trim();
    const argv = (await read(`/proc/${pid}/cmdline`).catch(() => '')).split('\0').filter(Boolean);
    return { start: `${boot}:${ticks}`, argv };
  } catch {
    return null;
  }
}

/** `ps -o lstart=,command=` prints e.g. `Sat Oct  4 10:00:00 2026 /usr/bin/node /repo/server/cli.ts run`. */
export function parsePs(out: string): ProcessInfo | null {
  const m = /^\s*(\w{3} \w{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}) +(\S.*?)\s*$/.exec(out);
  return m ? { start: m[1]!, argv: m[2]!.split(/\s+/) } : null;
}

/** Other Unixes (macOS): best effort, one-second resolution. */
async function probePs(pid: number): Promise<ProcessInfo | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-o', 'command=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C' }, timeout: 5_000 });
    return parsePs(stdout);
  } catch {
    return null; // ps exits 1 when there is no such process
  }
}

/** Windows cannot tell: a pid there stays unverified, as before. */
export const probeProcess: ProbeProcess = (pid) => {
  if (process.platform === 'linux') return probeProc(pid);
  if (process.platform === 'win32') return Promise.resolve(null);
  return probePs(pid);
};
