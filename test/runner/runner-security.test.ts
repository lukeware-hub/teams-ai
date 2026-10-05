import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NESTED_DENIED, parseAgentFile } from '../../server/agents/registry.js';
import { Accounting } from '../../server/budget/accounting.js';
import { ROLES } from '../../server/config/config.js';
import { ISOLATION_FLAGS } from '../../server/runner/invocation.js';
import { UNSAFE_NO_SANDBOX_ENV, sandboxPolicyViolation } from '../../server/runner/sandbox-policy.js';
import { buildRoleSettings } from '../../server/runner/role-settings.js';
import { runStep, type StepDeps, type StepRequest } from '../../server/runner/step.js';

const FAKE = path.resolve('test/fixtures/fake-claude/fake-claude.mjs');
const fixture = path.resolve('test/fixtures/stream/success.ndjson');
const HASH = `sha256:${'a'.repeat(64)}`;
const devAgent = parseAgentFile(`---\nname: dev\ndescription: d\nmodel: opus\ntools: Read, Edit, Bash\n---\nEcho specHash.`, 'dev');

describe('C1 sandbox policy', () => {
  it('allows an enabled or unspecified sandbox', () => {
    expect(sandboxPolicyViolation(undefined, {})).toBeNull();
    expect(sandboxPolicyViolation({ enabled: true }, {})).toBeNull();
  });
  it('refuses enabled=false without both opt-ins', () => {
    expect(sandboxPolicyViolation({ enabled: false }, {})).toMatch(/refused/);
    expect(sandboxPolicyViolation({ enabled: false, unsafeNoSandbox: true }, {})).toMatch(/refused/);
    expect(sandboxPolicyViolation({ enabled: false }, { [UNSAFE_NO_SANDBOX_ENV]: '1' })).toMatch(/refused/);
    expect(sandboxPolicyViolation({ enabled: false, unsafeNoSandbox: true }, { [UNSAFE_NO_SANDBOX_ENV]: 'true' })).toMatch(/refused/);
  });
  it('allows enabled=false only with the config flag and the env opt-in', () => {
    expect(sandboxPolicyViolation({ enabled: false, unsafeNoSandbox: true }, { [UNSAFE_NO_SANDBOX_ENV]: '1' })).toBeNull();
  });
  it('ships config.example.json with the sandbox on', async () => {
    const cfg = JSON.parse(await fs.readFile('config.example.json', 'utf8'));
    expect(cfg.sandbox.enabled).toBe(true);
  });
});

describe('H3 / M2 role settings', () => {
  it('no role may run find, and every role denies nested interpreter invocations and .claude writes', () => {
    for (const role of ROLES) {
      const { allow, deny } = buildRoleSettings(role, { allowedDomains: [] }).permissions;
      expect(allow, role).not.toContain('Bash(find:*)');
      for (const d of NESTED_DENIED) expect(deny, role).toContain(d);
    }
    expect(NESTED_DENIED).toEqual(expect.arrayContaining(['Bash(node -e:*)', 'Bash(npm exec:*)', 'Bash(* git push*)', 'Bash(*.claude/*)']));
  });
  it('does not load worktree project settings', () => {
    const i = ISOLATION_FLAGS.indexOf('--setting-sources');
    expect(ISOLATION_FLAGS[i + 1]).toBe('user');
  });
});

describe('C1 per-step HOME', () => {
  let dir: string;
  let hostHome: string;
  let deps: StepDeps;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-sec-'));
    hostHome = path.join(dir, 'host');
    await fs.mkdir(path.join(hostHome, '.claude'), { recursive: true });
    await fs.mkdir(path.join(hostHome, '.teams-ai', 'secrets'), { recursive: true });
    await fs.writeFile(path.join(hostHome, '.claude', '.credentials.json'), '{"oauth":"x"}');
    await fs.writeFile(path.join(hostHome, '.teams-ai', 'secrets', 'GITHUB_TOKEN'), 'ghp_secret');
    deps = {
      binary: { bin: process.execPath, prefixArgs: [FAKE], env: { FAKE_CLAUDE_FIXTURE: fixture }, requireSandboxTools: false },
      caps: { timeoutMs: 5_000, maxTurns: 50, killGraceMs: 200 },
      accounting: new Accounting(),
      settingsDir: path.join(dir, 'settings'),
      workspacesRoot: dir,
      network: { allowedDomains: [] },
      hostEnv: { HOME: hostHome, PATH: process.env.PATH ?? '' },
    };
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const request = (over: Partial<StepRequest> = {}): StepRequest => ({
    kind: 'dev', role: 'dev', agent: devAgent, profile: { model: 'opus' }, model: 'opus',
    cwd: dir, prompt: 'go', expectedSpecHash: HASH, phase: 'tasks', taskId: 'T1', attempt: 1, ...over,
  });

  it('refuses to run when the sandbox is disabled without opt-in', async () => {
    const out = await runStep(request(), { ...deps, sandbox: { enabled: false } });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.failure).toBe('environment');
      expect(out.errors[0]).toMatch(/sandbox\.enabled=false is refused/);
    }
  });

  it('runs the agent with an empty HOME outside the worktree holding only the login, then removes it', async () => {
    // The fake cannot list HOME while running, so a copy of the HOME listing is taken through a wrapper script.
    const probe = path.join(dir, 'probe.mjs');
    await fs.writeFile(
      probe,
      `import {readdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
const walk=(d,p='')=>readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(d,e.name),p+e.name+'/'):[p+e.name]);
writeFileSync(process.env.PROBE_OUT,JSON.stringify({home:process.env.HOME,files:walk(process.env.HOME)}));
await import(${JSON.stringify(FAKE.replace(/\\/g, '/'))});`,
    );
    deps.binary = { ...deps.binary, prefixArgs: [probe], env: { ...deps.binary.env, PROBE_OUT: path.join(dir, 'probe.json') } };
    await runStep(request(), deps);
    const probed = JSON.parse(await fs.readFile(path.join(dir, 'probe.json'), 'utf8'));
    expect(probed.home).not.toBe(hostHome);
    expect(path.relative(dir, probed.home).startsWith('settings')).toBe(true);
    expect(probed.files.filter((f: string) => !f.startsWith('tmp/')).sort()).toEqual(['.claude.json', '.claude/.credentials.json']);
    expect(probed.files.join()).not.toMatch(/secrets|GITHUB_TOKEN/);
    await expect(fs.access(probed.home)).rejects.toThrow();
  });

});
