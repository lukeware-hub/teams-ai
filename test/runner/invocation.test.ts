import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ENV_ALLOWLIST,
  ISOLATION_FLAGS,
  InvocationError,
  buildInvocation,
  ensureTrusted,
  sanitizeEnv,
  type InvocationInput,
} from '../../server/runner/invocation.js';

const base: InvocationInput = {
  role: 'dev',
  model: 'opus',
  profile: { provider: 'claude', model: 'opus' },
  cwd: '/home/u/ws/worktrees/T1-create',
  prompt: 'Implement T1',
  jsonSchema: { type: 'object', properties: { specHash: { type: 'string' } }, required: ['specHash'] },
  tools: ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'],
  disallowedTools: ['Bash(gh:*)', 'Bash(git push:*)', 'Bash(docker:*)', 'Bash(kubectl:*)'],
};

const hostEnv = {
  HOME: '/home/u',
  PATH: '/usr/bin',
  TERM: 'xterm',
  GITHUB_TOKEN: 'ghp_secret',
  ANTHROPIC_API_KEY: 'sk-ant-secret',
  AWS_SECRET_ACCESS_KEY: 'aws',
  KUBECONFIG: '/home/u/.kube/config',
  LANG: 'C.UTF-8',
};

describe('buildInvocation', () => {
  it('starts with the agent, the prompt and every isolation flag from the findings', () => {
    const inv = buildInvocation(base, hostEnv);
    expect(inv.args.slice(0, 4)).toEqual(['-p', 'Implement T1', '--agent', 'dev']);
    for (const flag of ISOLATION_FLAGS) expect(inv.args).toContain(flag);
    expect(inv.args).toContain('--strict-mcp-config');
    expect(inv.args[inv.args.indexOf('--mcp-config') + 1]).toBe('{"mcpServers":{}}');
    expect(inv.args[inv.args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(inv.args).not.toContain('--max-turns');
  });

  it('passes the schema, tools, disallowed tools and model', () => {
    const inv = buildInvocation(base, hostEnv);
    expect(JSON.parse(inv.args[inv.args.indexOf('--json-schema') + 1]!)).toEqual(base.jsonSchema);
    expect(inv.args[inv.args.indexOf('--tools') + 1]).toBe('Read,Edit,Write,Grep,Glob,Bash');
    expect(inv.args[inv.args.indexOf('--model') + 1]).toBe('opus');
    const i = inv.args.indexOf('--disallowed-tools');
    expect(inv.args.slice(i + 1, i + 5)).toEqual(base.disallowedTools);
  });

  it('omits --tools when the list is empty and passes "" explicitly', () => {
    const inv = buildInvocation({ ...base, tools: [] }, hostEnv);
    expect(inv.args[inv.args.indexOf('--tools') + 1]).toBe('');
  });

  it('adds --session-id for a new refinement session and --resume for a continued one', () => {
    const fresh = buildInvocation({ ...base, sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, hostEnv);
    expect(fresh.args).toContain('--session-id');
    expect(fresh.args).not.toContain('--no-session-persistence');
    const resumed = buildInvocation({ ...base, sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', resume: true }, hostEnv);
    expect(resumed.args[resumed.args.indexOf('--resume') + 1]).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(buildInvocation(base, hostEnv).args).toContain('--no-session-persistence');
  });

  it('strips every secret from the environment', () => {
    const inv = buildInvocation(base, hostEnv);
    expect(Object.keys(inv.env).sort()).toEqual(['HOME', 'LANG', 'PATH', 'TERM']);
    expect(inv.env).not.toHaveProperty('GITHUB_TOKEN');
    expect(inv.env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('adds the OmniRoute variables only for an omniroute profile', () => {
    const inv = buildInvocation(
      {
        ...base,
        profile: { provider: 'omniroute', model: 'kimi/k2' },
        model: 'kimi/k2',
        omniroute: { baseUrl: 'http://localhost:20128', token: 'oma_live_x', compactWindow: 200000 },
      },
      hostEnv,
    );
    expect(inv.env.ANTHROPIC_BASE_URL).toBe('http://localhost:20128');
    expect(inv.env.ANTHROPIC_AUTH_TOKEN).toBe('oma_live_x');
    expect(inv.env.ANTHROPIC_MODEL).toBe('kimi/k2');
    expect(inv.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('200000');
    expect(buildInvocation(base, hostEnv).env).not.toHaveProperty('ANTHROPIC_BASE_URL');
  });

  it('refuses an omniroute profile without connection details', () => {
    expect(() => buildInvocation({ ...base, profile: { provider: 'omniroute', model: 'x' } }, hostEnv)).toThrow(InvocationError);
  });

  it('refuses a prompt that is empty', () => {
    expect(() => buildInvocation({ ...base, prompt: '  ' }, hostEnv)).toThrow(InvocationError);
  });
});

describe('sanitizeEnv', () => {
  it('keeps only allowlisted keys with string values', () => {
    expect(ENV_ALLOWLIST).toContain('HOME');
    expect(sanitizeEnv({ HOME: '/h', FOO: 'x', PATH: undefined })).toEqual({ HOME: '/h' });
  });
});

describe('ensureTrusted', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-trust-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('creates the file and the project entry when missing', async () => {
    const file = path.join(dir, '.claude.json');
    await ensureTrusted('/home/u/ws/wt', file);
    const json = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(json.projects['/home/u/ws/wt'].hasTrustDialogAccepted).toBe(true);
  });

  it('preserves other keys and existing project settings', async () => {
    const file = path.join(dir, '.claude.json');
    await fs.writeFile(file, JSON.stringify({ theme: 'dark', projects: { '/other': { allowedTools: ['Read'] }, '/home/u/ws/wt': { allowedTools: ['Bash'] } } }));
    await ensureTrusted('/home/u/ws/wt', file);
    const json = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(json.theme).toBe('dark');
    expect(json.projects['/other']).toEqual({ allowedTools: ['Read'] });
    expect(json.projects['/home/u/ws/wt']).toEqual({ allowedTools: ['Bash'], hasTrustDialogAccepted: true });
  });
});
