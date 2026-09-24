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
});
