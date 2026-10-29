import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUESTION_RULES } from '../../server/agents/registry.js';
import {
  ENV_ALLOWLIST,
  ISOLATION_FLAGS,
  STEP_ENV,
  InvocationError,
  buildInvocation,
  ensureTrusted,
  PROMPT_CACHE_TTL,
  removeTrusted,
  sanitizeEnv,
  type InvocationInput,
} from '../../server/runner/invocation.js';

const base: InvocationInput = {
  role: 'dev',
  model: 'opus',
  profile: { model: 'opus' },
  cwd: '/home/u/ws/worktrees/T1-create',
  prompt: 'Implement T1',
  jsonSchema: { type: 'object', properties: { specHash: { type: 'string' } }, required: ['specHash'] },
  tools: ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'],
  disallowedTools: ['Bash(gh:*)', 'Bash(git push:*)', 'Bash(docker:*)', 'Bash(kubectl:*)'],
  settingsPath: '/home/u/.teams-ai/settings/dev.settings.json',
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
  it('selects the agent, passes the role settings file and every isolation flag; the prompt goes to stdin', () => {
    const inv = buildInvocation(base, hostEnv);
    expect(inv.args.slice(0, 3)).toEqual(['-p', '--agent', 'dev']);
    expect(inv.args).not.toContain('Implement T1');
    expect(inv.stdin).toBe(`${QUESTION_RULES}\n\nImplement T1`);
    for (const flag of ISOLATION_FLAGS) expect(inv.args).toContain(flag);
    expect(inv.args[inv.args.indexOf('--settings') + 1]).toBe(base.settingsPath);
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

  it('loads each plugin folder with --plugin-dir and nothing else from the host', () => {
    const inv = buildInvocation({ ...base, pluginDirs: ['/opt/teams-ai/agent-plugins/dev'] }, hostEnv);
    const at = inv.args.indexOf('--plugin-dir');
    expect(at).toBeGreaterThan(-1);
    expect(inv.args[at + 1]).toBe('/opt/teams-ai/agent-plugins/dev');
    expect(inv.args).not.toContain('--add-dir');
  });

  it('passes "" for an empty tool list', () => {
    expect(buildInvocation({ ...base, tools: [] }, hostEnv).args[buildInvocation({ ...base, tools: [] }, hostEnv).args.indexOf('--tools') + 1]).toBe('');
  });

  it('adds --session-id for a new refinement session and --resume for a continued one', () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const fresh = buildInvocation({ ...base, sessionId: id }, hostEnv);
    expect(fresh.args).toContain('--session-id');
    expect(fresh.args).not.toContain('--no-session-persistence');
    const resumed = buildInvocation({ ...base, sessionId: id, resume: true }, hostEnv);
    expect(resumed.args[resumed.args.indexOf('--resume') + 1]).toBe(id);
    expect(buildInvocation(base, hostEnv).args).toContain('--no-session-persistence');
  });

  it('strips every secret from the environment', () => {
    const inv = buildInvocation(base, hostEnv);
    expect(Object.keys(inv.env).sort()).toEqual(['HOME', 'LANG', 'PATH', 'TERM', ...Object.keys(STEP_ENV)].sort());
    expect(inv.env).not.toHaveProperty('GITHUB_TOKEN');
    expect(inv.env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('adds explicit extraEnv entries even though they are not host env or on the allowlist', () => {
    // An ephemeral test database the orchestrator provisions (never a host secret): the step needs its
    // own DATABASE_URL, which sanitizeEnv would otherwise strip since it is not in ENV_ALLOWLIST.
    const inv = buildInvocation({ ...base, extraEnv: { DATABASE_URL: 'postgres://u:p@dind:55432/t' } }, hostEnv);
    expect(inv.env.DATABASE_URL).toBe('postgres://u:p@dind:55432/t');
    expect(inv.env.HOME).toBe('/home/u'); // allowlisted host env still comes through
  });

  it('refuses an empty prompt or a missing settings path', () => {
    expect(() => buildInvocation({ ...base, prompt: '  ' }, hostEnv)).toThrow(InvocationError);
    expect(() => buildInvocation({ ...base, settingsPath: '' }, hostEnv)).toThrow(/settings/);
  });

  it('passes the agent definition as a file with --agents, with the step model, not the file model', () => {
    const agentsPath = '/home/u/.teams-ai/runs/r1/settings/home-1/dev.agents.json';
    const inv = buildInvocation(
      { ...base, model: 'sonnet', agentsPath, agentDefinition: { description: 'Developer.', model: 'opus', tools: ['Read', 'Edit'], body: 'Echo the specHash.' } },
      hostEnv,
    );
    expect(inv.args[inv.args.indexOf('--agents') + 1]).toBe(agentsPath);
    expect(inv.args.indexOf('--agents')).toBeGreaterThan(inv.args.indexOf('--agent'));
    expect(inv.agentsFile?.path).toBe(agentsPath);
    expect(JSON.parse(inv.agentsFile!.content)).toEqual({ dev: { description: 'Developer.', prompt: 'Echo the specHash.', tools: ['Read', 'Edit'], model: 'sonnet' } });
  });

  it('keeps the agent body out of the command line, whatever its size', () => {
    const body = 'Rule. '.repeat(20000);
    const inv = buildInvocation({ ...base, agentsPath: '/home/u/x/dev.agents.json', agentDefinition: { description: 'Developer.', model: 'opus', tools: ['Read'], body } }, hostEnv);
    expect(inv.args.join(' ')).not.toContain('Rule.');
    expect(inv.args.join(' ').length).toBeLessThan(2000);
    expect(JSON.parse(inv.agentsFile!.content).dev.prompt).toBe(body);
  });

  it('refuses a definition that has no file to be written to', () => {
    const agentDefinition = { description: 'Developer.', model: 'opus', tools: ['Read'], body: 'Echo.' };
    expect(() => buildInvocation({ ...base, agentDefinition }, hostEnv)).toThrow(InvocationError);
  });

  it("points a step's go command at the platform's module proxy when the platform runs one", () => {
    const step = { ...base, home: '/home/u/.teams-ai/runs/r1/home' };
    expect(buildInvocation(step, { ...hostEnv, TEAMS_AI_GO_PROXY: 'http://goproxy:8080' }).env.GOPROXY).toBe('http://goproxy:8080');
    expect(buildInvocation(step, hostEnv).env).not.toHaveProperty('GOPROXY');
  });

  it('sets the fixed step environment on top of the allowlisted host variables', () => {
    const env = buildInvocation(base, hostEnv).env;
    expect(env).toMatchObject({ CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1', CLAUDE_CODE_DISABLE_ATTACHMENTS: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_MAX_RETRIES: '5' });
    expect(env.PATH).toBe('/usr/bin');
  });

  it('never lets extraEnv override HOME, PATH, the fixed step env or a credential', () => {
    const extraEnv = { HOME: '/evil', PATH: '/evil', TMPDIR: '/evil', CLAUDE_CODE_MAX_RETRIES: '300', CLAUDE_CODE_OAUTH_TOKEN: 'evil', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h', DATABASE_URL: 'postgres://t' };
    const env = buildInvocation({ ...base, home: '/tmp/th/home-1', cacheTtl: '5m', extraEnv }, { ...hostEnv, CLAUDE_CODE_OAUTH_TOKEN: 'host-token' }).env;
    expect(env).toMatchObject({ HOME: '/tmp/th/home-1', PATH: '/usr/bin', TMPDIR: '/tmp/th/home-1/tmp', CLAUDE_CODE_MAX_RETRIES: '5', CLAUDE_CODE_OAUTH_TOKEN: 'host-token', CLAUDE_CODE_PROMPT_CACHE_TTL: '5m', DATABASE_URL: 'postgres://t' });
  });

  it('sets the prompt cache TTL only when asked', () => {
    expect(buildInvocation(base, hostEnv).env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBeUndefined();
    expect(buildInvocation({ ...base, cacheTtl: '5m' }, hostEnv).env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('5m');
    expect(PROMPT_CACHE_TTL).toBe('5m');
  });

  it('omits --agents when no definition is given', () => {
    expect(buildInvocation(base, hostEnv).args).not.toContain('--agents');
  });

  it('passes --effort only when set', () => {
    expect(buildInvocation(base, hostEnv).args).not.toContain('--effort');
    const args = buildInvocation({ ...base, effort: 'high' }, hostEnv).args;
    expect(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2)).toEqual(['--effort', 'high']);
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
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('creates the file and the project entry keyed by the resolved path', async () => {
    const file = path.join(dir, '.claude.json');
    const wt = path.join(dir, 'wt');
    await fs.mkdir(wt);
    await ensureTrusted(`${wt}${path.sep}`, file);
    const json = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(json.projects[await fs.realpath(wt)].hasTrustDialogAccepted).toBe(true);
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

  it('removeTrusted drops only the trust flag and deletes an entry left empty', async () => {
    const file = path.join(dir, '.claude.json');
    const wt = path.join(dir, 'wt');
    await fs.mkdir(wt);
    await ensureTrusted(wt, file);
    await ensureTrusted('/home/u/ws/other', file);
    const current = JSON.parse(await fs.readFile(file, 'utf8'));
    current.projects['/keep'] = { allowedTools: ['Read'], hasTrustDialogAccepted: true };
    await fs.writeFile(file, JSON.stringify(current));
    await removeTrusted(`${wt}${path.sep}`, file);
    await removeTrusted('/keep', file);
    await removeTrusted('/never-there', file);
    const json = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(json.projects[await fs.realpath(wt)]).toBeUndefined();
    expect(json.projects['/home/u/ws/other'].hasTrustDialogAccepted).toBe(true);
    expect(json.projects['/keep']).toEqual({ allowedTools: ['Read'] });
    await expect(removeTrusted('/x', path.join(dir, 'missing.json'))).resolves.toBeUndefined();
  });

  it('does not lose entries when called concurrently', async () => {
    const file = path.join(dir, '.claude.json');
    await Promise.all(Array.from({ length: 10 }, (_, i) => ensureTrusted(`/home/u/ws/wt${i}`, file)));
    const json = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(Object.keys(json.projects)).toHaveLength(10);
    expect(await fs.readdir(dir)).toEqual(['.claude.json']);
  });

  it('survives many concurrent ensureTrusted and removeTrusted calls: none rejects, valid JSON, no tmp file is left', async () => {
    const file = path.join(dir, '.claude.json');
    const stale = Array.from({ length: 25 }, (_, i) => `/home/u/ws/stale${i}`);
    await fs.writeFile(file, JSON.stringify({ projects: Object.fromEntries(stale.map((d) => [d, { hasTrustDialogAccepted: true }])) }));
    const fresh = Array.from({ length: 50 }, (_, i) => `/home/u/ws/wt${i}`);
    const results = await Promise.allSettled([...fresh.map((d) => ensureTrusted(d, file)), ...stale.map((d) => removeTrusted(d, file))]);
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    const json = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(Object.keys(json.projects).sort()).toEqual([...fresh].sort());
    expect(await fs.readdir(dir)).toEqual(['.claude.json']);
  });

  it('does not make a hung write to one file hold up the writes to other files', async () => {
    const stuck = path.join(dir, 'stuck.json');
    const free = path.join(dir, 'free.json');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === stuck) await gate;
      return rename(from, to);
    });
    const hung = ensureTrusted('/home/u/ws/a', stuck);
    try {
      const outcome = await Promise.race([
        ensureTrusted('/home/u/ws/b', free).then(() => 'done'),
        new Promise<string>((resolve) => setTimeout(resolve, 2000, 'blocked')),
      ]);
      expect(outcome).toBe('done');
    } finally {
      release();
      await hung;
    }
  });

  it('keeps a write that another process lands between its read and its rename', async () => {
    const file = path.join(dir, '.claude.json');
    await fs.writeFile(file, JSON.stringify({ theme: 'dark', projects: {} }));
    const writeFile = fs.writeFile.bind(fs);
    let injected = false;
    vi.spyOn(fs, 'writeFile').mockImplementation(async (target, data, options) => {
      await writeFile(target, data, options);
      if (!injected && String(target).endsWith('.tmp')) {
        injected = true; // the claude CLI saves ~/.claude.json while ensureTrusted sits between its read and its rename
        await writeFile(file, JSON.stringify({ theme: 'dark', numStartups: 7, projects: {} }));
      }
    });
    await ensureTrusted('/home/u/ws/wt', file);
    const json = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(json.numStartups).toBe(7);
    expect(json.projects['/home/u/ws/wt'].hasTrustDialogAccepted).toBe(true);
    expect(await fs.readdir(dir)).toEqual(['.claude.json']);
  });
});
