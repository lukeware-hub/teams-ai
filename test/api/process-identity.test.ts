import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsePs, probeProc, probeProcess, procStartTicks } from '../../server/api/process-identity.js';
import { readPid, writePid } from '../../server/api/run-index.js';

// A /proc/<pid>/stat line; field 22 (starttime) is 987654. The command name sits in parentheses and may contain anything.
const afterComm = 'S 1 1234 1234 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 11 0 987654 123456789 4321 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0';
const stat = (comm: string) => `1234 (${comm}) ${afterComm}\n`;

describe('procStartTicks', () => {
  it('reads field 22 whatever the command name holds', () => {
    expect(procStartTicks(stat('node'))).toBe('987654');
    expect(procStartTicks(stat('tsx cli (run) S 1 (x'))).toBe('987654'); // spaces, parentheses, even a fake state and ppid
  });
  it('is null for anything that is not a stat line', () => {
    expect(procStartTicks('')).toBeNull();
    expect(procStartTicks('1234 node S 1')).toBeNull();
    expect(procStartTicks('1234 (node) S 1 2')).toBeNull();
  });
});

describe('probeProc', () => {
  const files: Record<string, string> = {
    '/proc/42/stat': stat('node'),
    '/proc/42/cmdline': 'node\0/repo/server/cli.ts\0run\0--run-id\0hello-001-r1\0',
    '/proc/sys/kernel/random/boot_id': 'b7c1e2f0-1111-2222-3333-444455556666\n',
  };
  const readFrom = (present: Record<string, string>) => async (file: string) => {
    if (file in present) return present[file]!;
    throw Object.assign(new Error(`ENOENT ${file}`), { code: 'ENOENT' });
  };

  it('names the process by boot and start ticks and keeps argv as launched', async () => {
    expect(await probeProc(42, readFrom(files))).toEqual({ start: 'b7c1e2f0-1111-2222-3333-444455556666:987654', argv: ['node', '/repo/server/cli.ts', 'run', '--run-id', 'hello-001-r1'] });
  });
  it('is null when the process does not exist', async () => {
    expect(await probeProc(43, readFrom(files))).toBeNull();
  });
  it('still answers when only the boot id or the command line cannot be read', async () => {
    expect(await probeProc(42, readFrom({ '/proc/42/stat': files['/proc/42/stat']! }))).toEqual({ start: ':987654', argv: [] });
  });
});

describe('parsePs', () => {
  it('splits the start time from the command', () => {
    expect(parsePs('Sat Oct  4 10:00:00 2026 /usr/bin/node /repo/server/cli.ts run --run-id hello-001-r1\n')).toEqual({
      start: 'Sat Oct  4 10:00:00 2026',
      argv: ['/usr/bin/node', '/repo/server/cli.ts', 'run', '--run-id', 'hello-001-r1'],
    });
  });
  it('is null for empty or unexpected output', () => {
    expect(parsePs('')).toBeNull();
    expect(parsePs('not a ps line')).toBeNull();
  });
});

describe('with a real process', () => {
  const tell = process.platform === 'linux' || process.platform === 'darwin';
  let dir = '';
  let child: ReturnType<typeof spawn> | undefined;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-pidid-'));
  });
  afterEach(async () => {
    child?.kill('SIGKILL');
    await fs.rm(dir, { recursive: true, force: true });
  });
  const start = async (marker: string): Promise<number> => {
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', marker], { stdio: 'ignore' });
    await new Promise((resolve, reject) => child!.once('spawn', resolve).once('error', reject));
    return child.pid!;
  };

  it.skipIf(!tell)('probeProcess gives a stable start and the real argv, then null once the process is gone', async () => {
    const pid = await start('hello-001-r1');
    const first = await probeProcess(pid);
    expect(first?.argv).toContain('hello-001-r1');
    expect(await probeProcess(pid)).toEqual(first);
    child!.kill('SIGKILL');
    await new Promise((resolve) => child!.once('exit', resolve));
    expect(await probeProcess(pid)).toBeNull();
  });

  it.skipIf(!tell)('a pid file stays trusted while its process lives and is refused once the number names another process', async () => {
    const pid = await start('hello-001-r1');
    await fs.mkdir(path.join(dir, 'hello-001-r1'));
    await writePid(dir, 'hello-001-r1', pid);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'hello-001-r1', 'pid'), 'utf8'))).toMatchObject({ pid });
    expect(await readPid(dir, 'hello-001-r1')).toBe(pid);
    // Same number, other incarnation: what a reboot or a container restart leaves behind.
    await fs.writeFile(path.join(dir, 'hello-001-r1', 'pid'), JSON.stringify({ pid, start: 'another-boot:1' }));
    expect(await readPid(dir, 'hello-001-r1')).toBeNull();
    await expect(fs.access(path.join(dir, 'hello-001-r1', 'pid.gone'))).resolves.toBeUndefined();
  });

  it.runIf(process.platform === 'win32')('Windows cannot tell: the pid is stored bare, as before', async () => {
    const pid = await start('hello-001-r1');
    expect(await probeProcess(pid)).toBeNull();
    await fs.mkdir(path.join(dir, 'hello-001-r1'));
    await writePid(dir, 'hello-001-r1', pid);
    expect(await fs.readFile(path.join(dir, 'hello-001-r1', 'pid'), 'utf8')).toBe(String(pid));
  });
});
