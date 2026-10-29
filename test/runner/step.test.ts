import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUESTION_RULES, parseAgentFile } from '../../server/agents/registry.js';
import { Accounting } from '../../server/budget/accounting.js';
import type { RawStepResult } from '../../server/runner/process-runner.js';
import { hasSession } from '../../server/runner/session-store.js';
import { absoluteRule } from '../../server/runner/role-settings.js';
import { classifyFailure, runStep, stepCaps, type StepDeps, type StepRequest } from '../../server/runner/step.js';
import { parseStreamJson, summarizeStream } from '../../server/runner/stream-events.js';

const FAKE = path.resolve('test/fixtures/fake-claude/fake-claude.mjs');
const fixture = (name: string) => path.resolve(`test/fixtures/stream/${name}.ndjson`);
const HASH = `sha256:${'a'.repeat(64)}`;

const devAgent = parseAgentFile(`---\nname: dev\ndescription: d\nmodel: opus\ntools: Read, Edit, Bash\n---\nEcho specHash.`, 'dev');

let dir: string;
let deps: StepDeps;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-step-'));
  deps = {
    binary: { bin: process.execPath, prefixArgs: [FAKE], env: {}, requireSandboxTools: false },
    caps: { timeoutMs: 5_000, maxTurns: 50, killGraceMs: 200 },
    accounting: new Accounting(),
    claudeJsonPath: path.join(dir, '.claude.json'),
    settingsDir: path.join(dir, 'settings'),
    workspacesRoot: dir,
    network: { allowedDomains: ['registry.npmjs.org'] },
    hostEnv: { HOME: dir, PATH: process.env.PATH ?? '' },
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
  profile: { model: 'opus' },
  model: 'opus',
  cwd: dir,
  prompt: 'Implement it',
  expectedSpecHash: HASH,
  phase: 'tasks',
  taskId: 'T1-create',
  attempt: 1,
  ...over,
});

const withFake = (vars: Record<string, string>) => {
  deps.binary = { ...deps.binary, env: { ...deps.binary.env, ...vars } };
};

async function writeStream(name: string, events: object[]): Promise<string> {
  const file = path.join(dir, name);
  await fs.writeFile(file, events.map((e) => JSON.stringify(e)).join('\n'));
  return file;
}

const okValue = { specHash: HASH, status: 'done', summary: 'did it', commitMessage: 'feat: x', changedFiles: ['src/a.ts'], filesRead: [], deviations: [] };
const init = { type: 'system', subtype: 'init', session_id: 's', model: 'claude-opus-5-5' };

describe('runStep', () => {
  it('rejects an output that fails the contract as a schema failure and still records usage', async () => {
    withFake({ FAKE_CLAUDE_FIXTURE: fixture('real-json-schema') });
    const outcome = await runStep(request(), deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure).toBe('schema');
      expect(outcome.errors.join(' ')).toMatch(/summary|changedFiles|specHash/);
    }
    const rec = deps.accounting.records()[0]!;
    expect(rec).toMatchObject({ role: 'dev', phase: 'tasks', taskId: 'T1-create', attempt: 1, provider: 'claude', numTurns: 2 });
    expect(rec.usage.cacheWriteTokens).toBe(2892);
  });

  it('quotes the answer the schema rejected, with its secret redacted', async () => {
    const rejected = { ...okValue, status: 'finished', summary: 'token=sk-secret-123' };
    const bad = await writeStream('rejected.ndjson', [
      init,
      { type: 'result', subtype: 'success', is_error: false, duration_ms: 5, num_turns: 1, result: JSON.stringify(rejected), structured_output: rejected, session_id: 's' },
    ]);
    withFake({ FAKE_CLAUDE_FIXTURE: bad });
    const outcome = await runStep(request(), deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      const text = outcome.errors.join(' ');
      expect(text).toContain('"status":"finished"');
      expect(text).not.toContain('sk-secret-123');
    }
  });

  it('accepts structured output that satisfies the contract', async () => {
    const ok = await writeStream('ok.ndjson', [
      init,
      { type: 'result', subtype: 'success', is_error: false, duration_ms: 5, num_turns: 1, result: JSON.stringify(okValue), structured_output: okValue, session_id: 's', total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 2 } },
    ]);
    withFake({ FAKE_CLAUDE_FIXTURE: ok });
    const outcome = await runStep(request(), deps);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.value).toEqual(okValue);
  });

  it('accepts fenced JSON in the result text when structured_output is absent', async () => {
    const ok = await writeStream('fenced.ndjson', [
      init,
      { type: 'result', subtype: 'success', is_error: false, duration_ms: 5, num_turns: 1, result: '```json\n' + JSON.stringify(okValue, null, 2) + '\n```', session_id: 's' },
    ]);
    withFake({ FAKE_CLAUDE_FIXTURE: ok });
    const outcome = await runStep(request(), deps);
    expect(outcome.ok).toBe(true);
    expect(outcome.summary.structuredSource).toBe('text');
  });

  it('explains a missing JSON object with the agent text, subtype and the secret redacted', async () => {
    const prose = await writeStream('prose.ndjson', [
      init,
      { type: 'result', subtype: 'success', is_error: false, duration_ms: 5, num_turns: 2, result: 'I edited design.md directly. token=sk-secret-123', session_id: 's' },
    ]);
    withFake({ FAKE_CLAUDE_FIXTURE: prose });
    const outcome = await runStep(request(), deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure).toBe('schema');
      const text = outcome.errors.join(' ');
      expect(text).toContain('no JSON object in the agent result');
      expect(text).toContain('I edited design.md directly');
      expect(text).toContain('subtype=success');
      expect(text).toContain('JSON.parse: Unexpected end of JSON input');
      expect(text).not.toContain('sk-secret-123');
    }
  });

  it('classifies the compaction breaker and discards a valid structured output', async () => {
    const breaker = await writeStream('breaker.ndjson', [
      init,
      { type: 'system', subtype: 'compact_boundary', session_id: 's', compact_metadata: { trigger: 'auto', pre_tokens: 70000, post_tokens: 900 } },
      { type: 'result', subtype: 'success', is_error: true, terminal_reason: 'rapid_refill_breaker', duration_ms: 5, num_turns: 9, result: 'Autocompact is thrashing', structured_output: okValue, session_id: 's' },
    ]);
    withFake({ FAKE_CLAUDE_FIXTURE: breaker });
    const outcome = await runStep(request(), deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure).toBe('compaction');
  });

  it('classifies a disabled sandbox as environment', async () => {
    withFake({ FAKE_CLAUDE_FIXTURE: fixture('real-json-schema'), FAKE_CLAUDE_STDERR: 'Sandbox disabled: bubblewrap missing' });
    const outcome = await runStep(request(), deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure).toBe('environment');
      expect(outcome.sandboxDisabled).toBe(true);
    }
  });

  it('asks classifyUnknown only when no rule matched, and uses its answer', async () => {
    const odd = await writeStream('odd.ndjson', [init, { type: 'result', subtype: 'error_during_execution', is_error: true, api_error_status: 529, duration_ms: 5, num_turns: 1, result: 'Overloaded, retry after 5h', session_id: 's' }]);
    withFake({ FAKE_CLAUDE_FIXTURE: odd });
    const seen: unknown[] = [];
    const outcome = await runStep(request(), { ...deps, classifyUnknown: async (input) => { seen.push(input); return 'quota'; } });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure).toBe('quota');
    expect(seen).toEqual([expect.objectContaining({ apiErrorStatus: 529, resultText: 'Overloaded, retry after 5h', subtype: 'error_during_execution' })]);

    const capped = await writeStream('capped-no-ask.ndjson', [init, { type: 'result', subtype: 'error_max_turns', is_error: true, duration_ms: 5, num_turns: 25, session_id: 's' }]);
    withFake({ FAKE_CLAUDE_FIXTURE: capped });
    seen.length = 0;
    await runStep(request(), { ...deps, classifyUnknown: async () => 'quota' as const });
    expect(seen).toEqual([]);
  });

  it('classifies the CLI turn cap as timeout, like the runner cap', async () => {
    // No compaction in this stream: compaction outranks every other classification.
    const capped = await writeStream('max-turns.ndjson', [init, { type: 'result', subtype: 'error_max_turns', is_error: true, duration_ms: 90000, num_turns: 25, session_id: 's' }]);
    withFake({ FAKE_CLAUDE_FIXTURE: capped });
    const outcome = await runStep(request(), deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure).toBe('timeout');
  });

  it('refuses a cwd outside the workspaces root before trusting or spawning anything', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-outside-'));
    try {
      const outcome = await runStep(request({ cwd: outside }), deps);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.failure).toBe('environment');
        expect(outcome.errors[0]).toMatch(/outside the workspaces root/);
      }
      await expect(fs.access(deps.settingsDir)).rejects.toThrow();
      expect(deps.accounting.total().outputTokens).toBe(0);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('classifies a kill by timeout and keeps the partial usage', async () => {
    withFake({ FAKE_CLAUDE_FIXTURE: fixture('killed-partial'), FAKE_CLAUDE_HANG_AFTER: '4' });
    // The runner's timeout runs from the spawn of a real Node process; a short real timeout fires before the child has
    // printed anything when the machine is loaded. Fake only that timer and fire it once the last of the four lines
    // has arrived, so "output, then timeout" holds whatever the load.
    const timeoutMs = 60_000;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let lines = 0;
      const outcome = await runStep(request(), {
        ...deps,
        caps: { ...deps.caps, timeoutMs },
        onEvent: () => {
          if (++lines === 4) vi.advanceTimersByTime(timeoutMs);
        },
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.failure).toBe('timeout');
      expect(deps.accounting.total().outputTokens).toBe(50);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a successful output even when the rate limit reading is not allowed', async () => {
    const warn = await writeStream('warn.ndjson', [
      init,
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: 1790259600, unifiedWindows: { five_hour: { utilization: 0.97, resetsAt: 1790259600 } } } },
      { type: 'result', subtype: 'success', is_error: false, duration_ms: 5, num_turns: 1, result: JSON.stringify(okValue), structured_output: okValue, session_id: 's' },
    ]);
    withFake({ FAKE_CLAUDE_FIXTURE: warn });
    const outcome = await runStep(request(), deps);
    expect(outcome.ok).toBe(true);
    expect(outcome.summary.rateLimit?.status).toBe('allowed_warning');
  });

  it('rejects a specHash mismatch as a schema failure', async () => {
    withFake({ FAKE_CLAUDE_FIXTURE: fixture('real-json-schema') });
    const outcome = await runStep(request({ expectedSpecHash: `sha256:${'b'.repeat(64)}` }), deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure).toBe('schema');
  });

  it('denies the secrets directory of every project, the one a step works in and the others', async () => {
    const capture = path.join(dir, 'capture.json');
    withFake({ FAKE_CLAUDE_FIXTURE: fixture('success'), FAKE_CLAUDE_CAPTURE: capture });
    const cwd = path.join(dir, 'kayron-hub', 'worktrees', 't1');
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(dir, 'other-project', 'secrets'), { recursive: true });
    await runStep(request({ cwd }), deps);
    const captured = JSON.parse(await fs.readFile(capture, 'utf8'));
    const settings = JSON.parse(await fs.readFile(captured.argv[captured.argv.indexOf('--settings') + 1], 'utf8'));
    for (const project of ['kayron-hub', 'other-project']) {
      expect(settings.sandbox.filesystem.denyRead).toContain(path.join(dir, project, 'secrets'));
      expect(settings.permissions.deny).toContain(`Read(${absoluteRule(path.join(dir, project, 'secrets'))}/**)`);
    }
    // A project created after the settings were written is covered by the wildcard.
    expect(settings.sandbox.filesystem.denyRead).toContain(path.join(dir, '*', 'secrets'));
    expect(settings.permissions.deny).toContain(`Read(${absoluteRule(path.join(dir, '*', 'secrets'))}/**)`);
  });

  it('writes the role settings before spawning and never touches the host claude.json', async () => {
    const capture = path.join(dir, 'capture.json');
    withFake({ FAKE_CLAUDE_FIXTURE: fixture('success'), FAKE_CLAUDE_CAPTURE: capture });
    await runStep(request(), deps);
    await expect(fs.access(deps.claudeJsonPath!)).rejects.toThrow();
    const captured = JSON.parse(await fs.readFile(capture, 'utf8'));
    const settingsPath = captured.argv[captured.argv.indexOf('--settings') + 1];
    // One file per step, named after the step HOME, so two steps of one role never overwrite each other's policy.
    expect(path.dirname(path.dirname(settingsPath))).toBe(deps.settingsDir);
    expect(path.basename(settingsPath)).toBe('dev.settings.json');
    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    expect(settings.sandbox).toMatchObject({ enabled: true, network: { allowedDomains: ['registry.npmjs.org'] } });
    expect(settings.sandbox.filesystem.denyRead).toContain(`${dir}/.teams-ai/secrets`);
    // The step HOME holds a copy of the credentials: no command of the step reads it.
    expect(settings.sandbox.filesystem.denyRead).toContain(`${captured.env.HOME}/.claude`);
    expect(settings.permissions.deny).toContain('Edit(.claude/**)');
    expect(captured.prompt).toBe(`${QUESTION_RULES}\n\nImplement it`);
  });

  it('passes extraEnv through to the child process', async () => {
    const capture = path.join(dir, 'capture.json');
    withFake({ FAKE_CLAUDE_FIXTURE: fixture('success'), FAKE_CLAUDE_CAPTURE: capture });
    await runStep(request({ extraEnv: { DATABASE_URL: 'postgres://u:p@dind:55432/t' } }), deps);
    const captured = JSON.parse(await fs.readFile(capture, 'utf8'));
    expect(captured.env.DATABASE_URL).toBe('postgres://u:p@dind:55432/t');
  });

  it('sends the role agent definition as a file with the step model, never on the command line', async () => {
    const capture = path.join(dir, 'capture.json');
    withFake({ FAKE_CLAUDE_FIXTURE: fixture('success'), FAKE_CLAUDE_CAPTURE: capture });
    await runStep(request({ model: 'sonnet' }), deps);
    const captured = JSON.parse(await fs.readFile(capture, 'utf8'));
    const agents = JSON.parse(await fs.readFile(captured.argv[captured.argv.indexOf('--agents') + 1], 'utf8'));
    expect(agents.dev).toMatchObject({ prompt: devAgent.body, tools: devAgent.tools, model: 'sonnet' });
    expect(captured.argv.join(' ')).not.toContain(devAgent.body);
  });

  it('gives the 5-minute prompt cache TTL to every step, dev included', async () => {
    const capture = path.join(dir, 'capture.json');
    withFake({ FAKE_CLAUDE_FIXTURE: fixture('success'), FAKE_CLAUDE_CAPTURE: capture });
    await runStep(request({ kind: 'dev' }), deps);
    expect(JSON.parse(await fs.readFile(capture, 'utf8')).env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('5m');
    await runStep(request({ kind: 'security' }), deps);
    expect(JSON.parse(await fs.readFile(capture, 'utf8')).env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('5m');
  });

  it('keeps the session transcript of a step and restores it into the HOME of the step that resumes it', async () => {
    const capture = path.join(dir, 'capture.json');
    const store = path.join(dir, 'store');
    withFake({ FAKE_CLAUDE_FIXTURE: fixture('success'), FAKE_CLAUDE_CAPTURE: capture, FAKE_CLAUDE_SESSION: '1' });
    await runStep(request({ sessionId: 'sess-1', sessionStore: store }), deps);
    let captured = JSON.parse(await fs.readFile(capture, 'utf8'));
    expect(captured.argv).toContain('--session-id');
    expect(captured.argv).not.toContain('--no-session-persistence');
    expect(await hasSession(store, 'sess-1', dir)).toBe(true);
    await runStep(request({ sessionId: 'sess-1', resume: true, sessionStore: store, prompt: 'Fix it' }), deps);
    captured = JSON.parse(await fs.readFile(capture, 'utf8'));
    expect(captured.argv[captured.argv.indexOf('--resume') + 1]).toBe('sess-1');
    expect(captured.transcript).toBe(true);
    expect(captured.prompt).toBe(`${QUESTION_RULES}\n\nFix it`);
  });

  it('books only the share of a resumed session that the CLI reports cumulatively', async () => {
    const store = path.join(dir, 'store');
    const result = (cost: number, apiMs: number) => ({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, duration_api_ms: apiMs, num_turns: 1, result: JSON.stringify(okValue), structured_output: okValue, session_id: 's', total_cost_usd: cost, usage: { input_tokens: 1, output_tokens: 2 } });
    withFake({ FAKE_CLAUDE_FIXTURE: await writeStream('first.ndjson', [init, result(0.37, 62_000)]), FAKE_CLAUDE_SESSION: '1' });
    const first = await runStep(request({ sessionId: 'sess-1', sessionStore: store }), deps);
    withFake({ FAKE_CLAUDE_FIXTURE: await writeStream('second.ndjson', [init, result(0.55, 84_000)]), FAKE_CLAUDE_SESSION: '1' });
    const second = await runStep(request({ sessionId: 'sess-1', resume: true, sessionStore: store }), deps);
    expect(first.summary.costUsd).toBe(0.37);
    expect(second.summary.costUsd).toBeCloseTo(0.18, 6);
    expect(second.summary.profile?.durationApiMs).toBe(22_000);
    expect(deps.accounting.records().map((r) => r.costUsd)).toEqual([0.37, second.summary.costUsd]);
  });

  it('books only the tokens a resumed session added, and flags totals that went down instead of booking zero', async () => {
    const store = path.join(dir, 'store');
    const result = (cost: number, input: number, output: number) => ({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, duration_api_ms: 1_000, num_turns: 1, result: JSON.stringify(okValue), structured_output: okValue, session_id: 's', total_cost_usd: cost, usage: { input_tokens: input, output_tokens: output } });
    const run = async (name: string, event: object, resume: boolean) => {
      withFake({ FAKE_CLAUDE_FIXTURE: await writeStream(name, [init, event]), FAKE_CLAUDE_SESSION: '1' });
      return runStep(request({ sessionId: 'sess-1', resume, sessionStore: store }), deps);
    };
    await run('first.ndjson', result(0.37, 100, 20), false);
    await run('second.ndjson', result(0.55, 160, 50), true);
    const third = await run('third.ndjson', result(0.1, 40, 10), true);
    expect(deps.accounting.records().map((r) => [r.usage.inputTokens, r.usage.outputTokens])).toEqual([[100, 20], [60, 30], [40, 10]]);
    expect(deps.accounting.records()[2]!.costUsd).toBe(0.1);
    expect(third.summary.profile?.sessionTotalsReset).toBe(true);
  });

  it('ends with an environment failure when the step setup throws before the agent runs', async () => {
    await fs.writeFile(path.join(dir, 'not-a-dir'), '');
    const outcome = await runStep(request(), { ...deps, settingsDir: path.join(dir, 'not-a-dir', 'settings') });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure).toBe('environment');
      expect(outcome.errors[0]).toMatch(/ENOTDIR/);
    }
  });

  it('hands the step only the API key the config chose, and drops one that sits in the host env', async () => {
    const capture = path.join(dir, 'capture.json');
    withFake({ FAKE_CLAUDE_FIXTURE: fixture('success'), FAKE_CLAUDE_CAPTURE: capture });
    deps.hostEnv = { ...deps.hostEnv, ANTHROPIC_API_KEY: 'sk-from-the-host' };
    await runStep(request(), deps);
    expect(JSON.parse(await fs.readFile(capture, 'utf8')).env.ANTHROPIC_API_KEY).toBeUndefined();
    deps.apiKey = 'sk-ant-api03-chosen';
    await runStep(request(), deps);
    expect(JSON.parse(await fs.readFile(capture, 'utf8')).env.ANTHROPIC_API_KEY).toBe('sk-ant-api03-chosen');
  });

  it('never gives a review step the file-editing tools', async () => {
    const capture = path.join(dir, 'capture.json');
    withFake({ FAKE_CLAUDE_FIXTURE: fixture('success'), FAKE_CLAUDE_CAPTURE: capture });
    const agent = { ...devAgent, tools: ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'] };
    await runStep(request({ kind: 'review', agent }), deps);
    const captured = JSON.parse(await fs.readFile(capture, 'utf8'));
    expect(captured.argv[captured.argv.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,Bash');
    expect(JSON.parse(await fs.readFile(captured.argv[captured.argv.indexOf('--agents') + 1], 'utf8')).dev.tools).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
    await runStep(request({ kind: 'dev', agent }), deps);
    expect(JSON.parse(await fs.readFile(capture, 'utf8')).argv).toContain('Read,Edit,Write,Grep,Glob,Bash');
  });

  it('adds the web tools to a step with full access only', async () => {
    const capture = path.join(dir, 'capture.json');
    withFake({ FAKE_CLAUDE_FIXTURE: fixture('success'), FAKE_CLAUDE_CAPTURE: capture });
    const toolsOf = async () => {
      const { argv } = JSON.parse(await fs.readFile(capture, 'utf8'));
      return argv[argv.indexOf('--tools') + 1];
    };
    await runStep(request({ kind: 'dev' }), deps);
    expect(await toolsOf()).not.toContain('WebSearch');
    await runStep(request({ kind: 'dev', fullAccess: true }), deps);
    expect(await toolsOf()).toMatch(/,WebSearch,WebFetch$/);
  });

  it('gives a refinement step no file-editing tools either, since its changes reach the docs only as patches', async () => {
    const capture = path.join(dir, 'capture.json');
    withFake({ FAKE_CLAUDE_FIXTURE: fixture('success'), FAKE_CLAUDE_CAPTURE: capture });
    const agent = { ...devAgent, tools: ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'] };
    await runStep(request({ kind: 'refine', agent }), deps);
    const captured = JSON.parse(await fs.readFile(capture, 'utf8'));
    expect(captured.argv[captured.argv.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,Bash');
  });

  it('gives a chat step Read, Grep, Glob and Bash with only its graphify rules allowed and its fenced directories denied, and a short turn cap', async () => {
    const capture = path.join(dir, 'capture.json');
    withFake({ FAKE_CLAUDE_FIXTURE: fixture('success'), FAKE_CLAUDE_CAPTURE: capture });
    await runStep(request({ kind: 'chat', role: 'po', agent: { ...devAgent, tools: [] }, extraAllow: ['Bash(graphify query:*)'], denyRead: ['/ws/*/repo'] }), deps);
    const captured = JSON.parse(await fs.readFile(capture, 'utf8'));
    expect(captured.argv[captured.argv.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,Bash');
    const settings = JSON.parse(await fs.readFile(captured.argv[captured.argv.indexOf('--settings') + 1], 'utf8'));
    // The PO role's Skill permission is listed, but the chat's tools leave the Skill tool out, so the chat cannot call it.
    expect(settings.permissions.allow).toEqual(['Skill', 'Bash(agent-reach:*)', 'Bash(graphify query:*)']);
    expect(settings.sandbox.filesystem.denyRead).toContain('/ws/*/repo');
    expect(settings.permissions.deny).toContain('Read(//ws/*/repo)');
    expect(stepCaps('chat', deps.caps).maxTurns).toBe(6);
    expect(stepCaps('dev', deps.caps).maxTurns).toBe(50);
    expect(stepCaps('chat', { ...deps.caps, maxTurns: 3 }).maxTurns).toBe(3);
  });

  it('lets the file tools of a plan step write only under docs/specs/ of its folder, so the inputs and a CLAUDE.md stay out of reach', async () => {
    const capture = path.join(dir, 'capture.json');
    withFake({ FAKE_CLAUDE_FIXTURE: fixture('success'), FAKE_CLAUDE_CAPTURE: capture });
    const fileRules = async (): Promise<string[]> => {
      const captured = JSON.parse(await fs.readFile(capture, 'utf8'));
      const settings = JSON.parse(await fs.readFile(captured.argv[captured.argv.indexOf('--settings') + 1], 'utf8'));
      return (settings.permissions.allow as string[]).filter((rule) => /^(Edit|Write|MultiEdit)\b/.test(rule));
    };
    await runStep(request({ kind: 'speckit' }), deps);
    expect(await fileRules()).toEqual([`Edit(${absoluteRule(path.join(dir, 'docs', 'specs'))}/**)`]);
    // Any other step of the role keeps the file tools its role allows.
    await runStep(request(), deps);
    expect(await fileRules()).toEqual(['Edit', 'Write', 'MultiEdit']);
  });

  it('adds the step\'s own text to the end of the agent prompt, which is the part the API caches', async () => {
    const capture = path.join(dir, 'capture.json');
    withFake({ FAKE_CLAUDE_FIXTURE: fixture('success'), FAKE_CLAUDE_CAPTURE: capture });
    await runStep(request({ kind: 'dev', systemExtra: 'EXTRA RULES' }), deps);
    let captured = JSON.parse(await fs.readFile(capture, 'utf8'));
    expect(JSON.parse(await fs.readFile(captured.argv[captured.argv.indexOf('--agents') + 1], 'utf8')).dev.prompt).toBe(`${devAgent.body}\n\nEXTRA RULES`);
    await runStep(request({ kind: 'dev' }), deps);
    captured = JSON.parse(await fs.readFile(capture, 'utf8'));
    expect(JSON.parse(await fs.readFile(captured.argv[captured.argv.indexOf('--agents') + 1], 'utf8')).dev.prompt).toBe(devAgent.body);
  });

  it('returns an environment failure when the working directory does not exist, without trusting it', async () => {
    const missing = path.join(dir, 'missing');
    const outcome = await runStep(request({ cwd: missing }), deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure).toBe('environment');
    await expect(fs.access(deps.settingsDir)).rejects.toThrow();
  });

  it('returns an environment failure when the binary cannot be spawned', async () => {
    const outcome = await runStep(request(), { ...deps, binary: { bin: path.join(dir, 'no-such-binary'), prefixArgs: [], env: {}, requireSandboxTools: false } });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure).toBe('environment');
      expect(outcome.errors[0]).toMatch(/spawn|ENOENT/);
    }
  });

  it('returns an environment failure when the sandbox tools are missing on the host', async () => {
    withFake({ FAKE_CLAUDE_FIXTURE: fixture('success') });
    const outcome = await runStep(request(), { ...deps, binary: { ...deps.binary, requireSandboxTools: true }, hostEnv: { HOME: dir, PATH: dir } });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure).toBe('environment');
      expect(outcome.errors[0]).toMatch(/bwrap/);
    }
    expect(deps.accounting.records()).toHaveLength(0);
  });
});

describe('classifyFailure', () => {
  const raw = (text: string, over: Partial<RawStepResult> = {}): RawStepResult => {
    const parsed = parseStreamJson(text);
    return { parsed, summary: summarizeStream(parsed), stderr: '', exitCode: 0, killedBy: null, sandboxDisabled: false, durationMs: 1, turns: 0, ...over };
  };

  it('maps a 429 error to quota and a 401 error to auth', () => {
    expect(classifyFailure(raw('{"type":"result","subtype":"error","is_error":true,"api_error_status":429,"result":"x"}'))).toBe('quota');
    expect(classifyFailure(raw('{"type":"result","subtype":"error","is_error":true,"api_error_status":401,"result":"x"}'))).toBe('auth');
  });

  it('falls back to a rejected rate limit reading or text only when the status is unknown', () => {
    const rejected = [
      '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","unifiedWindows":{"five_hour":{"utilization":1,"resetsAt":1}}}}',
      '{"type":"result","subtype":"error","is_error":true,"result":"You have hit your usage limit"}',
    ].join('\n');
    expect(classifyFailure(raw(rejected))).toBe('quota');
    expect(classifyFailure(raw('{"type":"result","subtype":"error","is_error":true,"result":"Not logged in. Please run claude login"}'))).toBe('auth');
    expect(classifyFailure(raw('{"type":"result","subtype":"error","is_error":true,"api_error_status":500,"result":"rate limit mentioned in passing"}'))).toBe('code');
  });

  it('never classifies a successful result as quota or auth', () => {
    const text = [
      '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected"}}',
      '{"type":"result","subtype":"success","is_error":false,"result":"{}"}',
    ].join('\n');
    expect(classifyFailure(raw(text))).toBeNull();
  });

  it('maps a missing result to code, a kill to timeout and a stop to aborted', () => {
    expect(classifyFailure(raw('{"type":"system","subtype":"init"}'))).toBe('code');
    expect(classifyFailure(raw('{"type":"system","subtype":"init"}', { killedBy: 'turns' }))).toBe('timeout');
    expect(classifyFailure(raw('{"type":"system","subtype":"init"}', { killedBy: 'aborted' }))).toBe('aborted');
    expect(classifyFailure(raw('{"type":"system","subtype":"init"}', { killedBy: 'environment', sandboxDisabled: true }))).toBe('environment');
  });
});

describe('jsonFromResultText', () => {
  it('takes a JSON object from a fenced block or a bare object, nothing else', async () => {
    const { jsonFromResultText } = await import('../../server/runner/step.js');
    expect(jsonFromResultText('Done.\n```json\n{"a":1}\n```\nbye')).toEqual({ a: 1 });
    expect(jsonFromResultText('{"a":1}')).toEqual({ a: 1 });
    expect(jsonFromResultText('I edited the file directly.')).toBeNull();
    expect(jsonFromResultText('```json\n[1,2]\n```')).toBeNull();
    expect(jsonFromResultText('```json\n{broken\n```')).toBeNull();
    expect(jsonFromResultText(null)).toBeNull();
    expect(jsonFromResultText('{"a":1}\n\nPronto.')).toEqual({ a: 1 });
    expect(jsonFromResultText('Segue o resultado: {"a":1} fim')).toEqual({ a: 1 });
    expect(jsonFromResultText('{"a":1}\n```')).toEqual({ a: 1 });
    expect(jsonFromResultText('{"a":1} e {"b":2}')).toBeNull();
  });

  it('names the JSON.parse error of an answer that holds a broken object', async () => {
    const { jsonParseError } = await import('../../server/runner/step.js');
    expect(jsonParseError('Pronto: {"a":1}')).toBeNull();
    expect(jsonParseError('{"a":"linha\nquebrada"}')).toMatch(/JSON/);
    expect(jsonParseError('I edited the file directly.')).toMatch(/JSON/);
  });
});
