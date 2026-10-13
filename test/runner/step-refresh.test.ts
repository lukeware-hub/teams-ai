import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseAgentFile } from '../../server/agents/registry.js';
import { Accounting } from '../../server/budget/accounting.js';
import { buildInvocation } from '../../server/runner/invocation.js';
import { createStepHome } from '../../server/runner/step-home.js';
import { runStep, type StepDeps, type StepRequest } from '../../server/runner/step.js';

const HASH = `sha256:${'a'.repeat(64)}`;
const devAgent = parseAgentFile(`---\nname: dev\ndescription: d\nmodel: opus\ntools: Read\n---\nEcho specHash.`, 'dev');
const NOW = new Date('2026-09-24T10:00:00.000Z');
const cred = (expiresAt: number, refreshToken: string) => JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken, expiresAt } });

// Fake claude: logs the expiry it started with, refreshes an expired token inside its HOME (like the real CLI), takes a while.
const SCRIPT = `
import fs from 'node:fs';
import path from 'node:path';
const file = path.join(process.env.HOME, '.claude', '.credentials.json');
const o = JSON.parse(fs.readFileSync(file, 'utf8')).claudeAiOauth;
const now = Number(process.env.FAKE_NOW);
const expired = o.expiresAt - now < 300000;
fs.appendFileSync(process.env.FAKE_LOG, (expired ? 'refresh' : 'fresh') + '\\n');
if (expired) {
  fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'b', refreshToken: 'r2', expiresAt: now + 3600000 } }));
}
if (process.env.FAKE_TRACE) fs.appendFileSync(process.env.FAKE_TRACE, 'start\\n');
await new Promise((r) => setTimeout(r, 300));
if (process.env.FAKE_TRACE) fs.appendFileSync(process.env.FAKE_TRACE, 'end\\n');
const value = { specHash: '${HASH}', status: 'done', summary: 's', commitMessage: 'feat: x', changedFiles: ['a'] };
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'm' }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, num_turns: 1, result: JSON.stringify(value), structured_output: value, session_id: 's' }));
`;

let dir: string;
let host: string;
let log: string;
let deps: StepDeps;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-refresh-'));
  host = path.join(dir, 'host');
  log = path.join(dir, 'log.txt');
  await fs.mkdir(path.join(host, '.claude'), { recursive: true });
  const script = path.join(dir, 'fake.mjs');
  await fs.writeFile(script, SCRIPT);
  deps = {
    binary: { bin: process.execPath, prefixArgs: [script], env: { FAKE_LOG: log, FAKE_NOW: String(NOW.getTime()) }, requireSandboxTools: false },
    caps: { timeoutMs: 10_000, maxTurns: 50, killGraceMs: 200 },
    accounting: new Accounting(),
    settingsDir: path.join(dir, 'settings'),
    workspacesRoot: dir,
    network: { allowedDomains: [] },
    hostEnv: { HOME: host, PATH: process.env.PATH ?? '' },
    clock: () => NOW,
  };
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const request = (over: Partial<StepRequest> = {}): StepRequest => ({
  kind: 'dev', role: 'dev', agent: devAgent, profile: { model: 'opus' }, model: 'opus', cwd: dir, prompt: 'go',
  expectedSpecHash: HASH, phase: 'tasks', taskId: 'T1', attempt: 1, ...over,
});

describe('refresh gate (plan 38)', () => {
  it('two concurrent steps on an expired token never both refresh', async () => {
    await fs.writeFile(path.join(host, '.claude', '.credentials.json'), cred(NOW.getTime() - 1000, 'r1'));
    const [a, b] = await Promise.all([runStep(request({ taskId: 'A' }), deps), runStep(request({ taskId: 'B' }), deps)]);
    expect(a.ok && b.ok).toBe(true);
    const lines = (await fs.readFile(log, 'utf8')).trim().split('\n').sort();
    expect(lines).toEqual(['fresh', 'refresh']);
    expect(JSON.parse(await fs.readFile(path.join(host, '.claude', '.credentials.json'), 'utf8')).claudeAiOauth.refreshToken).toBe('r2');
  });

  it('a fresh token takes no lock: both steps start together', async () => {
    await fs.writeFile(path.join(host, '.claude', '.credentials.json'), cred(NOW.getTime() + 3_600_000, 'r1'));
    await Promise.all([runStep(request({ taskId: 'A' }), deps), runStep(request({ taskId: 'B' }), deps)]);
    expect((await fs.readFile(log, 'utf8')).trim().split('\n')).toEqual(['fresh', 'fresh']);
  });

  it('runs steps one at a time when the token expires before a step could time out', async () => {
    await fs.writeFile(path.join(host, '.claude', '.credentials.json'), cred(NOW.getTime() + 10 * 60_000, 'r1'));
    const trace = path.join(dir, 'trace.txt');
    deps.binary = { ...deps.binary, env: { ...deps.binary.env, FAKE_TRACE: trace } };
    deps.caps = { ...deps.caps, timeoutMs: 20 * 60_000 };
    await Promise.all([runStep(request({ taskId: 'A' }), deps), runStep(request({ taskId: 'B' }), deps)]);
    expect((await fs.readFile(trace, 'utf8')).trim().split('\n')).toEqual(['start', 'end', 'start', 'end']);
  });
});

describe('createStepHome', () => {
  it('works where the platform has no user ids (Windows)', async () => {
    const getuid = process.getuid;
    (process as { getuid?: unknown }).getuid = undefined;
    try {
      const home = await createStepHome(path.join(dir, 'homes'), { HOME: host });
      expect((await fs.stat(path.join(home, 'tmp'))).isDirectory()).toBe(true);
    } finally {
      process.getuid = getuid;
    }
  });
});

describe('CLAUDE_CODE_OAUTH_TOKEN passthrough (plan 38)', () => {
  it('does not copy the credential file and hands the token to the claude child', async () => {
    await fs.writeFile(path.join(host, '.claude', '.credentials.json'), cred(NOW.getTime() + 1, 'r1'));
    const env = { HOME: host, PATH: 'p', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x' };
    const home = await createStepHome(path.join(dir, 'homes'), env);
    await expect(fs.access(path.join(home, '.claude', '.credentials.json'))).rejects.toThrow();
    const inv = buildInvocation({ role: 'dev', model: 'opus', profile: { model: 'opus' }, cwd: dir, prompt: 'p', jsonSchema: {}, tools: ['Read'], disallowedTools: [], settingsPath: 's', home }, env);
    expect(inv.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-x');
  });

});

describe('ANTHROPIC_API_KEY (claude.auth api-key, R11.13 slice 12)', () => {
  it('copies no credential file and hands the key to the claude child', async () => {
    await fs.writeFile(path.join(host, '.claude', '.credentials.json'), cred(NOW.getTime() + 1, 'r1'));
    const env = { HOME: host, PATH: 'p', ANTHROPIC_API_KEY: 'sk-ant-api03-x' };
    const home = await createStepHome(path.join(dir, 'homes'), env);
    await expect(fs.access(path.join(home, '.claude', '.credentials.json'))).rejects.toThrow();
    const inv = buildInvocation({ role: 'dev', model: 'opus', profile: { model: 'opus' }, cwd: dir, prompt: 'p', jsonSchema: {}, tools: ['Read'], disallowedTools: [], settingsPath: 's', home, apiKey: 'sk-ant-api03-x' }, env);
    expect(inv.env.ANTHROPIC_API_KEY).toBe('sk-ant-api03-x');
  });

  it('never passes a key from the host env through the allowlist', () => {
    const inv = buildInvocation({ role: 'dev', model: 'opus', profile: { model: 'opus' }, cwd: dir, prompt: 'p', jsonSchema: {}, tools: ['Read'], disallowedTools: [], settingsPath: 's' }, { HOME: host, PATH: 'p', ANTHROPIC_API_KEY: 'sk-from-the-host' });
    expect(inv.env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
