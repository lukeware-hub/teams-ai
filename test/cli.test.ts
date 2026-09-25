import { describe, expect, it } from 'vitest';
import { main } from '../server/cli.js';

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

  it('maps run results to exit codes', async () => {
    const results = ['complete', 'blocked', 'deadlocked', 'phase-failed', 'drained', 'paused:auth'] as const;
    const codes: number[] = [];
    for (const r of results) {
      const a = io(['run', '--project', '/tmp/p', '--spec', 'spec-001']);
      codes.push(await main(a.io, async () => ({ execute: async () => r, close: async () => {}, runId: 'spec-001-r1', journal: { state: { tasks: new Map() } }, accounting: { total: () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, steps: 0 }) } }) as never));
    }
    expect(codes).toEqual([0, 2, 2, 2, 3, 2]);
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
});
