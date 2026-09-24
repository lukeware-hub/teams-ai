import { describe, expect, it } from 'vitest';
import { CommandError, execCommand } from '../../server/exec/command.js';
import { FakeExec } from '../fixtures/fake-exec.js';

const node = (code: string, over: Partial<Parameters<typeof execCommand>[0]> = {}) =>
  execCommand({ bin: process.execPath, args: ['-e', code], timeoutMs: 5_000, ...over });

describe('execCommand', () => {
  it('captures stdout, stderr and the exit code', async () => {
    const r = await node('process.stdout.write("out"); process.stderr.write("err"); process.exit(3)');
    expect(r).toMatchObject({ exitCode: 3, stdout: 'out', stderr: 'err', timedOut: false, truncated: false });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('feeds stdin and passes only the given environment on top of the base', async () => {
    const r = await node('let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(s+"|"+(process.env.X??"")+"|"+(process.env.LEAK??"none"))})', {
      stdin: 'hi',
      env: { X: '1' },
    });
    expect(r.stdout).toBe('hi|1|none');
  });

  it('kills a process that exceeds the timeout', async () => {
    const started = Date.now();
    const r = await node('setInterval(()=>{},1000)', { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode === null || r.exitCode !== 0).toBe(true);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('truncates output beyond the limit and flags it', async () => {
    const r = await node('process.stdout.write("x".repeat(5000))', { outputLimit: 1000 });
    expect(r.stdout.length).toBe(1000);
    expect(r.truncated).toBe(true);
  });

  it('throws CommandError when the binary does not exist', async () => {
    await expect(execCommand({ bin: 'definitely-not-a-binary-xyz', args: [], timeoutMs: 1000 })).rejects.toThrow(CommandError);
  });

  it('uses cwd', async () => {
    const r = await node('process.stdout.write(process.cwd())', { cwd: process.cwd() });
    expect(r.stdout.toLowerCase()).toBe(process.cwd().toLowerCase());
  });
});

describe('FakeExec', () => {
  it('records calls and answers matched ones', async () => {
    const fake = new FakeExec().on((s) => s.bin === 'gh', () => ({ stdout: '[]' }));
    const r = await fake.exec({ bin: 'gh', args: ['pr', 'list'], timeoutMs: 1 });
    expect(r).toMatchObject({ exitCode: 0, stdout: '[]' });
    const other = await fake.exec({ bin: 'git', args: ['status'], timeoutMs: 1 });
    expect(other.exitCode).toBe(0);
    expect(fake.calls.map((c) => c.bin)).toEqual(['gh', 'git']);
  });
});
