import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunControlDeps } from '../../server/api/run-control.js';
import { listRuns, readPid, writePid } from '../../server/api/run-index.js';
import { runRoutes } from '../../server/api/run-routes.js';
import { startApi } from '../../server/api/server.js';
import { loadConfig } from '../../server/config/config.js';
import { readUserConfig } from '../../server/onboarding/config-store.js';
import { superviseTick } from '../../server/supervisor/supervise.js';
import { writeRun } from '../fixtures/runs/write-run.js';

// The machine's process table as the code under test sees it: pid -> what a probe reports for it. `whileAsking` runs
// while a probe is in flight, the moment a concurrent launch could rewrite the pid file.
const table = vi.hoisted(() => new Map<number, { start: string; argv: string[] }>());
const asking = vi.hoisted(() => ({ whileAsking: null as null | (() => Promise<void>) }));
vi.mock('../../server/api/process-identity.js', () => ({
  probeProcess: async (pid: number) => {
    await asking.whileAsking?.();
    return table.get(pid) ?? null;
  },
}));

const HELLO = path.resolve('test/fixtures/hello-app');
const RUN = 'hello-001-r1';
let home = '';
let runs = '';
let api: { port: number; close(): Promise<void> };
const alive = new Set<number>();
let signals: Array<[number, string | number]>;
let spawned: number[];
const control: RunControlDeps = {
  spawn: (a) => {
    const pid = 6000 + spawned.length;
    spawned.push(pid);
    alive.add(pid);
    table.set(pid, { start: `boot:${pid}`, argv: ['node', ...a.args] });
    return { pid };
  },
  kill: (pid, sig) => {
    signals.push([pid, sig]);
    if (!alive.has(Math.abs(pid))) return false;
    if (sig === 'SIGTERM' || sig === 'SIGKILL') alive.delete(Math.abs(pid));
    return true;
  },
  sleep: async () => {},
  cliEntry: () => ({ bin: 'node', prefix: ['cli'] }),
  repoRoot: '/repo',
};
const pidPath = (runId = RUN) => path.join(runs, runId, 'pid');
const exists = (file: string) => fs.access(file).then(() => true, () => false);
const post = (p: string) => fetch(`http://127.0.0.1:${api.port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' } });

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-pidid-api-'));
  runs = path.join(home, 'runs');
  await fs.mkdir(path.join(home, '.teams-ai'), { recursive: true });
  await fs.writeFile(path.join(home, '.teams-ai', 'config.json'), JSON.stringify({ paths: { runs: runs.replace(/\\/g, '/') }, projects: [{ dir: HELLO }] }));
  table.clear();
  asking.whileAsking = null;
  alive.clear();
  signals = [];
  spawned = [];
  api = await startApi({ routes: runRoutes({ cfg: async () => (await readUserConfig(home)).cfg, home, control }) }, 0);
});
afterEach(async () => {
  await api.close();
  await fs.rm(home, { recursive: true, force: true });
});

const started = { type: 'RUN_STARTED', data: { runId: RUN, specId: 'hello-001', projectId: 'hello-app' } };
const state = { runId: RUN, at: '2026-09-24T10:01:00.000Z', status: 'running', tasks: [], tokens: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01, steps: 1 } };
/** The run's own process, as the OS reports it. */
const ours = (start: string) => ({ start, argv: ['node', 'cli.ts', 'run', '--run-id', RUN] });
/** A run whose pid file was written when `pid` was its process (start `then`). */
async function runWithRecordedPid(pid: number, then: string): Promise<void> {
  await writeRun(runs, RUN, [started], state);
  table.set(pid, ours(then));
  await writePid(runs, RUN, pid);
}

describe('pid file', () => {
  it('records the start of a process that carries the run id, and reads back the pid', async () => {
    await runWithRecordedPid(4242, 'boot:100');
    expect(JSON.parse(await fs.readFile(pidPath(), 'utf8'))).toEqual({ pid: 4242, start: 'boot:100' });
    expect(await readPid(runs, RUN)).toBe(4242);
  });

  it('stays a bare number when the process at that pid is unknown or is not this run', async () => {
    await writeRun(runs, RUN, [started], state);
    await writePid(runs, RUN, 4242); // nothing at that pid
    expect(await fs.readFile(pidPath(), 'utf8')).toBe('4242');
    table.set(4242, { start: 'boot:1', argv: ['sshd', '-D'] }); // a stranger
    await writePid(runs, RUN, 4242);
    expect(await fs.readFile(pidPath(), 'utf8')).toBe('4242');
    table.set(4242, { start: 'boot:1', argv: ['node', 'cli.ts', 'run', '--run-id', `${RUN}0`] }); // another run whose id merely starts the same
    await writePid(runs, RUN, 4242);
    expect(await fs.readFile(pidPath(), 'utf8')).toBe('4242');
  });

  it('still reads a pid file that holds just a number, whatever runs at that pid', async () => {
    await writeRun(runs, RUN, [started], state, 4242);
    table.set(4242, { start: 'boot:1', argv: ['sshd', '-D'] });
    expect(await readPid(runs, RUN)).toBe(4242);
    expect(await exists(pidPath())).toBe(true);
  });

  it('refuses a pid whose process is not the one that wrote it, and retires the file like a dead pid', async () => {
    await runWithRecordedPid(4242, 'boot:100');
    table.set(4242, { start: 'boot:999', argv: ['sshd', '-D'] }); // the number was reused
    expect(await readPid(runs, RUN)).toBeNull();
    expect(await exists(pidPath())).toBe(false);
    expect(await exists(`${pidPath()}.gone`)).toBe(true);
  });

  it('does not retire a pid file that a launch rewrote while the OS was being asked', async () => {
    await runWithRecordedPid(4242, 'boot:100');
    table.set(4242, { start: 'boot:999', argv: ['sshd', '-D'] });
    asking.whileAsking = async () => {
      asking.whileAsking = null;
      table.set(5001, ours('boot:200'));
      await writePid(runs, RUN, 5001); // the resume's pid file lands between the read and the verdict
    };
    expect(await readPid(runs, RUN)).toBeNull(); // judged on the old file
    expect(await exists(`${pidPath()}.gone`)).toBe(false);
    expect(await readPid(runs, RUN)).toBe(5001); // the new file survived
  });

  it('leaves a pid with no process behind it to the liveness check', async () => {
    await runWithRecordedPid(4242, 'boot:100');
    table.delete(4242);
    expect(await readPid(runs, RUN)).toBe(4242);
    expect(await exists(pidPath())).toBe(true);
  });

  it('reads garbage as no pid', async () => {
    await writeRun(runs, RUN, [started], state);
    for (const text of ['', 'abc', '{}', '{"pid":"7"}', '{"pid":-1,"start":"x"}', 'null']) {
      await fs.writeFile(pidPath(), text);
      expect(await readPid(runs, RUN), JSON.stringify(text)).toBeNull();
    }
  });
});

describe('a pid file that outlived its process', () => {
  it('lists the run as interrupted and not stoppable, without asking whether the stranger is alive', async () => {
    await runWithRecordedPid(4242, 'boot:100');
    table.set(4242, { start: 'boot:999', argv: ['sshd', '-D'] });
    const isAlive = vi.fn((pid: number) => alive.has(pid));
    alive.add(4242);
    const cfg = loadConfig({ paths: { runs: runs.replace(/\\/g, '/') }, projects: [{ dir: HELLO }] });
    const rows = await listRuns({ cfg, home, isAlive }, 'hello-app');
    expect(rows.map((r) => [r.runId, r.status, r.stoppable])).toEqual([[RUN, 'interrupted', false]]);
    expect(isAlive).not.toHaveBeenCalled();
  });

  it('Stop refuses it and signals nothing', async () => {
    await runWithRecordedPid(4242, 'boot:100');
    table.set(4242, { start: 'boot:999', argv: ['sshd', '-D'] });
    alive.add(4242); // kill(pid, 0) would say yes: that is the whole problem
    const res = await post(`/api/runs/${RUN}/stop`);
    expect(res.status).toBe(409);
    expect(signals.filter(([pid]) => Math.abs(pid) === 4242 && pid !== 0)).toEqual([]);
    expect(signals.some(([, sig]) => sig === 'SIGTERM' || sig === 'SIGKILL')).toBe(false);
    expect(alive.has(4242)).toBe(true);
    expect(await exists(`${pidPath()}.gone`)).toBe(true);
    expect(await exists(path.join(runs, RUN, 'stop-requested'))).toBe(false);
  });

  it('Stop still signals the group of the process that wrote the pid file', async () => {
    await runWithRecordedPid(4242, 'boot:100');
    alive.add(4242);
    const res = await post(`/api/runs/${RUN}/stop`);
    expect(await res.json()).toEqual({ stopped: true, how: 'terminated' });
    expect(signals).toContainEqual([-4242, 'SIGTERM']);
  });

  it('is resumed by the supervisor instead of hiding behind the stranger, and the resumed process is recorded', async () => {
    await runWithRecordedPid(4242, 'boot:100');
    table.set(4242, { start: 'boot:999', argv: ['sshd', '-D'] });
    alive.add(4242);
    const idx = { cfg: (await readUserConfig(home)).cfg, home, isAlive: (pid: number) => alive.has(pid) };
    const resumed = await superviseTick({ idx, control, projectDir: HELLO, intervalMs: 1000, now: () => 0, log: () => {} }, new Map());
    expect(resumed).toEqual([RUN]);
    expect(JSON.parse(await fs.readFile(pidPath(), 'utf8'))).toEqual({ pid: 6000, start: 'boot:6000' });
    expect(signals).toEqual([]);
  });
});
