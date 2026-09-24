import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Invocation } from '../../server/runner/invocation.js';
import { runProcess, type RunnerBinary } from '../../server/runner/process-runner.js';

const FAKE = path.resolve('test/fixtures/fake-claude/fake-claude.mjs');
const fixture = (name: string) => path.resolve(`test/fixtures/stream/${name}.ndjson`);
const binary: RunnerBinary = { bin: process.execPath, prefixArgs: [FAKE] };

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-runner-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const inv = (env: Record<string, string>): Invocation => ({ args: ['-p', 'hi', '--agent', 'dev'], env, cwd: dir });
const caps = { timeoutMs: 5_000, maxTurns: 50, killGraceMs: 200 };

describe('runProcess', () => {
  it('replays a success stream and summarizes it', async () => {
    const capture = path.join(dir, 'capture.json');
    const result = await runProcess(binary, inv({ FAKE_CLAUDE_FIXTURE: fixture('real-json-schema'), FAKE_CLAUDE_CAPTURE: capture }), caps);
    expect(result.summary.found).toBe(true);
    expect(result.summary.isError).toBe(false);
    expect(result.summary.structuredOutput).toEqual({ specHash: 'sha256:aa', status: 'done' });
    expect(result.exitCode).toBe(0);
    expect(result.killedBy).toBeNull();
    expect(result.sandboxDisabled).toBe(false);
    const captured = JSON.parse(await fs.readFile(capture, 'utf8'));
    expect(captured.argv).toEqual(['-p', 'hi', '--agent', 'dev']);
    expect(path.resolve(captured.cwd)).toBe(path.resolve(dir));
  });

  it('passes only the invocation environment to the child', async () => {
    const capture = path.join(dir, 'capture.json');
    await runProcess(binary, inv({ FAKE_CLAUDE_FIXTURE: fixture('success'), FAKE_CLAUDE_CAPTURE: capture, ONLY_THIS: '1' }), caps);
    const captured = JSON.parse(await fs.readFile(capture, 'utf8'));
    expect(captured.env.ONLY_THIS).toBe('1');
    expect(captured.env).not.toHaveProperty('GITHUB_TOKEN');
  });

  it('streams each line to the observer as it arrives', async () => {
    const seen: string[] = [];
    await runProcess(binary, inv({ FAKE_CLAUDE_FIXTURE: fixture('success') }), caps, (line) => seen.push(line));
    expect(seen).toHaveLength(3);
    expect(JSON.parse(seen[0]!).type).toBe('system');
  });

  it('kills a hanging process at the timeout and reports the partial stream', async () => {
    const started = Date.now();
    const result = await runProcess(binary, inv({ FAKE_CLAUDE_FIXTURE: fixture('success'), FAKE_CLAUDE_HANG_AFTER: '1' }), { ...caps, timeoutMs: 400 });
    expect(result.killedBy).toBe('timeout');
    expect(result.summary.found).toBe(false);
    expect(result.parsed.events).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('kills the process when the turn cap is exceeded', async () => {
    const result = await runProcess(
      binary,
      inv({ FAKE_CLAUDE_FIXTURE: fixture('success'), FAKE_CLAUDE_DELAY_MS: '20', FAKE_CLAUDE_HANG_AFTER: '2' }),
      { ...caps, maxTurns: 0 },
    );
    expect(result.killedBy).toBe('turns');
  });

  it('flags a disabled sandbox from stderr', async () => {
    const result = await runProcess(
      binary,
      inv({ FAKE_CLAUDE_FIXTURE: fixture('success'), FAKE_CLAUDE_STDERR: '⚠ Sandbox disabled: sandbox is enabled but dependencies are missing: bubblewrap' }),
      caps,
    );
    expect(result.sandboxDisabled).toBe(true);
    expect(result.stderr).toContain('Sandbox disabled');
  });

  it('reports a non-zero exit without a result as not found', async () => {
    const result = await runProcess(binary, inv({ FAKE_CLAUDE_FIXTURE: fixture('noisy'), FAKE_CLAUDE_EXIT_CODE: '3' }), caps);
    expect(result.exitCode).toBe(3);
    expect(result.summary.found).toBe(true);
    expect(result.parsed.malformed).toHaveLength(2);
  });

  it('rejects when the binary cannot be spawned', async () => {
    await expect(runProcess({ bin: path.join(dir, 'no-such-binary'), prefixArgs: [] }, inv({}), caps)).rejects.toThrow();
  });
});
