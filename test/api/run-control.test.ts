import { describe, expect, it } from 'vitest';
import { isAlive, runCommand, spawnRun, stop, type RunControlDeps } from '../../server/api/run-control.js';

function fake(alive: Set<number>, over: Partial<RunControlDeps> = {}) {
  const spawns: Array<{ bin: string; args: string[]; cwd: string; logFile: string }> = [];
  const signals: Array<[number, NodeJS.Signals | 0]> = [];
  const sleeps: number[] = [];
  const deps: RunControlDeps = {
    spawn: (a) => {
      spawns.push(a);
      alive.add(4242);
      return { pid: 4242 };
    },
    kill: (pid, sig) => {
      signals.push([pid, sig]);
      if (!alive.has(Math.abs(pid))) return false;
      if (sig === 'SIGKILL') alive.delete(Math.abs(pid));
      return true;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    cliEntry: () => ({ bin: '/usr/bin/node', prefix: ['/repo/node_modules/tsx/dist/cli.mjs', '/repo/server/cli.ts'] }),
    repoRoot: '/repo',
    ...over,
  };
  return { deps, spawns, signals, sleeps };
}

describe('run control', () => {
  it('builds the run and resume command lines with the explicit run id', () => {
    const { deps } = fake(new Set());
    expect(runCommand(deps, { projectDir: '/p', specId: 'hello-001', runId: 'hello-001-r2', mode: 'run' })).toEqual({
      bin: '/usr/bin/node',
      args: ['/repo/node_modules/tsx/dist/cli.mjs', '/repo/server/cli.ts', 'run', '--project', '/p', '--spec', 'hello-001', '--run-id', 'hello-001-r2'],
      cwd: '/repo',
      logFile: 'ui.log',
    });
    expect(runCommand(deps, { projectDir: '/p', specId: 'hello-001', runId: 'hello-001-r2', mode: 'resume' }).args.slice(2)).toEqual(['resume', '--project', '/p', '--run', 'hello-001-r2']);
    expect(runCommand(deps, { projectDir: '/p', specId: 'hello-001', runId: 'hello-001-r2', mode: 'resume', retryBlocked: true }).args.slice(-1)).toEqual(['--retry-blocked']);
  });
  it('spawnRun returns the pid and isAlive probes with signal 0', () => {
    const alive = new Set<number>();
    const { deps, spawns, signals } = fake(alive);
    expect(spawnRun(deps, { projectDir: '/p', specId: 's', runId: 's-r1', mode: 'run' })).toEqual({ pid: 4242 });
    expect(spawns).toHaveLength(1);
    expect(isAlive(deps, 4242)).toBe(true);
    expect(isAlive(deps, 1)).toBe(false);
    expect(signals).toEqual([
      [4242, 0],
      [1, 0],
    ]);
  });
  it('stop sends SIGTERM to the group, polls, and escalates to SIGKILL after the timeout', async () => {
    const alive = new Set([4242]);
    const { deps, signals, sleeps } = fake(alive);
    expect(await stop(deps, 4242, 1000)).toBe('killed');
    expect(signals[0]).toEqual([-4242, 'SIGTERM']);
    expect(sleeps.length).toBe(4); // 1000 / 250
    expect(signals.at(-1)).toEqual([-4242, 'SIGKILL']);
  });
  it('stop reports terminated when the process exits during the poll and gone when it never existed', async () => {
    const alive = new Set([4242]);
    let polls = 0;
    const { deps } = fake(alive, {
      sleep: async () => {
        if (++polls === 2) alive.delete(4242);
      },
    });
    expect(await stop(deps, 4242, 1000)).toBe('terminated');
    expect(await stop(fake(new Set()).deps, 99, 1000)).toBe('gone');
  });
  it('adds --draft to a run command when asked', () => {
    const { deps } = fake(new Set());
    expect(runCommand(deps, { projectDir: '/d', specId: 's', runId: 's-r1', mode: 'run', draft: true }).args.slice(-1)).toEqual(['--draft']);
    expect(runCommand(deps, { projectDir: '/d', specId: 's', runId: 's-r1', mode: 'run' }).args).not.toContain('--draft');
  });
});
