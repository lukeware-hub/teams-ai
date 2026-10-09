import { promises as fs, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../server/config/config.js';
import { claimLaunch, clearStopRequested, markStopRequested } from '../../server/api/run-index.js';
import type { RunControlDeps, SpawnArgs } from '../../server/api/run-control.js';
import { superviseTick, type Backoff, type SuperviseDeps } from '../../server/supervisor/supervise.js';
import { writeRun } from '../fixtures/runs/write-run.js';

const HELLO = path.resolve('test/fixtures/hello-app');
let home = '';
let runs = '';
let clock = 0;
const alive = new Set<number>();
const spawned: SpawnArgs[] = [];
const logs: string[] = [];
let nextPid = 5000;

const deps = (): SuperviseDeps => ({
  idx: { cfg: loadConfig({ paths: { runs: runs.replace(/\\/g, '/') }, projects: [{ dir: HELLO }] }), home, isAlive: (pid) => alive.has(pid) },
  control: {
    spawn: (a) => {
      spawned.push(a);
      alive.add(nextPid);
      return { pid: nextPid++ };
    },
    kill: () => true,
    sleep: async () => {},
    cliEntry: () => ({ bin: 'node', prefix: ['cli.ts'] }),
    repoRoot: '/repo',
  } as RunControlDeps,
  projectDir: HELLO,
  intervalMs: 1000,
  now: () => clock,
  log: (s) => logs.push(s),
});

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-sup-'));
  runs = path.join(home, 'runs');
  clock = 0;
  nextPid = 5000;
  alive.clear();
  spawned.length = 0;
  logs.length = 0;
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

const started = (runId: string) => ({ type: 'RUN_STARTED', data: { runId, specId: 'hello-001', projectId: 'hello-app' } });
const state = (status: string) => ({ runId: 'x', at: '2026-09-24T10:01:00.000Z', status, tasks: [], tokens: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, steps: 1 } });

describe('supervise', () => {
  it('resumes only interrupted unfinished runs, never finished, live, auth-paused or stopped ones', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('running'), 111); // dead pid: interrupted
    await writeRun(runs, 'hello-001-r2', [started('hello-001-r2'), { type: 'RUN_FINISHED', data: { result: 'complete' } }], state('running'), 112);
    await writeRun(runs, 'hello-001-r3', [started('hello-001-r3')], state('running'), 113);
    alive.add(113);
    await writeRun(runs, 'hello-001-r4', [started('hello-001-r4')], state('paused:auth'));
    await writeRun(runs, 'hello-001-r5', [started('hello-001-r5'), { type: 'RUN_STOP_REQUESTED' }], state('draining'), 115);

    const resumed = await superviseTick(deps(), new Map());
    expect(resumed).toEqual(['hello-001-r1']);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.args.slice(-4)).toEqual(['--project', HELLO, '--run', 'hello-001-r1'].slice(-4));
    expect(spawned[0]!.args).toContain('resume');
    expect(await fs.readFile(path.join(runs, 'hello-001-r1', 'pid'), 'utf8')).toBe('5000');
    expect(logs.join('\n')).toContain('resumed hello-001-r1');
    expect(logs.join('\n')).toContain('hello-001-r5 skipped');
  });

  it('never resumes an interrupted run of a concluded spec', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('running'), 111); // dead pid: interrupted
    await writeRun(runs, 'hello-001-complete-r1', [started('hello-001-complete-r1'), { type: 'RUN_FINISHED', data: { result: 'done' } }], state('running'));
    expect(await superviseTick(deps(), new Map())).toEqual([]);
    expect(spawned).toHaveLength(0);
  });

  it('a stop is intentional only while it is the last lifecycle event', async () => {
    const stop = { type: 'RUN_STOP_REQUESTED' };
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1'), stop, { type: 'RUN_RESUMED' }], state('running'), 111); // hand resume, then crashed
    await writeRun(runs, 'hello-001-r2', [started('hello-001-r2'), stop, started('hello-001-r2')], state('running'), 112); // restarted
    await writeRun(runs, 'hello-001-r3', [started('hello-001-r3'), stop, { type: 'RUN_RESUMED' }, stop], state('draining'), 113); // stopped again
    expect((await superviseTick(deps(), new Map())).sort()).toEqual(['hello-001-r1', 'hello-001-r2']);
    expect(logs.join('\n')).toContain('hello-001-r3 skipped');
  });

  it('resumes a run at most once while it lives, and backs off when it dies again', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('running'), 111);
    const backoff: Backoff = new Map();
    expect(await superviseTick(deps(), backoff)).toEqual(['hello-001-r1']);
    expect(await superviseTick(deps(), backoff)).toEqual([]); // alive now
    alive.delete(5000); // dies again right away
    clock = 1500; // before interval * 2
    expect(await superviseTick(deps(), backoff)).toEqual([]);
    clock = 2500;
    expect(await superviseTick(deps(), backoff)).toEqual(['hello-001-r1']);
    expect(spawned).toHaveLength(2);
  });

  it('logs a failed spawn and keeps going', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('running'), 111);
    const d = deps();
    d.control.spawn = () => {
      throw new Error('no pid');
    };
    expect(await superviseTick(d, new Map())).toEqual([]);
    expect(logs.join('\n')).toContain('resume of hello-001-r1 failed: no pid');
    expect(await claimLaunch(runs, 'hello-001-r1')).not.toBeNull(); // a failed spawn does not keep the run claimed
  });

  it('never resumes a run the user stopped from the UI, journal or not, until the user resumes it', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('running'), 111); // no RUN_STOP_REQUESTED: the signal never reached the CLI
    await markStopRequested(runs, 'hello-001-r1');
    expect(await superviseTick(deps(), new Map())).toEqual([]);
    expect(spawned).toHaveLength(0);
    expect(logs.join('\n')).toContain('hello-001-r1 skipped');
    await clearStopRequested(runs, 'hello-001-r1'); // what the explicit resume does
    expect(await superviseTick(deps(), new Map())).toEqual(['hello-001-r1']);
  });

  it('looks again right before resuming: a run revived since the scan is left alone', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('running'), 111);
    await writeRun(runs, 'hello-001-r2', [started('hello-001-r2')], state('running'), 112);
    const d = deps();
    const spawn = d.control.spawn;
    d.control.spawn = (a) => {
      const out = spawn(a);
      // while the first run is resumed, the UI resumes the other one: its pid file now names a live process
      const other = a.args.includes('hello-001-r1') ? 'hello-001-r2' : 'hello-001-r1';
      writeFileSync(path.join(runs, other, 'pid'), '777');
      alive.add(777);
      return out;
    };
    expect(await superviseTick(d, new Map())).toHaveLength(1);
    expect(spawned).toHaveLength(1);
  });

  it('leaves a run alone while another spawner holds its launch claim, and frees the claim when done', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state('running'), 111);
    const release = (await claimLaunch(runs, 'hello-001-r1'))!;
    expect(await superviseTick(deps(), new Map())).toEqual([]);
    expect(spawned).toHaveLength(0);
    await release();
    expect(await superviseTick(deps(), new Map())).toEqual(['hello-001-r1']);
    expect(await claimLaunch(runs, 'hello-001-r1')).not.toBeNull();
  });
});

describe('launch claim', () => {
  it('is exclusive, and a claim left behind by a dead spawner expires', async () => {
    await fs.mkdir(path.join(runs, 'hello-001-r1'), { recursive: true });
    const first = await claimLaunch(runs, 'hello-001-r1');
    expect(first).not.toBeNull();
    expect(await claimLaunch(runs, 'hello-001-r1')).toBeNull();
    const old = new Date(Date.now() - 10 * 60_000);
    await fs.utimes(path.join(runs, 'hello-001-r1', 'launch-claim'), old, old);
    const taken = await claimLaunch(runs, 'hello-001-r1');
    expect(taken).not.toBeNull();
    await taken!();
    expect(await claimLaunch(runs, 'hello-001-r1')).not.toBeNull();
  });
});
