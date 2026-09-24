import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseAgentFile } from '../../server/agents/registry.js';
import { Accounting } from '../../server/budget/accounting.js';
import { classifyFailure, runStep, type StepDeps, type StepRequest } from '../../server/runner/step.js';
import type { RawStepResult } from '../../server/runner/process-runner.js';
import { parseStreamJson, summarizeStream } from '../../server/runner/stream-events.js';

const FAKE = path.resolve('test/fixtures/fake-claude/fake-claude.mjs');
const fixture = (name: string) => path.resolve(`test/fixtures/stream/${name}.ndjson`);
const HASH_AA = `sha256:${'a'.repeat(64)}`;

const devAgent = parseAgentFile(`---\nname: dev\ndescription: d\nmodel: opus\ntools: Read, Edit, Bash\n---\nEcho specHash.`, 'dev');

let dir: string;
let deps: StepDeps;
let fakeEnv: Record<string, string>;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-step-'));
  fakeEnv = {};
  deps = {
    binary: { bin: process.execPath, prefixArgs: [FAKE] },
    caps: { timeoutMs: 5_000, maxTurns: 50, killGraceMs: 200 },
    accounting: new Accounting(),
    claudeJsonPath: path.join(dir, '.claude.json'),
    hostEnv: { HOME: dir, PATH: process.env.PATH ?? '', ...fakeEnv },
    clock: () => new Date('2026-09-24T10:00:00.000Z'),
  };
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const request = (over: Partial<StepRequest> = {}): StepRequest => ({
  kind: 'dev',
  role: 'dev',
  agent: devAgent,
  profile: { provider: 'claude', model: 'opus' },
  model: 'opus',
  cwd: dir,
  prompt: 'Implement it',
  expectedSpecHash: HASH_AA,
  phase: 'tasks',
  taskId: 'T1-create',
  attempt: 1,
  ...over,
});

// The fake binary reads its scenario from the environment the runner passes through hostEnv.
const withFake = (vars: Record<string, string>) => {
  deps.hostEnv = { ...deps.hostEnv, ...vars };
};

describe('runStep', () => {
  it('returns a validated value and records usage on success', async () => {
    withFake({ FAKE_CLAUDE_FIXTURE: fixture('real-json-schema') });
    const outcome = await runStep(
      request({ kind: 'dev', semantic: [] }),
      { ...deps, hostEnv: deps.hostEnv },
    );
    expect(outcome.ok).toBe(false); // real-json-schema output lacks summary/changedFiles → schema failure
    if (!outcome.ok) {
      expect(outcome.failure).toBe('schema');
      expect(outcome.errors.join(' ')).toMatch(/summary|changedFiles/);
    }
    const rec = deps.accounting.records()[0]!;
    expect(rec).toMatchObject({ role: 'dev', phase: 'tasks', taskId: 'T1-create', attempt: 1, provider: 'claude', numTurns: 2 });
    expect(rec.usage.cacheWriteTokens).toBe(2892);
  });

  it('accepts a fixture whose structured output satisfies the contract', async () => {
    const ok = path.join(dir, 'ok.ndjson');
    const value = { specHash: HASH_AA, status: 'done', summary: 'did it', commitMessage: 'feat: x', changedFiles: ['src/a.ts'] };
    await fs.writeFile(
      ok,
      [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-opus-5-5' }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [] }, session_id: 's' }),
        JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, num_turns: 1, result: JSON.stringify(value), structured_output: value, session_id: 's', total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 2 } }),
      ].join('\n'),
    );
    withFake({ FAKE_CLAUDE_FIXTURE: ok });
    const outcome = await runStep(request(), deps);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.value).toEqual(value);
  });

  it('classifies the compaction breaker and discards its output', async () => {
    withFake({ FAKE_CLAUDE_FIXTURE: fixture('real-compaction-breaker') });
    const outcome = await runStep(request(), deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure).toBe('compaction');
  });

  it('classifies a disabled sandbox as environment before anything else', async () => {
    withFake({ FAKE_CLAUDE_FIXTURE: fixture('real-json-schema'), FAKE_CLAUDE_STDERR: 'Sandbox disabled: bubblewrap missing' });
    const outcome = await runStep(request(), deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure).toBe('environment');
      expect(outcome.sandboxDisabled).toBe(true);
    }
  });

  it('classifies a kill by timeout', async () => {
    withFake({ FAKE_CLAUDE_FIXTURE: fixture('success'), FAKE_CLAUDE_HANG_AFTER: '1' });
    const outcome = await runStep(request(), { ...deps, caps: { ...deps.caps, timeoutMs: 300 } });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure).toBe('timeout');
  });

  it('rejects a specHash mismatch as a schema failure', async () => {
    withFake({ FAKE_CLAUDE_FIXTURE: fixture('real-json-schema') });
    const outcome = await runStep(request({ expectedSpecHash: `sha256:${'b'.repeat(64)}` }), deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure).toBe('schema');
    }
  });

  it('trusts the working directory before spawning', async () => {
    withFake({ FAKE_CLAUDE_FIXTURE: fixture('success') });
    await runStep(request(), deps);
    const json = JSON.parse(await fs.readFile(deps.claudeJsonPath, 'utf8'));
    expect(json.projects[dir].hasTrustDialogAccepted).toBe(true);
  });
});

describe('classifyFailure', () => {
  const raw = (over: Partial<RawStepResult>, text = ''): RawStepResult => {
    const parsed = parseStreamJson(text);
    return { parsed, summary: summarizeStream(parsed), stderr: '', exitCode: 0, killedBy: null, sandboxDisabled: false, durationMs: 1, ...over };
  };

  it('maps a rejected rate limit to quota', () => {
    const text = [
      '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","unifiedWindows":{"five_hour":{"utilization":1,"resetsAt":1}}}}',
      '{"type":"result","subtype":"success","is_error":true,"result":"You have hit your usage limit"}',
    ].join('\n');
    expect(classifyFailure(raw({}, text))).toBe('quota');
  });

  it('maps an auth error text to auth', () => {
    expect(classifyFailure(raw({}, '{"type":"result","subtype":"error","is_error":true,"result":"Not logged in. Please run claude login"}'))).toBe('auth');
  });

  it('maps a missing result to code', () => {
    expect(classifyFailure(raw({}, '{"type":"system","subtype":"init"}'))).toBe('code');
  });

  it('returns null for a clean success', () => {
    expect(classifyFailure(raw({}, '{"type":"result","subtype":"success","is_error":false,"result":"{}"}'))).toBeNull();
  });
});

describe('runStep agent injection', () => {
  it('sends the role agent definition inline so a bare worktree still has the agent', async () => {
    const capture = path.join(dir, 'capture.json');
    withFake({ FAKE_CLAUDE_FIXTURE: fixture('success'), FAKE_CLAUDE_CAPTURE: capture });
    await runStep(request(), deps);
    const captured = JSON.parse(await fs.readFile(capture, 'utf8'));
    const agents = JSON.parse(captured.argv[captured.argv.indexOf('--agents') + 1]);
    expect(agents.dev).toMatchObject({ prompt: devAgent.body, tools: devAgent.tools, model: devAgent.model });
  });
});
