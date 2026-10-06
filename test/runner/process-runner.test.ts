import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Invocation } from '../../server/runner/invocation.js';
import { preflightSandbox, runProcess, type RunnerBinary } from '../../server/runner/process-runner.js';

const FAKE = path.resolve('test/fixtures/fake-claude/fake-claude.mjs');
const fixture = (name: string) => path.resolve(`test/fixtures/stream/${name}.ndjson`);
const fake = (env: Record<string, string>): RunnerBinary => ({ bin: process.execPath, prefixArgs: [FAKE], env, requireSandboxTools: false });

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-runner-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const inv = (over: Partial<Invocation> = {}): Invocation => ({ args: ['-p', '--agent', 'dev'], env: { ONLY_THIS: '1' }, cwd: dir, stdin: 'hello prompt', ...over });
const caps = { timeoutMs: 5_000, maxTurns: 50, killGraceMs: 200 };

describe('runProcess', () => {
  it('replays a success stream, feeds the prompt on stdin and summarizes', async () => {
    const capture = path.join(dir, 'capture.json');
    const result = await runProcess(fake({ FAKE_CLAUDE_FIXTURE: fixture('real-json-schema'), FAKE_CLAUDE_CAPTURE: capture }), inv(), caps);
    expect(result.summary.found).toBe(true);
    expect(result.summary.isError).toBe(false);
    expect(result.summary.structuredOutput).toEqual({ specHash: 'sha256:aa', status: 'done' });
    expect(result.exitCode).toBe(0);
    expect(result.killedBy).toBeNull();
    expect(result.sandboxDisabled).toBe(false);
    const captured = JSON.parse(await fs.readFile(capture, 'utf8'));
    expect(captured.argv).toEqual(['-p', '--agent', 'dev']);
    expect(captured.prompt).toBe('hello prompt');
    expect(path.resolve(captured.cwd)).toBe(path.resolve(dir));
  });

  it('passes only the invocation environment plus the binary scenario to the child', async () => {
    const capture = path.join(dir, 'capture.json');
    await runProcess(fake({ FAKE_CLAUDE_FIXTURE: fixture('success'), FAKE_CLAUDE_CAPTURE: capture }), inv(), caps);
    const captured = JSON.parse(await fs.readFile(capture, 'utf8'));
    expect(captured.env.ONLY_THIS).toBe('1');
    expect(captured.env).not.toHaveProperty('GITHUB_TOKEN');
  });

  it('streams each line to the observer as it arrives', async () => {
    const seen: string[] = [];
    await runProcess(fake({ FAKE_CLAUDE_FIXTURE: fixture('success') }), inv(), caps, (line) => seen.push(line));
    expect(seen).toHaveLength(3);
    expect(JSON.parse(seen[0]!).type).toBe('system');
  });

  it('kills a hanging process at the timeout and reports the partial stream', async () => {
    // The timeout runs from the spawn of a real Node process; a short real timeout fires before the child has printed
    // anything when the machine is loaded. Fake only that timer and fire it once the child's one line has arrived.
    const timeoutMs = 60_000;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const started = Date.now();
      const result = await runProcess(fake({ FAKE_CLAUDE_FIXTURE: fixture('success'), FAKE_CLAUDE_HANG_AFTER: '1' }), inv(), { ...caps, timeoutMs }, () => {
        vi.advanceTimersByTime(timeoutMs);
      });
      expect(result.killedBy).toBe('timeout');
      expect(result.summary.found).toBe(false);
      expect(result.parsed.events).toHaveLength(1);
      expect(Date.now() - started).toBeLessThan(4_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts turns by distinct assistant message id, not by content block', async () => {
    // real-turns has 3 assistant lines sharing one message id, then a result with num_turns 1.
    const result = await runProcess(fake({ FAKE_CLAUDE_FIXTURE: fixture('real-turns') }), inv(), { ...caps, maxTurns: 1 });
    expect(result.killedBy).toBeNull();
    expect(result.turns).toBe(1);
  });

  it('kills the process when the abort signal fires', async () => {
    const ctl = new AbortController();
    const result = await runProcess(fake({ FAKE_CLAUDE_FIXTURE: fixture('success'), FAKE_CLAUDE_HANG_AFTER: '1' }), inv(), caps, () => ctl.abort(), ctl.signal);
    expect(result.killedBy).toBe('aborted');
  });

  it('kills the process when the turn cap is exceeded', async () => {
    const result = await runProcess(fake({ FAKE_CLAUDE_FIXTURE: fixture('success'), FAKE_CLAUDE_DELAY_MS: '20', FAKE_CLAUDE_HANG_AFTER: '2' }), inv(), { ...caps, maxTurns: 0 });
    expect(result.killedBy).toBe('turns');
  });

  it('kills immediately when stderr reports a disabled sandbox', async () => {
    const result = await runProcess(
      fake({ FAKE_CLAUDE_FIXTURE: fixture('success'), FAKE_CLAUDE_DELAY_MS: '150', FAKE_CLAUDE_STDERR: '⚠ Sandbox disabled: sandbox is enabled but dependencies are missing: bubblewrap' }),
      inv(),
      caps,
    );
    expect(result.sandboxDisabled).toBe(true);
    expect(result.killedBy).toBe('environment');
    expect(result.parsed.events.length).toBeLessThan(3);
  });

  it('reports the exit code and malformed lines when the stream is noisy', async () => {
    const result = await runProcess(fake({ FAKE_CLAUDE_FIXTURE: fixture('noisy'), FAKE_CLAUDE_EXIT_CODE: '3' }), inv(), caps);
    expect(result.exitCode).toBe(3);
    expect(result.summary.found).toBe(true);
    expect(result.parsed.malformed).toHaveLength(2);
  });

  it('resolves even when a grandchild keeps stdout open after the child exits', async () => {
    const started = Date.now();
    const result = await runProcess(fake({ FAKE_CLAUDE_FIXTURE: fixture('success'), FAKE_CLAUDE_CHILD_HOLD: '4000' }), inv(), caps);
    expect(result.summary.found).toBe(true);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('rejects when the binary cannot be spawned', async () => {
    await expect(runProcess({ bin: path.join(dir, 'no-such-binary'), prefixArgs: [], env: {}, requireSandboxTools: false }, inv(), caps)).rejects.toThrow();
  });
});

describe('preflightSandbox', () => {
  it('passes when both tools are on PATH', async () => {
    const bin = path.join(dir, 'bin');
    await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, 'bwrap'), '');
    await fs.writeFile(path.join(bin, 'socat'), '');
    expect(await preflightSandbox({ PATH: bin })).toEqual([]);
  });

  it('names each missing tool', async () => {
    expect(await preflightSandbox({ PATH: dir })).toEqual(['bwrap', 'socat']);
  });
});
