import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chooseSpecId, main } from '../server/cli.js';
import { loadConfig } from '../server/config/config.js';
import type { RunControlDeps, SpawnArgs } from '../server/api/run-control.js';
import { writeRun } from './fixtures/runs/write-run.js';

const io = (argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { argv, env: {}, stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) }, out, err };
};

describe('teams-ai cli', () => {
  it('prints usage and exits 2 on an unknown command or missing flags', async () => {
    const a = io(['nope']);
    expect(await main(a.io)).toBe(2);
    expect(a.err.join('\n')).toContain('Usage');
    expect(a.err.join('\n')).toContain('teams-ai ui');
    const b = io(['run']);
    expect(await main(b.io)).toBe(2);
    expect(b.err.join('\n')).toContain('--project');
  });

  it('spec deploy is listed and rejects an unknown --target before loading anything', async () => {
    const a = io(['spec', 'deploy', '--project', '/nowhere', '--spec', 's', '--target', 'aws']);
    expect(await main(a.io)).toBe(2);
    expect(a.err.join('\n')).toContain('spec deploy');
    expect(a.err.join('\n')).toContain('--target must be docker-local');
    const b = io(['spec', 'deploy']);
    expect(await main(b.io)).toBe(2);
    expect(b.err.join('\n')).toContain('--project');
  });

  it('maps run results to exit codes', async () => {
    const results = ['complete', 'blocked', 'deadlocked', 'phase-failed', 'drained', 'paused:auth'] as const;
    const codes: number[] = [];
    for (const r of results) {
      const a = io(['run', '--project', '/tmp/p', '--spec', 'spec-001']);
      codes.push(await main(a.io, async () => ({ execute: async () => r, close: async () => {}, runId: 'spec-001-r1', journal: { state: { tasks: new Map() } }, accounting: { total: () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, steps: 0 }) } }) as never));
    }
    expect(codes).toEqual([0, 2, 2, 2, 3, 2]);
  });

  it('supervise requires --project and a positive --interval, and rejects a non-positive --interval', async () => {
    const a = io(['supervise']);
    expect(await main(a.io)).toBe(2);
    expect(a.err.join('\n')).toContain('--project');
    const b = io(['supervise', '--project', '/nowhere', '--interval', '0']);
    expect(await main(b.io, undefined, { signals: () => () => {} })).toBe(2);
    expect(b.err.join('\n')).toContain('--interval must be a positive number');
  });

  it('supervise resumes an interrupted run once, leaves live and finished runs alone, and exits 0 on SIGTERM', async () => {
    const hello = path.resolve('test/fixtures/hello-app');
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-cli-sup-'));
    try {
      const runs = path.join(home, 'runs');
      const started = (runId: string) => ({ type: 'RUN_STARTED', data: { runId, specId: 'hello-001', projectId: 'hello-app' } });
      const state = { runId: 'x', at: '2026-09-24T10:01:00.000Z', status: 'running', tasks: [], tokens: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, steps: 1 } };
      await writeRun(runs, 'hello-001-r1', [started('hello-001-r1')], state, 111); // dead: interrupted
      await writeRun(runs, 'hello-001-r2', [started('hello-001-r2')], state, 112); // live
      await writeRun(runs, 'hello-001-r3', [started('hello-001-r3'), { type: 'RUN_FINISHED', data: { result: 'complete' } }], state, 113); // finished
      const alive = new Set([112]);
      const spawned: SpawnArgs[] = [];
      let stop = () => {};
      let sleeps = 0;
      const control = {
        spawn: (a: SpawnArgs) => { spawned.push(a); alive.add(5000); return { pid: 5000 }; },
        kill: () => true,
        // 1s slices: the first scan, one full 1s interval, a second scan, then SIGTERM
        sleep: async () => { if (++sleeps === 2) stop(); },
        cliEntry: () => ({ bin: 'node', prefix: ['cli.ts'] }),
        repoRoot: '/repo',
      } as RunControlDeps;
      const idx = { cfg: loadConfig({ paths: { runs: runs.split(path.sep).join('/') }, projects: [{ dir: hello }] }), home, isAlive: (pid: number) => alive.has(pid) };
      const a = io(['supervise', '--project', hello, '--interval', '1']);
      const code = await main(a.io, undefined, { supervision: { idx, control }, signals: (onStop) => { stop = onStop; return () => {}; } });
      expect(code).toBe(0);
      expect(sleeps).toBe(2);
      expect(spawned).toHaveLength(1);
      expect(spawned[0]!.args).toContain('resume');
      expect(spawned[0]!.args).toContain('hello-001-r1');
      expect(a.err.join('|')).toContain('resumed hello-001-r1');
      expect(a.err.join('|')).toContain('supervise: stopped');
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('ui starts the API on the requested port and serves the status route', async () => {
    const a = io(['ui', '--port', '0', '--project', '/tmp/p']);
    let closed = false;
    const code = await main(a.io, undefined, {
      startUi: async (port) => ({ port: port === 0 ? 45678 : port, close: async () => { closed = true; } }),
      waitForSignal: async () => undefined,
    });
    expect(code).toBe(0);
    expect(a.err.join('\n')).toContain('http://localhost:45678/');
    expect(closed).toBe(true);
  });

  it('run passes --run-id to the factory and a SIGTERM requests a stop', async () => {
    const seen: Array<string | undefined> = [];
    let stops = 0;
    let resolveRun: (r: 'drained') => void = () => {};
    const a = io(['run', '--project', '/tmp/p', '--spec', 'spec-001', '--run-id', 'spec-001-r9']);
    const code = main(
      a.io,
      async (_deps, runId, explicitId) => {
        seen.push(runId, explicitId);
        return {
          runId: explicitId ?? 'x',
          execute: () => new Promise<'drained'>((r) => (resolveRun = r)),
          requestStop: async () => { stops += 1; },
          close: async () => {},
          journal: { state: { tasks: new Map() } },
          accounting: { total: () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, steps: 0 }) },
        } as never;
      },
      { signals: (cb) => { setTimeout(() => cb(), 5); return () => {}; } },
    );
    await new Promise((r) => setTimeout(r, 20));
    resolveRun('drained');
    expect(await code).toBe(3);
    expect(seen).toEqual([undefined, 'spec-001-r9']);
    expect(stops).toBe(1);
  });

  it('run accepts --draft and still reaches the factory', async () => {
    const a = io(['run', '--project', '/tmp/p', '--spec', 'spec-001', '--draft']);
    let reached = false;
    const code = await main(
      a.io,
      async () => {
        reached = true;
        return { runId: 'x', execute: async () => 'complete', requestStop: async () => {}, close: async () => {}, journal: { state: { tasks: new Map() } }, accounting: { total: () => ({ costUsd: 0 }) } } as never;
      },
      { signals: () => () => {} },
    );
    expect(code).toBe(0);
    expect(reached).toBe(true);
  });
});

describe('chooseSpecId', () => {
  const dirs = ['a-001', 'a-001-z'];
  it('prefers --spec, then the spec of the run being resumed, then the last spec directory', () => {
    expect(chooseSpecId('a-001', 'a-001-z', dirs)).toBe('a-001');
    expect(chooseSpecId(undefined, 'a-001', dirs)).toBe('a-001');
    expect(chooseSpecId(undefined, null, dirs)).toBe('a-001-z');
    expect(chooseSpecId(undefined, null, [])).toBeUndefined();
  });
});
