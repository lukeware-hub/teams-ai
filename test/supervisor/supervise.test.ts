import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../server/config/config.js';
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
  });
});
