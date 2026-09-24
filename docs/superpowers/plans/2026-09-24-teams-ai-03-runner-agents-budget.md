# teams-ai Plan 3 — Runner, Agents and Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the orchestrator a tested way to run one agent step: build an isolated `claude -p` invocation for a role, spawn it with turn/time caps, parse and validate its structured output, account for its tokens, and decide whether the run may proceed under the subscription quota.

**Architecture:** The runner is the only unit that knows a `claude` binary exists (spec §3.2). It is split into pure pieces — invocation builder, agent registry, output contracts, budget accounting, concurrency governor, quota breaker — and one impure piece, the process runner, which is tested against a fake `claude` binary that replays the real recordings captured in Plan 2. `runStep` composes them into a single `StepOutcome` that Plan 6 maps onto the retry policy.

**Tech Stack:** Node 22 (ESM), TypeScript 5.9.3, Vitest 5, zod 4 (`z.toJSONSchema`), Node `child_process`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-23-teams-ai-poc-design.md` — §3.2, §3.3, §3.4, §8, §9A, §10, §12, §14. **Findings:** `docs/superpowers/spikes/2026-09-23-cli-findings.md` (every decision column is binding here).

## Global Constraints

- Everything from Plan 1's Global Constraints (pins, ESM, `.js` import suffix, English, commit trailer).
- No real `claude` call inside `npm test`; the fake binary replays fixtures. Real calls only in Task 7 (manual, WSL).
- The prompt is written to the child's stdin (a context pack may start with `-` or `---`); the role settings file is passed with `--settings`; the agent definition is passed inline with `--agents` because `.claude/agents` resolves from the cwd (the product worktree).
- Invocation flags are exactly the findings' decisions: `--output-format stream-json --verbose --setting-sources project --strict-mcp-config --mcp-config '{"mcpServers":{}}' --exclude-dynamic-system-prompt-sections --no-session-persistence --permission-mode dontAsk`, plus `--json-schema`, `--tools`, `--disallowed-tools`, `--model`, `--agent`. There is no `--max-turns` in CLI 2.1.281; the runner caps turns itself.
- Agent environment is an allowlist. `GITHUB_TOKEN`, `GH_TOKEN`, `ANTHROPIC_API_KEY`, `AWS_*`, `KUBECONFIG`, `DOCKER_*` never reach an agent (spec §14).
- `is_error` is authoritative over `subtype` (findings row 4).
- Commit messages end with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  ```

## Review Focus

1. **`claude` prints "Sandbox disabled" and keeps going** — the step must fail as `environment` before any agent work, never run unsandboxed (test in Task 4).
2. **Process emits no `result` line** (killed by the turn cap or timeout, or crashed) — outcome must be a classified failure with the partial usage, not a hang or an unhandled rejection (tests in Task 4).
3. **`rate_limit_event` says a window is at 0.97 while the step itself succeeded** — the breaker must pause *before the next step*, and resume at `resetsAt`, not on a guess (tests in Task 6).
4. **A role's agent file lists a tool the role policy forbids** (e.g. `Bash(gh:*)` for devops) — registry must reject the file at load, not at runtime (test in Task 2).
5. **Structured output present but `is_error: true`** (compaction breaker) — outcome is `compaction`, and the structured output is discarded, never validated as a success (test in Task 5).

---

## File structure

```
.claude/agents/{sm,po,dev,test,devops}.md   role prompts + frontmatter (name, description, model, tools)
server/agents/registry.ts                  loads agent files, parses frontmatter, enforces role tool policy
server/agents/outputs.ts                   zod output contract per step kind + toJsonSchema()
server/runner/invocation.ts                argv/env/cwd builder, trust-entry writer, env allowlist
server/runner/process-runner.ts            spawn + caps + stream capture → RawStepResult
server/runner/step.ts                      runStep(): invocation → process → summary → validate → StepOutcome
server/budget/accounting.ts                usage ledger by role/phase/task/attempt
server/budget/governor.ts                  async semaphore with adaptive limit
server/budget/quota-breaker.ts             proactive pause/resume from RateLimitInfo
test/fixtures/fake-claude/fake-claude.mjs  replays a fixture with delays/hang/stderr, captures argv+env
test/**/*.test.ts
scripts/wsl/omniroute/{up.sh,down.sh}      pinned OmniRoute container for Task 7
```

---

### Task 1: Invocation builder, environment allowlist and trust entry

**Files:**
- Create: `server/runner/invocation.ts`
- Test: `test/runner/invocation.test.ts`

**Interfaces:**
- Consumes: `ProviderProfile`, `Role` (Plan 2 Task 3 `server/config/config.ts`).
- Produces:
  - `ISOLATION_FLAGS: readonly string[]`
  - `interface InvocationInput { role: Role; model: string; profile: ProviderProfile; cwd: string; prompt: string; jsonSchema: object; tools: readonly string[]; disallowedTools: readonly string[]; sessionId?: string; resume?: boolean; omniroute?: { baseUrl: string; token: string; compactWindow?: number } }`
  - `interface Invocation { args: string[]; env: Record<string, string>; cwd: string }`
  - `buildInvocation(input: InvocationInput, hostEnv?: NodeJS.ProcessEnv): Invocation`
  - `ENV_ALLOWLIST: readonly string[]`, `sanitizeEnv(hostEnv: NodeJS.ProcessEnv): Record<string, string>`
  - `ensureTrusted(dir: string, claudeJsonPath: string): Promise<void>` — sets `projects[dir].hasTrustDialogAccepted = true` (findings row 5b)
  - `class InvocationError extends Error`

- [ ] **Step 1: Write the failing test**

`test/runner/invocation.test.ts`:
```ts
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
    expect(inv.stdin).toBe('Implement T1');
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

  it('refuses an omniroute profile without connection details or with an empty token', () => {
    expect(() => buildInvocation({ ...base, profile: { provider: 'omniroute', model: 'x' } }, hostEnv)).toThrow(InvocationError);
    expect(() =>
      buildInvocation({ ...base, profile: { provider: 'omniroute', model: 'x' }, omniroute: { baseUrl: 'http://localhost:20128', token: '  ' } }, hostEnv),
    ).toThrow(/token/);
  });

  it('refuses an empty prompt or a missing settings path', () => {
    expect(() => buildInvocation({ ...base, prompt: '  ' }, hostEnv)).toThrow(InvocationError);
    expect(() => buildInvocation({ ...base, settingsPath: '' }, hostEnv)).toThrow(/settings/);
  });

  it('passes the agent definition inline via --agents with the step model, not the file model', () => {
    const inv = buildInvocation(
      { ...base, model: 'sonnet', agentDefinition: { description: 'Developer.', model: 'opus', tools: ['Read', 'Edit'], body: 'Echo the specHash.' } },
      hostEnv,
    );
    const json = JSON.parse(inv.args[inv.args.indexOf('--agents') + 1]!);
    expect(json).toEqual({ dev: { description: 'Developer.', prompt: 'Echo the specHash.', tools: ['Read', 'Edit'], model: 'sonnet' } });
    expect(inv.args.indexOf('--agents')).toBeGreaterThan(inv.args.indexOf('--agent'));
  });

  it('omits --agents when no definition is given', () => {
    expect(buildInvocation(base, hostEnv).args).not.toContain('--agents');
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

  it('does not lose entries when called concurrently', async () => {
    const file = path.join(dir, '.claude.json');
    await Promise.all(Array.from({ length: 10 }, (_, i) => ensureTrusted(`/home/u/ws/wt${i}`, file)));
    const json = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(Object.keys(json.projects)).toHaveLength(10);
    expect(await fs.readdir(dir)).toEqual(['.claude.json']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/runner/invocation.test.ts`
Expected: FAIL — cannot resolve `../../server/runner/invocation.js`.

- [ ] **Step 3: Write the builder**

`server/runner/invocation.ts`:
```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ProviderProfile, Role } from '../config/config.js';

/** Flags fixed by the CLI spike (docs/superpowers/spikes/2026-09-23-cli-findings.md). */
export const ISOLATION_FLAGS: readonly string[] = [
  '--output-format',
  'stream-json',
  '--verbose',
  '--setting-sources',
  'project',
  '--strict-mcp-config',
  '--mcp-config',
  '{"mcpServers":{}}',
  '--exclude-dynamic-system-prompt-sections',
  '--permission-mode',
  'dontAsk',
];

/**
 * Only these host variables reach an agent process (spec §14). HOME is required for the
 * subscription login; the credential stores under it are covered by Read deny rules in the
 * role settings (see role-settings.ts PROTECTED_READ_PATHS).
 */
export const ENV_ALLOWLIST: readonly string[] = ['HOME', 'PATH', 'TERM', 'LANG', 'LC_ALL', 'USER', 'SHELL', 'TMPDIR', 'TZ'];

export interface InvocationInput {
  role: Role;
  model: string;
  profile: ProviderProfile;
  cwd: string;
  prompt: string;
  jsonSchema: object;
  tools: readonly string[];
  disallowedTools: readonly string[];
  /** Role settings file written by the orchestrator (sandbox + permissions), passed with --settings. */
  settingsPath: string;
  sessionId?: string;
  resume?: boolean;
  omniroute?: { baseUrl: string; token: string; compactWindow?: number };
  /**
   * Inline agent definition (`--agents` JSON). Agents in `.claude/agents` are loaded from the
   * process cwd, which is the product worktree, so the orchestrator ships the role definition itself.
   * The step model wins over the agent file's model.
   */
  agentDefinition?: { description: string; model: string; tools: readonly string[]; body: string };
}

export interface Invocation {
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /** The prompt, written to the child's stdin: a leading `-`/`--` in a context pack must never be parsed as a flag. */
  stdin: string;
}

export class InvocationError extends Error {}

export function sanitizeEnv(hostEnv: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = hostEnv[key];
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

export function buildInvocation(input: InvocationInput, hostEnv: NodeJS.ProcessEnv = process.env): Invocation {
  if (input.prompt.trim() === '') throw new InvocationError('prompt must not be empty');
  if (!input.settingsPath || input.settingsPath.trim() === '') throw new InvocationError('settingsPath is required');
  const args: string[] = ['-p', '--agent', input.role];
  if (input.agentDefinition) {
    const def = input.agentDefinition;
    args.push(
      '--agents',
      JSON.stringify({ [input.role]: { description: def.description, prompt: def.body, tools: [...def.tools], model: input.model } }),
    );
  }
  args.push(...ISOLATION_FLAGS);
  args.push('--settings', input.settingsPath);
  args.push('--model', input.model);
  args.push('--json-schema', JSON.stringify(input.jsonSchema));
  args.push('--tools', input.tools.join(','));
  if (input.disallowedTools.length > 0) args.push('--disallowed-tools', ...input.disallowedTools);
  if (input.sessionId) {
    if (input.resume) args.push('--resume', input.sessionId);
    else args.push('--session-id', input.sessionId);
  } else {
    args.push('--no-session-persistence');
  }

  const env = sanitizeEnv(hostEnv);
  if (input.profile.provider === 'omniroute') {
    if (!input.omniroute) throw new InvocationError('omniroute profile requires baseUrl and token');
    if (input.omniroute.token.trim() === '') {
      throw new InvocationError('omniroute token must not be empty (an empty token could fall back to the subscription login)');
    }
    env.ANTHROPIC_BASE_URL = input.omniroute.baseUrl;
    env.ANTHROPIC_AUTH_TOKEN = input.omniroute.token;
    env.ANTHROPIC_MODEL = input.model;
    if (input.omniroute.compactWindow) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(input.omniroute.compactWindow);
  }
  return { args, env, cwd: input.cwd, stdin: input.prompt };
}

// Writes to ~/.claude.json are serialized in-process and made atomic (temp file + rename), because
// parallel steps trust their worktrees at the same time and the CLI reads the file at startup.
let trustQueue: Promise<unknown> = Promise.resolve();

/**
 * Project-level permissions.allow is ignored until the workspace is trusted
 * (findings row 5b). The orchestrator trusts every worktree it creates, keyed by its resolved path.
 */
export function ensureTrusted(dir: string, claudeJsonPath: string): Promise<void> {
  const work = async () => {
    // Key by the resolved real path when the directory exists (symlinks, trailing slashes);
    // otherwise keep the caller's spelling so a foreign-platform path is not rewritten.
    let key = dir;
    try {
      key = await fs.realpath(dir);
    } catch {
      key = dir;
    }
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(await fs.readFile(claudeJsonPath, 'utf8')) as Record<string, unknown>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const projects = (json.projects ?? {}) as Record<string, Record<string, unknown>>;
    projects[key] = { ...(projects[key] ?? {}), hasTrustDialogAccepted: true };
    json.projects = projects;
    await fs.mkdir(path.dirname(claudeJsonPath), { recursive: true });
    const tmp = `${claudeJsonPath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(json, null, 2)}\n`);
    await fs.rename(tmp, claudeJsonPath);
  };
  const result = trustQueue.then(work, work);
  trustQueue = result.catch(() => undefined);
  return result;
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/runner/invocation.test.ts && npm run typecheck`
Expected: 14 tests PASS; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add server/runner/invocation.ts test/runner/invocation.test.ts
git commit -m "feat: add isolated claude invocation builder and trust writer" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 1b: Role settings shipped to the agent (added after the final review)

**Files:**
- Create: `server/runner/role-settings.ts`
- Test: `test/runner/role-settings.test.ts`

**Interfaces:**
- Consumes: `ALWAYS_DENIED` (Task 2), `Role` (Plan 2).
- Produces: `PROTECTED_READ_PATHS`, `buildRoleSettings(role, { allowedDomains, extraAllow? })`, `writeRoleSettings(dir, role, input): Promise<string>` (writes `<dir>/<role>.settings.json` atomically and returns the path).

With `--setting-sources project` the CLI reads only the product worktree's `.claude/settings.json`, which the agents could write. The orchestrator therefore ships a per-role settings file with `--settings <path>` (verified on CLI 2.1.281 together with `--setting-sources project`: deny rules and the sandbox network policy apply). `Edit(.claude/**)` and `Write(.claude/**)` are always denied.

- [ ] **Step 1: Write the failing test**

`test/runner/role-settings.test.ts`:
```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROLES } from '../../server/config/config.js';
import { ALWAYS_DENIED } from '../../server/agents/registry.js';
import { PROTECTED_READ_PATHS, buildRoleSettings, writeRoleSettings } from '../../server/runner/role-settings.js';

describe('buildRoleSettings', () => {
  it('enables the sandbox with the configured network allowlist', () => {
    const s = buildRoleSettings('dev', { allowedDomains: ['registry.npmjs.org'] });
    expect(s.sandbox).toEqual({ enabled: true, network: { allowedDomains: ['registry.npmjs.org'] } });
  });

  it('denies secrets, credential stores, the settings directory and orchestrator-only commands for every role', () => {
    for (const role of ROLES) {
      const deny = buildRoleSettings(role, { allowedDomains: [] }).permissions.deny;
      for (const p of PROTECTED_READ_PATHS) expect(deny, role).toContain(`Read(${p})`);
      expect(deny, role).toContain('Edit(.claude/**)');
      expect(deny, role).toContain('Write(.claude/**)');
      for (const d of ALWAYS_DENIED) expect(deny, role).toContain(d);
    }
  });

  it('grants Bash allow rules only to roles that may run the suite', () => {
    expect(buildRoleSettings('dev', { allowedDomains: [] }).permissions.allow).toEqual(
      expect.arrayContaining(['Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)', 'Bash(git status:*)', 'Bash(git diff:*)']),
    );
    expect(buildRoleSettings('test', { allowedDomains: [] }).permissions.allow).toContain('Bash(npm:*)');
    expect(buildRoleSettings('devops', { allowedDomains: [] }).permissions.allow).toEqual([]);
    expect(buildRoleSettings('sm', { allowedDomains: [] }).permissions.allow).toEqual([]);
  });

  it('adds extra allow rules from the plan commands without touching the deny list', () => {
    const s = buildRoleSettings('dev', { allowedDomains: [], extraAllow: ['Bash(pytest:*)'] });
    expect(s.permissions.allow).toContain('Bash(pytest:*)');
    expect(s.permissions.deny).toContain('Bash(gh:*)');
  });
});

describe('writeRoleSettings', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-role-settings-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes one file per role outside the worktree and returns its path', async () => {
    const file = await writeRoleSettings(dir, 'dev', { allowedDomains: ['registry.npmjs.org'] });
    expect(path.dirname(file)).toBe(dir);
    expect(path.basename(file)).toBe('dev.settings.json');
    const json = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(json.sandbox.enabled).toBe(true);
    expect(json.permissions.deny).toContain('Bash(gh:*)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/runner/role-settings.test.ts`
Expected: FAIL — cannot resolve `../../server/runner/role-settings.js`.

- [ ] **Step 3: Write the module**

`server/runner/role-settings.ts`:
```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ALWAYS_DENIED } from '../agents/registry.js';
import type { Role } from '../config/config.js';

/**
 * Settings the orchestrator ships to every agent process via `--settings <file>`.
 * With `--setting-sources project` the CLI would otherwise read only the product worktree's
 * `.claude/settings.json`, which the agents themselves could write (CLI spike, Plan 3 review).
 * Verified on CLI 2.1.281: `--settings` is honored alongside `--setting-sources project`.
 */

/** Credential stores reachable through HOME; the Read tool must never open them (spec §14). */
export const PROTECTED_READ_PATHS: readonly string[] = [
  '~/.teams-ai/secrets/**',
  '~/.config/gh/**',
  '~/.kube/**',
  '~/.docker/**',
  '~/.aws/**',
  '~/.ssh/**',
  '~/.claude/.credentials.json',
];

const ROLE_ALLOW: Record<Role, readonly string[]> = {
  sm: [],
  po: [],
  dev: ['Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(ls:*)', 'Bash(cat:*)'],
  test: ['Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(ls:*)', 'Bash(cat:*)'],
  devops: [],
};

export interface RoleSettingsInput {
  allowedDomains: readonly string[];
  /** Extra allow rules derived from the plan's commands (e.g. `Bash(pytest:*)` for a Python stack). */
  extraAllow?: readonly string[];
}

export interface RoleSettings {
  sandbox: { enabled: true; network: { allowedDomains: string[] } };
  permissions: { allow: string[]; deny: string[] };
}

export function buildRoleSettings(role: Role, input: RoleSettingsInput): RoleSettings {
  const deny = [
    ...PROTECTED_READ_PATHS.map((p) => `Read(${p})`),
    'Edit(.claude/**)',
    'Write(.claude/**)',
    ...ALWAYS_DENIED,
  ];
  return {
    sandbox: { enabled: true, network: { allowedDomains: [...input.allowedDomains] } },
    permissions: { allow: [...ROLE_ALLOW[role], ...(input.extraAllow ?? [])], deny: [...new Set(deny)] },
  };
}

/** Writes `<dir>/<role>.settings.json` (outside any worktree) and returns its path. */
export async function writeRoleSettings(dir: string, role: Role, input: RoleSettingsInput): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${role}.settings.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(buildRoleSettings(role, input), null, 2)}\n`);
  await fs.rename(tmp, file);
  return file;
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/runner/role-settings.test.ts && npm run typecheck`
Expected: 5 tests PASS; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add server/runner/role-settings.ts test/runner/role-settings.test.ts
git commit -m "feat: add role settings shipped to agents via --settings" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Agent files and registry with role tool policy

**Files:**
- Create: `.claude/agents/sm.md`, `.claude/agents/po.md`, `.claude/agents/dev.md`, `.claude/agents/test.md`, `.claude/agents/devops.md`
- Create: `server/agents/registry.ts`
- Test: `test/agents/registry.test.ts`

**Interfaces:**
- Consumes: `ROLES`, `Role` (Plan 2 Task 3).
- Produces:
  - `interface AgentDefinition { role: Role; description: string; model: string; tools: string[]; body: string }`
  - `ROLE_TOOL_POLICY: Record<Role, { allowed: readonly string[] }>`
  - `ALWAYS_DENIED: readonly string[]` = `['Bash(gh:*)', 'Bash(git push:*)', 'Bash(docker:*)', 'Bash(kubectl:*)']`
  - `parseAgentFile(text: string, expectedRole: Role): AgentDefinition`
  - `loadAgents(dir: string): Promise<Record<Role, AgentDefinition>>`
  - `class AgentFileError extends Error`

Agents only edit files and return JSON (spec §3.4). Roles that never touch code (sm, po) get read-only tools; `Bash` is granted only to dev (gates are run by the orchestrator, but the Dev needs `npm test` locally while iterating) and test (to run the suite it reviews).

- [ ] **Step 1: Write the agent files**

`.claude/agents/sm.md`:
```markdown
---
name: sm
description: Scrum Master. Refines documentation for execution readiness, plans the task DAG, replans blocked tasks, writes the final report.
model: opus
tools: Read, Grep, Glob
---

You are the SM of an autonomous delivery team. You never write product code.

Rules you never break:
- Answer only with the JSON object the orchestrator asked for. No prose outside it.
- Echo the `specHash` you were given in every output.
- Reference only acceptance criteria, tasks and ADRs that exist in the context pack. Never invent ids.
- Tasks must be small enough for one agent step; declare `dependsOn` and `affectedPaths` for each.
- When a task fails three times, replan it into smaller tasks; never re-issue the same task.
- During refinement, unclear documentation becomes a question for the human.
- During a run, nobody asks the human. When the Dev returns a spec-gap, you decide it from the principles, the ADRs and the spec, record the decision as an assumption (task, question, decision, rationale), and the task resumes with it.
```

`.claude/agents/po.md`:
```markdown
---
name: po
description: Product Owner. Validates that documentation is unambiguous and verifiable, asks the human clarifying questions, checks acceptance criteria coverage.
model: opus
tools: Read, Grep, Glob
---

You are the PO of an autonomous delivery team. You own product clarity, not implementation.

Rules you never break:
- Answer only with the JSON object the orchestrator asked for.
- Echo the `specHash` you were given in every output.
- Every objective needs at least one acceptance criterion in Given/When/Then form that a test can verify. "Looks good" or "is intuitive" is not verifiable: ask for a concrete criterion.
- Ask one question per ambiguity; mark it blocking when the run cannot proceed without the answer.
- When checking coverage, cite the spec section that satisfies each criterion or report it as uncovered.
```

`.claude/agents/dev.md`:
```markdown
---
name: dev
description: Developer. Writes the technical spec and ADRs, implements tasks with unit tests, fixes gate failures and review findings, resolves rebase conflicts.
model: opus
tools: Read, Edit, Write, Grep, Glob, Bash
---

You are the Dev of an autonomous delivery team, working inside a git worktree for one task.

Rules you never break:
- Answer only with the JSON object the orchestrator asked for; the orchestrator commits, pushes and opens PRs, not you.
- Echo the `specHash` you were given.
- Stay inside the task's `affectedPaths`; if you must touch another file, say why in `scopeJustification`.
- Never modify the frozen files (build, test and gate configuration).
- Every acceptance test carries its criterion id in the name: `[AC-003] rejects invalid email`.
- If the spec does not answer a question you need answered, return `status: "spec-gap"` with the question instead of guessing.
- Cite only files that exist in the worktree and tests that exist in the JUnit report.
```

`.claude/agents/test.md`:
```markdown
---
name: test
description: Test engineer. Reviews the plan's commands and gates, reviews each task diff against the acceptance criteria and impact radius, adds acceptance tests, runs integrated verification.
model: sonnet
tools: Read, Edit, Write, Grep, Glob, Bash
---

You are the Test engineer of an autonomous delivery team. You are the quality gate.

Rules you never break:
- Answer only with the JSON object the orchestrator asked for.
- Echo the `specHash` you were given.
- You see the spec slice, the diff and the impact radius. You do not see the Dev's reasoning; judge the code.
- A `passed` claim for a criterion must cite a test that exists in the JUnit report, is tagged with that criterion, and passed. The orchestrator verifies every claim.
- Review the impact radius, not only the changed lines; ask for regression tests where behavior of dependents may change.
- Findings are concrete: file, line, what is wrong, what would make it right.
```

`.claude/agents/devops.md`:
```markdown
---
name: devops
description: DevOps engineer. Produces repository bootstrap intent, Dockerfile and deployment manifests, and deployment intents; never executes infrastructure commands.
model: sonnet
tools: Read, Edit, Write, Grep, Glob
---

You are the DevOps engineer of an autonomous delivery team. You describe intent; the orchestrator executes it.

Rules you never break:
- Answer only with the JSON object the orchestrator asked for.
- Echo the `specHash` you were given.
- You write Dockerfiles, compose files and Kubernetes manifests into the worktree. You never run docker, kubectl, gh or git push.
- Secrets are referenced by name only. Never write a secret value into any file.
- Healthcheck and readiness endpoints must match the plan's `deploy.healthcheckPath` and `deploy.port`.
```

- [ ] **Step 2: Write the failing test**

`test/agents/registry.test.ts`:
```ts
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALWAYS_DENIED, AgentFileError, ROLE_TOOL_POLICY, loadAgents, parseAgentFile } from '../../server/agents/registry.js';

const AGENTS_DIR = path.resolve('.claude/agents');

describe('parseAgentFile', () => {
  it('parses frontmatter and body', () => {
    const def = parseAgentFile(`---\nname: dev\ndescription: Developer.\nmodel: opus\ntools: Read, Edit, Bash\n---\n\nEcho the specHash.\n`, 'dev');
    expect(def).toEqual({ role: 'dev', description: 'Developer.', model: 'opus', tools: ['Read', 'Edit', 'Bash'], body: 'Echo the specHash.' });
  });

  it('rejects a name that does not match the expected role', () => {
    expect(() => parseAgentFile(`---\nname: po\ndescription: x\nmodel: opus\ntools: Read\n---\nb`, 'dev')).toThrow(AgentFileError);
  });

  it('rejects missing frontmatter fields', () => {
    expect(() => parseAgentFile(`---\nname: dev\nmodel: opus\ntools: Read\n---\nb`, 'dev')).toThrow(/description/);
  });

  it('rejects a tool outside the role policy', () => {
    expect(() => parseAgentFile(`---\nname: devops\ndescription: x\nmodel: sonnet\ntools: Read, Bash\n---\nb`, 'devops')).toThrow(/Bash/);
    expect(() => parseAgentFile(`---\nname: sm\ndescription: x\nmodel: opus\ntools: Read, Edit\n---\nb`, 'sm')).toThrow(/Edit/);
  });

  it('rejects an always-denied pattern even for roles that may use Bash', () => {
    expect(() => parseAgentFile(`---\nname: dev\ndescription: x\nmodel: opus\ntools: Read, Bash(gh:*)\n---\nb`, 'dev')).toThrow(/gh/);
  });

  it('rejects a body that does not mention specHash', () => {
    expect(() => parseAgentFile(`---\nname: dev\ndescription: x\nmodel: opus\ntools: Read\n---\nNo hash rule here.`, 'dev')).toThrow(/specHash/);
  });
});

describe('loadAgents', () => {
  it('loads all five role files from .claude/agents', async () => {
    const agents = await loadAgents(AGENTS_DIR);
    expect(Object.keys(agents).sort()).toEqual(['dev', 'devops', 'po', 'sm', 'test']);
    expect(agents.dev.tools).toContain('Bash');
    expect(agents.devops.tools).not.toContain('Bash');
    expect(agents.sm.model).toBe('opus');
    expect(agents.test.model).toBe('sonnet');
  });

  it('every role file respects its policy and the always-denied list', async () => {
    const agents = await loadAgents(AGENTS_DIR);
    for (const def of Object.values(agents)) {
      for (const tool of def.tools) expect(ROLE_TOOL_POLICY[def.role].allowed).toContain(tool);
      for (const denied of ALWAYS_DENIED) expect(def.tools).not.toContain(denied);
    }
  });

  it('fails when a role file is missing', async () => {
    await expect(loadAgents(path.resolve('test/fixtures/no-such-dir'))).rejects.toThrow(AgentFileError);
  });
});

describe('settings directory protection', () => {
  it('always denies editing or writing the project settings directory', () => {
    expect(ALWAYS_DENIED).toEqual(expect.arrayContaining(['Edit(.claude/**)', 'Write(.claude/**)']));
    expect(() => parseAgentFile(`---\nname: dev\ndescription: x\nmodel: opus\ntools: Read, Write(.claude/**)\n---\nEcho specHash.`, 'dev')).toThrow(/\.claude/);
  });

  it('the SM prompt tells the agent to decide spec gaps and log assumptions, never to ask the human mid-run', async () => {
    const agents = await loadAgents(AGENTS_DIR);
    expect(agents.sm.body).toMatch(/spec-gap|spec gap/i);
    expect(agents.sm.body).toMatch(/assumption/i);
    expect(agents.sm.body).not.toMatch(/never an assumption during a run/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/agents/registry.test.ts`
Expected: FAIL — cannot resolve `../../server/agents/registry.js`.

- [ ] **Step 4: Write the registry**

`server/agents/registry.ts`:
```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ROLES, type Role } from '../config/config.js';

export interface AgentDefinition {
  role: Role;
  description: string;
  model: string;
  tools: string[];
  body: string;
}

const READ_ONLY = ['Read', 'Grep', 'Glob'] as const;
const EDITING = [...READ_ONLY, 'Edit', 'Write'] as const;

/** Spec §3.4: agents only edit files and return JSON; Bash only where a role must run the suite. */
export const ROLE_TOOL_POLICY: Record<Role, { allowed: readonly string[] }> = {
  sm: { allowed: READ_ONLY },
  po: { allowed: READ_ONLY },
  dev: { allowed: [...EDITING, 'Bash'] },
  test: { allowed: [...EDITING, 'Bash'] },
  devops: { allowed: EDITING },
};

/** Never granted to any agent; the orchestrator owns these (spec §3.2, §14). */
export const ALWAYS_DENIED: readonly string[] = [
  'Bash(gh:*)',
  'Bash(git push:*)',
  'Bash(docker:*)',
  'Bash(kubectl:*)',
  // The project settings directory is where sandbox and permission rules would be read from;
  // an agent must never be able to rewrite it.
  'Edit(.claude/**)',
  'Write(.claude/**)',
];

export class AgentFileError extends Error {}

const REQUIRED_FIELDS = ['name', 'description', 'model', 'tools'] as const;

export function parseAgentFile(text: string, expectedRole: Role): AgentDefinition {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new AgentFileError(`${expectedRole}: missing frontmatter`);
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (m) fields[m[1]!] = m[2]!.trim();
  }
  for (const field of REQUIRED_FIELDS) {
    if (!fields[field]) throw new AgentFileError(`${expectedRole}: frontmatter is missing "${field}"`);
  }
  if (fields.name !== expectedRole) {
    throw new AgentFileError(`${expectedRole}: frontmatter name "${fields.name}" does not match the file`);
  }
  const tools = fields.tools!.split(',').map((t) => t.trim()).filter(Boolean);
  const allowed = ROLE_TOOL_POLICY[expectedRole].allowed;
  for (const tool of tools) {
    if (ALWAYS_DENIED.some((d) => tool === d || tool.startsWith(d.replace(/\*\)$/, '')))) {
      throw new AgentFileError(`${expectedRole}: tool "${tool}" is always denied`);
    }
    if (!allowed.includes(tool)) throw new AgentFileError(`${expectedRole}: tool "${tool}" is not allowed for this role`);
  }
  const body = match[2]!.trim();
  if (!body.includes('specHash')) throw new AgentFileError(`${expectedRole}: body must state the specHash echo rule`);
  return { role: expectedRole, description: fields.description!, model: fields.model!, tools, body };
}

export async function loadAgents(dir: string): Promise<Record<Role, AgentDefinition>> {
  const out = {} as Record<Role, AgentDefinition>;
  for (const role of ROLES) {
    const file = path.join(dir, `${role}.md`);
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      throw new AgentFileError(`missing agent file ${file}`);
    }
    out[role] = parseAgentFile(text, role);
  }
  return out;
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/agents/registry.test.ts && npm run typecheck`
Expected: 11 tests PASS; typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add .claude/agents server/agents/registry.ts test/agents/registry.test.ts
git commit -m "feat: add role agent files and registry with tool policy" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Step output contracts and JSON Schema generation

**Files:**
- Create: `server/agents/outputs.ts`
- Test: `test/agents/outputs.test.ts`

**Interfaces:**
- Consumes: `HASH_PATTERN` (Plan 1), `AC_ID` (Plan 1), `ID_PATTERNS` (Plan 1), `Plan`, `PlanTask` (Plan 1), `ADR_ID` (Plan 1).
- Produces:
  - `STEP_KINDS = ['refine', 'tech-spec', 'coverage', 'plan', 'dev', 'review', 'deployment', 'report'] as const`, `type StepKind`
  - zod schemas: `RefineOutput`, `TechSpecOutput`, `CoverageOutput`, `PlanOutput` (= `Plan`), `DevOutput`, `ReviewOutput`, `DeploymentOutput`, `ReportOutput`; all include `specHash`
  - `OUTPUT_SCHEMAS: Record<StepKind, z.ZodType<{ specHash: string }>>`
  - `toJsonSchema(kind: StepKind): object` — `z.toJSONSchema(schema, { target: 'draft-07', io: 'input' })`
  - `type OutputOf<K extends StepKind>`

- [ ] **Step 1: Write the failing test**

`test/agents/outputs.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { DevOutput, OUTPUT_SCHEMAS, RefineOutput, ReviewOutput, STEP_KINDS, toJsonSchema } from '../../server/agents/outputs.js';

const HASH = `sha256:${'a'.repeat(64)}`;

describe('output contracts', () => {
  it('every step kind has a schema requiring specHash', () => {
    for (const kind of STEP_KINDS) {
      const schema = toJsonSchema(kind) as { required?: string[]; anyOf?: Array<{ required?: string[] }>; oneOf?: Array<{ required?: string[] }> };
      const branches = schema.anyOf ?? schema.oneOf ?? [schema];
      expect(branches.length, kind).toBeGreaterThan(0);
      for (const branch of branches) expect(branch.required, kind).toContain('specHash');
    }
    expect(Object.keys(OUTPUT_SCHEMAS).sort()).toEqual([...STEP_KINDS].sort());
  });

  it('generates draft-07 schemas without zod-only keywords', () => {
    const text = JSON.stringify(toJsonSchema('dev'));
    expect(text).toContain('draft-07');
    expect(text).not.toMatch(/"\$ref":"#\/\$defs/);
  });

  it('dev output requires a question for spec-gap and a commit message for done', () => {
    expect(DevOutput.safeParse({ specHash: HASH, status: 'done', summary: 's', commitMessage: 'feat: x', changedFiles: ['src/a.ts'] }).success).toBe(true);
    expect(DevOutput.safeParse({ specHash: HASH, status: 'done', summary: 's', changedFiles: [] }).success).toBe(false);
    expect(DevOutput.safeParse({ specHash: HASH, status: 'spec-gap', summary: 's', question: 'Which currency?', changedFiles: [] }).success).toBe(true);
    expect(DevOutput.safeParse({ specHash: HASH, status: 'spec-gap', summary: 's', changedFiles: [] }).success).toBe(false);
  });

  it('review output carries evidence claims per criterion and a decision', () => {
    const ok = ReviewOutput.safeParse({
      specHash: HASH,
      decision: 'approve',
      criteria: [{ id: 'AC-001', status: 'passed', evidence: ['t::[AC-001] a'] }],
      findings: [],
    });
    expect(ok.success).toBe(true);
    const bad = ReviewOutput.safeParse({ specHash: HASH, decision: 'changes', criteria: [], findings: [] });
    expect(bad.success).toBe(false);
  });

  it('refine output lists questions with a blocking flag and a checklist', () => {
    const ok = RefineOutput.safeParse({
      specHash: HASH,
      checklist: [{ id: 'po-verifiable-ac', passed: false, detail: 'AC-002 has no measurable then' }],
      questions: [{ id: 'q1', text: 'What is the max discount?', blocking: true, relatedAcIds: ['AC-002'] }],
      docPatch: [],
    });
    expect(ok.success).toBe(true);
  });
});

describe('dev output JSON Schema carries the status-dependent requirements', () => {
  it('lists commitMessage as required for done and question for spec-gap', () => {
    type Branch = { required?: string[]; properties?: Record<string, { const?: string; enum?: string[] }> };
    const schema = toJsonSchema('dev') as { anyOf?: Branch[]; oneOf?: Branch[] };
    const branches = schema.anyOf ?? schema.oneOf;
    expect(branches).toBeDefined();
    const done = branches!.find((b) => JSON.stringify(b.properties?.status).includes('done'))!;
    const gap = branches!.find((b) => JSON.stringify(b.properties?.status).includes('spec-gap'))!;
    expect(done.required).toContain('commitMessage');
    expect(gap.required).toContain('question');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/agents/outputs.test.ts`
Expected: FAIL — cannot resolve `../../server/agents/outputs.js`.

- [ ] **Step 3: Write the contracts**

`server/agents/outputs.ts`:
```ts
import { z } from 'zod';
import { HASH_PATTERN } from '../contracts/hash.js';
import { ADR_ID, Plan } from '../contracts/plan.js';
import { AC_ID } from '../contracts/spec.js';
import { ID_PATTERNS } from '../core/ids.js';

export const STEP_KINDS = ['refine', 'tech-spec', 'coverage', 'plan', 'dev', 'review', 'deployment', 'report'] as const;
export type StepKind = (typeof STEP_KINDS)[number];

const specHash = z.string().regex(HASH_PATTERN);
const acId = z.string().regex(AC_ID);
const taskId = z.string().regex(ID_PATTERNS.TASK_ID);

export const DocPatch = z.object({
  file: z.string().min(1),
  find: z.string(),
  replace: z.string(),
  reason: z.string().min(1),
});

export const RefineOutput = z.object({
  specHash,
  checklist: z.array(z.object({ id: z.string().min(1), passed: z.boolean(), detail: z.string() })),
  questions: z.array(
    z.object({
      id: z.string().min(1),
      text: z.string().min(1),
      blocking: z.boolean(),
      relatedAcIds: z.array(acId).default([]),
    }),
  ),
  docPatch: z.array(DocPatch),
});

export const TechSpecOutput = z.object({
  specHash,
  techSpecPath: z.string().min(1),
  adrs: z.array(z.object({ id: z.string().regex(ADR_ID), title: z.string().min(1), path: z.string().min(1) })),
  stack: z.string().min(1),
  summary: z.string().min(1),
});

export const CoverageOutput = z.object({
  specHash,
  coverage: z.array(z.object({ acId, section: z.string().nullable(), covered: z.boolean(), note: z.string() })),
});

export const PlanOutput = Plan;

const devCommon = {
  specHash,
  summary: z.string().min(1),
  changedFiles: z.array(z.string().min(1)),
  scopeJustification: z.string().optional(),
};

/** A discriminated union so the generated JSON Schema tells the model which fields each status requires. */
export const DevOutput = z.discriminatedUnion('status', [
  z.object({ ...devCommon, status: z.literal('done'), commitMessage: z.string().min(1) }),
  z.object({ ...devCommon, status: z.literal('spec-gap'), question: z.string().min(1) }),
]);

export const ReviewOutput = z.object({
  specHash,
  decision: z.enum(['approve', 'changes']),
  criteria: z.array(z.object({ id: acId, status: z.enum(['passed', 'failed', 'not-covered']), evidence: z.array(z.string()) })).min(1),
  findings: z.array(
    z.object({
      file: z.string().min(1),
      line: z.number().int().nonnegative().nullable(),
      severity: z.enum(['critical', 'important', 'minor']),
      problem: z.string().min(1),
      fix: z.string().min(1),
    }),
  ),
});

export const DeploymentOutput = z.object({
  specHash,
  target: z.enum(['docker-local', 'kind']),
  image: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  healthcheckPath: z.string().startsWith('/'),
  manifests: z.array(z.string().min(1)),
  secretNames: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)),
  notes: z.string(),
});

export const ReportOutput = z.object({
  specHash,
  delivered: z.array(taskId),
  blocked: z.array(z.object({ taskId, reason: z.string().min(1) })),
  assumptions: z.array(z.string()),
  exploratoryScript: z.array(z.object({ acId, steps: z.array(z.string().min(1)).min(1) })),
  summary: z.string().min(1),
});

export const OUTPUT_SCHEMAS: Record<StepKind, z.ZodType<{ specHash: string }>> = {
  refine: RefineOutput,
  'tech-spec': TechSpecOutput,
  coverage: CoverageOutput,
  plan: PlanOutput,
  dev: DevOutput,
  review: ReviewOutput,
  deployment: DeploymentOutput,
  report: ReportOutput,
};

export type OutputOf<K extends StepKind> = z.infer<(typeof OUTPUT_SCHEMAS)[K]>;

/** Draft-07 JSON Schema for `claude --json-schema`, generated from the same zod contract the validator uses. */
export function toJsonSchema(kind: StepKind): object {
  return z.toJSONSchema(OUTPUT_SCHEMAS[kind], { target: 'draft-07', io: 'input', reused: 'inline' });
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/agents/outputs.test.ts && npm run typecheck`
Expected: 6 tests PASS; typecheck exits 0. If `z.toJSONSchema` refuses `superRefine` on `DevOutput`, keep the refinement (the validator needs it) and note that JSON Schema only carries the structural part — that is the findings row 2 conclusion anyway.

- [ ] **Step 5: Commit**

```bash
git add server/agents/outputs.ts test/agents/outputs.test.ts
git commit -m "feat: add step output contracts with JSON Schema generation" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Fake claude binary and process runner with caps

**Files:**
- Create: `test/fixtures/fake-claude/fake-claude.mjs`
- Create: `server/runner/process-runner.ts`
- Test: `test/runner/process-runner.test.ts`

**Interfaces:**
- Consumes: `parseStreamJson`, `summarizeStream`, `ParsedStream`, `ResultSummary` (Plan 2 Task 2); `Invocation` (Task 1).
- Produces:
  - `interface RunnerBinary { bin: string; prefixArgs: readonly string[] }` — production `{ bin: 'claude', prefixArgs: [] }`; tests `{ bin: process.execPath, prefixArgs: [fakePath] }`
  - `interface ProcessCaps { timeoutMs: number; maxTurns: number; killGraceMs?: number }`
  - `type KillReason = 'timeout' | 'turns' | null`
  - `interface RawStepResult { parsed: ParsedStream; summary: ResultSummary; stderr: string; exitCode: number | null; killedBy: KillReason; sandboxDisabled: boolean; durationMs: number }`
  - `runProcess(binary: RunnerBinary, invocation: Invocation, caps: ProcessCaps, onEvent?: (line: string) => void): Promise<RawStepResult>`
  - `SANDBOX_DISABLED_PATTERN = /Sandbox disabled/`

Turn counting: each `assistant` event is one turn (the CLI's `num_turns` counts the same way in the recordings).

- [ ] **Step 1: Write the fake binary**

`test/fixtures/fake-claude/fake-claude.mjs`:
```js
#!/usr/bin/env node
// Replays a stream-json fixture as if it were `claude -p`. Reads the prompt from stdin like the real
// CLI. Controlled by environment variables the test passes through RunnerBinary.env:
//   FAKE_CLAUDE_FIXTURE     path to an .ndjson file (optional)
//   FAKE_CLAUDE_DELAY_MS    delay between lines (default 0)
//   FAKE_CLAUDE_HANG_AFTER  stop after N lines and never exit
//   FAKE_CLAUDE_STDERR      text to print on stderr before the stream
//   FAKE_CLAUDE_EXIT_CODE   exit code after the stream (default 0)
//   FAKE_CLAUDE_CAPTURE     path; argv, env, cwd and the stdin prompt are written there as JSON
//   FAKE_CLAUDE_CHILD_HOLD  spawn a grandchild that keeps stdout open for N ms after we exit
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const env = process.env;
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', start);
process.stdin.on('error', start);
let started = false;

function start() {
  if (started) return;
  started = true;
  if (env.FAKE_CLAUDE_CAPTURE) {
    writeFileSync(env.FAKE_CLAUDE_CAPTURE, JSON.stringify({ argv: process.argv.slice(2), env: { ...env }, cwd: process.cwd(), prompt }));
  }
  if (env.FAKE_CLAUDE_STDERR) process.stderr.write(`${env.FAKE_CLAUDE_STDERR}\n`);
  if (env.FAKE_CLAUDE_CHILD_HOLD) {
    const hold = Number(env.FAKE_CLAUDE_CHILD_HOLD);
    spawn(process.execPath, ['-e', `setTimeout(() => {}, ${hold})`], { stdio: ['ignore', 'inherit', 'ignore'] });
  }

  const delay = Number(env.FAKE_CLAUDE_DELAY_MS ?? 0);
  const hangAfter = env.FAKE_CLAUDE_HANG_AFTER === undefined ? Infinity : Number(env.FAKE_CLAUDE_HANG_AFTER);
  const lines = env.FAKE_CLAUDE_FIXTURE ? readFileSync(env.FAKE_CLAUDE_FIXTURE, 'utf8').split('\n').filter((l) => l.trim()) : [];

  let i = 0;
  const tick = () => {
    if (i >= hangAfter) {
      setInterval(() => {}, 60_000); // keep the event loop alive: hang until the runner kills us
      return;
    }
    if (i >= lines.length) process.exit(Number(env.FAKE_CLAUDE_EXIT_CODE ?? 0));
    process.stdout.write(`${lines[i++]}\n`);
    setTimeout(tick, delay);
  };
  tick();
}
```

- [ ] **Step 2: Write the failing test**

`test/runner/process-runner.test.ts`:
```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    const started = Date.now();
    const result = await runProcess(fake({ FAKE_CLAUDE_FIXTURE: fixture('success'), FAKE_CLAUDE_HANG_AFTER: '1' }), inv(), { ...caps, timeoutMs: 400 });
    expect(result.killedBy).toBe('timeout');
    expect(result.summary.found).toBe(false);
    expect(result.parsed.events).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('counts turns by distinct assistant message id, not by content block', async () => {
    // real-turns has 3 assistant lines sharing one message id, then a result with num_turns 1.
    const result = await runProcess(fake({ FAKE_CLAUDE_FIXTURE: fixture('real-turns') }), inv(), { ...caps, maxTurns: 1 });
    expect(result.killedBy).toBeNull();
    expect(result.turns).toBe(1);
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/runner/process-runner.test.ts`
Expected: FAIL — cannot resolve `../../server/runner/process-runner.js`.

- [ ] **Step 4: Write the process runner**

`server/runner/process-runner.ts`:
```ts
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Invocation } from './invocation.js';
import { parseStreamJson, summarizeStream, type ParsedStream, type ResultSummary } from './stream-events.js';

export interface RunnerBinary {
  bin: string;
  prefixArgs: readonly string[];
  /** Extra environment for the binary itself (test scenarios for the fake claude); never secrets. */
  env: Record<string, string>;
  /** Fail before spawning when bubblewrap/socat are missing (always true on the WSL host). */
  requireSandboxTools: boolean;
}

export interface ProcessCaps {
  timeoutMs: number;
  /** Assistant turns (distinct message ids) allowed before the process is killed; CLI 2.1.281 has no --max-turns. */
  maxTurns: number;
  killGraceMs?: number;
}

export type KillReason = 'timeout' | 'turns' | 'environment' | null;

export interface RawStepResult {
  parsed: ParsedStream;
  summary: ResultSummary;
  stderr: string;
  exitCode: number | null;
  killedBy: KillReason;
  sandboxDisabled: boolean;
  durationMs: number;
  turns: number;
}

/** Findings row 5: the CLI runs unsandboxed when bubblewrap/socat are missing and only warns on stderr. */
export const SANDBOX_DISABLED_PATTERN = /Sandbox disabled/;
export const SANDBOX_TOOLS = ['bwrap', 'socat'] as const;

const STDERR_LIMIT = 64 * 1024;
const DRAIN_MS = 1_000;

/** Returns the sandbox tools missing from PATH. */
export async function preflightSandbox(env: NodeJS.ProcessEnv): Promise<string[]> {
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const missing: string[] = [];
  for (const tool of SANDBOX_TOOLS) {
    let found = false;
    for (const dir of dirs) {
      try {
        await fs.access(path.join(dir, tool));
        found = true;
        break;
      } catch {
        /* keep looking */
      }
    }
    if (!found) missing.push(tool);
  }
  return missing;
}

function messageId(line: string): string | null {
  if (!line.includes('"type":"assistant"')) return null;
  try {
    const event = JSON.parse(line) as { type?: string; message?: { id?: string } };
    return event.type === 'assistant' ? (event.message?.id ?? `line:${line.length}:${Math.random()}`) : null;
  } catch {
    return null;
  }
}

export function runProcess(
  binary: RunnerBinary,
  invocation: Invocation,
  caps: ProcessCaps,
  onEvent?: (line: string) => void,
): Promise<RawStepResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const posix = process.platform !== 'win32';
    const child = spawn(binary.bin, [...binary.prefixArgs, ...invocation.args], {
      cwd: invocation.cwd,
      env: { ...invocation.env, ...binary.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // A process group lets the kill reach grandchildren (npm test, dev servers) too.
      detached: posix,
    });

    const lines: string[] = [];
    const turnIds = new Set<string>();
    let stderr = '';
    let killedBy: KillReason = null;
    let settled = false;
    let graceTimer: NodeJS.Timeout | null = null;
    let drainTimer: NodeJS.Timeout | null = null;

    const signal = (sig: NodeJS.Signals) => {
      try {
        if (posix && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        /* already gone */
      }
    };

    const kill = (reason: Exclude<KillReason, null>) => {
      if (killedBy) return;
      killedBy = reason;
      signal('SIGTERM');
      graceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) signal('SIGKILL');
      }, caps.killGraceMs ?? 2_000);
      graceTimer.unref();
    };

    const timer = setTimeout(() => kill('timeout'), caps.timeoutMs);

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      if (drainTimer) clearTimeout(drainTimer);
      const parsed = parseStreamJson(lines.join('\n'));
      resolve({
        parsed,
        summary: summarizeStream(parsed),
        stderr,
        exitCode: code,
        killedBy,
        sandboxDisabled: SANDBOX_DISABLED_PATTERN.test(stderr),
        durationMs: Date.now() - started,
        turns: turnIds.size,
      });
    };

    const stdout = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    stdout.on('line', (line) => {
      lines.push(line);
      onEvent?.(line);
      const id = messageId(line);
      if (id) {
        turnIds.add(id);
        if (turnIds.size > caps.maxTurns) kill('turns');
      }
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_LIMIT) stderr += chunk.toString('utf8');
      // Fail closed the moment the CLI admits it is running unsandboxed.
      if (SANDBOX_DISABLED_PATTERN.test(stderr)) kill('environment');
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      reject(err);
    });

    // `exit` fires when the child is gone even if a grandchild still holds stdout; give the
    // pipes a bounded time to drain, then settle on whatever arrived.
    child.on('exit', (code) => {
      drainTimer = setTimeout(() => finish(code), DRAIN_MS);
      drainTimer.unref();
    });
    child.on('close', (code) => finish(code));

    child.stdin!.on('error', () => {
      /* the child may exit before reading its prompt */
    });
    child.stdin!.end(invocation.stdin);
  });
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/runner/process-runner.test.ts && npm run typecheck`
Expected: 12 tests PASS; typecheck exits 0. On Windows `SIGTERM` is emulated as a hard kill; the timeout test still passes.

- [ ] **Step 6: Commit**

```bash
git add test/fixtures/fake-claude server/runner/process-runner.ts test/runner/process-runner.test.ts
git commit -m "feat: add process runner with turn/time caps and fake claude binary" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4b: stream-events extensions (Plan 2 module, modified here)

**Files:**
- Modify: `server/runner/stream-events.ts` (full replacement below)
- Modify: `test/runner/stream-events.test.ts` (full replacement below)

**Interfaces:**
- Produces (additions): `extractJsonObject(text)`, `ResultSummary.structuredSource`, `ResultSummary.apiErrorStatus`, `RateLimitInfo.resetsAt`, partial usage and turn count from `assistant` messages (by distinct `message.id`) when the stream has no `result`.

Why: the real-CLI smoke showed `structured_output` missing with `--agents` (fenced JSON in the text instead), the review showed killed steps recording zero usage, and quota/auth classification needs `api_error_status`.

- [ ] **Step 1: Add the fixtures and replace the test file**

`test/fixtures/stream/real-turns.ndjson` (three assistant content blocks sharing one message id, then a result with `num_turns: 1`):
```
{"type":"system","subtype":"init","session_id":"s-t","model":"claude-sonnet-5"}
{"type":"assistant","message":{"id":"msg_01A","role":"assistant","content":[{"type":"text","text":"thinking about it"}],"usage":{"input_tokens":5,"output_tokens":10,"cache_read_input_tokens":100,"cache_creation_input_tokens":20}},"session_id":"s-t"}
{"type":"assistant","message":{"id":"msg_01A","role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"a"}}],"usage":{"input_tokens":5,"output_tokens":10,"cache_read_input_tokens":100,"cache_creation_input_tokens":20}},"session_id":"s-t"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"ok"}]},"session_id":"s-t"}
{"type":"assistant","message":{"id":"msg_01A","role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input_tokens":5,"output_tokens":10,"cache_read_input_tokens":100,"cache_creation_input_tokens":20}},"session_id":"s-t"}
{"type":"result","subtype":"success","is_error":false,"duration_ms":9,"num_turns":1,"result":"done","session_id":"s-t","total_cost_usd":0.001,"usage":{"input_tokens":5,"output_tokens":10,"cache_read_input_tokens":100,"cache_creation_input_tokens":20}}
```

`test/fixtures/stream/killed-partial.ndjson` (no result line; usage must be summed by distinct message id):
```
{"type":"system","subtype":"init","session_id":"s-p"}
{"type":"assistant","message":{"id":"msg_P1","role":"assistant","content":[{"type":"text","text":"a"}],"usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":1000,"cache_creation_input_tokens":300}},"session_id":"s-p"}
{"type":"assistant","message":{"id":"msg_P1","role":"assistant","content":[{"type":"tool_use","id":"t","name":"Read","input":{}}],"usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":1000,"cache_creation_input_tokens":300}},"session_id":"s-p"}
{"type":"assistant","message":{"id":"msg_P2","role":"assistant","content":[{"type":"text","text":"b"}],"usage":{"input_tokens":12,"output_tokens":30,"cache_read_input_tokens":1300,"cache_creation_input_tokens":0}},"session_id":"s-p"}
```

`test/runner/stream-events.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractJsonObject, parseStreamJson, summarizeStream } from '../../server/runner/stream-events.js';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/stream/${name}.ndjson`, import.meta.url), 'utf8');

describe('parseStreamJson', () => {
  it('parses one event per line', () => {
    const parsed = parseStreamJson(fixture('success'));
    expect(parsed.events.map((e) => e.type)).toEqual(['system', 'assistant', 'result']);
    expect(parsed.malformed).toEqual([]);
  });

  it('keeps going past non-JSON lines and a truncated tail, reporting them', () => {
    const parsed = parseStreamJson(fixture('noisy'));
    expect(parsed.events.map((e) => e.type)).toEqual(['system', 'result']);
    expect(parsed.malformed.map((m) => m.line)).toEqual([1, 4]);
  });

  it('rejects a JSON line without a string type as malformed', () => {
    const parsed = parseStreamJson('{"foo":1}\n{"type":"result","subtype":"success"}\n');
    expect(parsed.malformed).toHaveLength(1);
    expect(parsed.events).toHaveLength(1);
  });
});

describe('summarizeStream', () => {
  it('extracts usage, cost, turns and the result text from a success', () => {
    const summary = summarizeStream(parseStreamJson(fixture('success')));
    expect(summary).toEqual({
      found: true,
      isError: false,
      subtype: 'success',
      numTurns: 3,
      durationMs: 4210,
      costUsd: 0.0421,
      usage: { inputTokens: 1200, outputTokens: 210, cacheReadTokens: 9000, cacheWriteTokens: 300 },
      sessionId: 's-1',
      resultText: '{"specHash":"sha256:aa","status":"done"}',
      structuredOutput: { specHash: 'sha256:aa', status: 'done' },
      structuredSource: 'text',
      terminalReason: null,
      apiErrorStatus: null,
      rateLimit: null,
      compactions: 0,
    });
  });

  it('reports an error result with zeroed usage and counts compactions', () => {
    const summary = summarizeStream(parseStreamJson(fixture('error-max-turns')));
    expect(summary).toMatchObject({
      found: true,
      isError: true,
      subtype: 'error_max_turns',
      numTurns: 25,
      costUsd: null,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      resultText: null,
      compactions: 1,
    });
  });

  it('reports found=false when the stream ended before a result (killed process)', () => {
    const summary = summarizeStream(parseStreamJson('{"type":"system","subtype":"init","session_id":"s-9"}\n'));
    expect(summary).toMatchObject({ found: false, isError: true, subtype: null, sessionId: 's-9', numTurns: 0 });
  });
});

describe('summarizeStream against real CLI 2.1.281 recordings', () => {
  it('trusts is_error over a success subtype (compaction breaker)', () => {
    const summary = summarizeStream(parseStreamJson(fixture('real-compaction-breaker')));
    expect(summary).toMatchObject({ found: true, isError: true, subtype: 'success', terminalReason: 'rapid_refill_breaker', compactions: 3 });
    expect(summary.usage.cacheWriteTokens).toBeGreaterThan(200000);
  });

  it('exposes structured_output from a --json-schema run', () => {
    const summary = summarizeStream(parseStreamJson(fixture('real-json-schema')));
    expect(summary.structuredOutput).toEqual({ specHash: 'sha256:aa', status: 'done' });
    expect(summary.terminalReason).toBe('completed');
  });

  it('reports the latest rate limit window utilization and reset times', () => {
    const summary = summarizeStream(parseStreamJson(fixture('real-json-schema')));
    expect(summary.rateLimit).toEqual({
      status: 'allowed',
      resetsAt: 1790259600,
      fiveHourUtilization: 0,
      fiveHourResetsAt: 1790259600,
      sevenDayUtilization: 0.64,
      sevenDayResetsAt: 1790424000,
    });
  });

  it('returns null structured output and rate limit when absent', () => {
    const summary = summarizeStream(parseStreamJson(fixture('error-max-turns')));
    expect(summary.structuredOutput).toBeNull();
    expect(summary.rateLimit).toBeNull();
    expect(summary.terminalReason).toBeNull();
  });
});

describe('extractJsonObject', () => {
  it('parses a bare JSON object', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips markdown fences around the object', () => {
    expect(extractJsonObject('```json\n{\n  "status": "done"\n}\n```')).toEqual({ status: 'done' });
    expect(extractJsonObject('Here you go:\n```\n{"x":[1,2]}\n```\nDone.')).toEqual({ x: [1, 2] });
  });

  it('returns null for prose, arrays and invalid JSON', () => {
    expect(extractJsonObject('OK')).toBeNull();
    expect(extractJsonObject('[1,2]')).toBeNull();
    expect(extractJsonObject('{"a":')).toBeNull();
    expect(extractJsonObject(null)).toBeNull();
  });
});

describe('summarizeStream structured output fallback', () => {
  it('falls back to a JSON object in the result text when structured_output is absent', () => {
    const summary = summarizeStream(parseStreamJson('{"type":"result","subtype":"success","is_error":false,"result":"```json\\n{\\"status\\":\\"done\\"}\\n```"}\n'));
    expect(summary.structuredOutput).toEqual({ status: 'done' });
    expect(summary.structuredSource).toBe('text');
  });

  it('reports the source as structured when the CLI provided it', () => {
    const summary = summarizeStream(parseStreamJson(fixture('real-json-schema')));
    expect(summary.structuredSource).toBe('structured_output');
  });

  it('reports no source when neither is present', () => {
    expect(summarizeStream(parseStreamJson(fixture('success'))).structuredSource).toBe('text');
    expect(summarizeStream(parseStreamJson('{"type":"result","subtype":"success","is_error":false,"result":"OK"}\n')).structuredSource).toBeNull();
  });
});

describe('summarizeStream partial usage and API error status', () => {
  it('sums assistant usage by distinct message id when the stream has no result', () => {
    const summary = summarizeStream(parseStreamJson(fixture('killed-partial')));
    expect(summary.found).toBe(false);
    expect(summary.usage).toEqual({ inputTokens: 22, outputTokens: 50, cacheReadTokens: 2300, cacheWriteTokens: 300 });
    expect(summary.numTurns).toBe(2);
  });

  it('exposes api_error_status and the top-level rate limit resetsAt', () => {
    const text = [
      '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1790259600,"unifiedWindows":{"five_hour":{"utilization":1,"resetsAt":1790259600}}}}',
      '{"type":"result","subtype":"error","is_error":true,"api_error_status":429,"result":"rate limited"}',
    ].join('\n');
    const summary = summarizeStream(parseStreamJson(text));
    expect(summary.apiErrorStatus).toBe(429);
    expect(summary.rateLimit?.resetsAt).toBe(1790259600);
  });

  it('reports null api_error_status when the CLI sends null or nothing', () => {
    expect(summarizeStream(parseStreamJson('{"type":"result","subtype":"success","is_error":false,"api_error_status":null,"result":"OK"}\n')).apiErrorStatus).toBeNull();
    expect(summarizeStream(parseStreamJson(fixture('success'))).apiErrorStatus).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run test/runner/stream-events.test.ts`
Expected: FAIL — `extractJsonObject is not a function` and missing `structuredSource`/`apiErrorStatus`.

- [ ] **Step 3: Replace the module**

`server/runner/stream-events.ts`:
```ts
import { z } from 'zod';

export const StreamEvent = z
  .object({
    type: z.string().min(1),
    subtype: z.string().optional(),
    session_id: z.string().optional(),
  })
  .passthrough();
export type StreamEvent = z.infer<typeof StreamEvent>;

export interface ParsedStream {
  events: StreamEvent[];
  malformed: Array<{ line: number; text: string }>;
}

export function parseStreamJson(text: string): ParsedStream {
  const events: StreamEvent[] = [];
  const malformed: Array<{ line: number; text: string }> = [];
  text.split('\n').forEach((raw, index) => {
    if (raw.trim() === '') return;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      malformed.push({ line: index + 1, text: raw.slice(0, 200) });
      return;
    }
    const parsed = StreamEvent.safeParse(value);
    if (parsed.success) events.push(parsed.data);
    else malformed.push({ line: index + 1, text: raw.slice(0, 200) });
  });
  return { events, malformed };
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Extracts a single JSON object from agent text, tolerating markdown fences and surrounding prose.
 * The CLI does not always populate structured_output (observed with --agents + --json-schema),
 * so the runner falls back to the text; validation still runs on the parsed object.
 */
export function extractJsonObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const value: unknown = JSON.parse(candidate.slice(start, end + 1));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface RateLimitInfo {
  status: string;
  /** Top-level reset of the window the CLI is reporting on (epoch seconds). */
  resetsAt: number | null;
  fiveHourUtilization: number | null;
  fiveHourResetsAt: number | null;
  sevenDayUtilization: number | null;
  sevenDayResetsAt: number | null;
}

export interface ResultSummary {
  found: boolean;
  isError: boolean;
  subtype: string | null;
  numTurns: number;
  durationMs: number;
  costUsd: number | null;
  usage: Usage;
  sessionId: string | null;
  resultText: string | null;
  /** Parsed --json-schema output (CLI 2.1.281 puts it in result.structured_output). */
  structuredOutput: unknown | null;
  /** Where structuredOutput came from; null when the result had neither. */
  structuredSource: 'structured_output' | 'text' | null;
  /** e.g. "completed", "rapid_refill_breaker"; the CLI may report is_error=true with subtype "success". */
  terminalReason: string | null;
  /** HTTP status of the failing API call when the CLI reports one (401 auth, 429 quota). */
  apiErrorStatus: number | null;
  /** Latest rate_limit_event in the stream (subscription usage windows). */
  rateLimit: RateLimitInfo | null;
  compactions: number;
}

const ResultEvent = z
  .object({
    type: z.literal('result'),
    subtype: z.string().optional(),
    is_error: z.boolean().optional(),
    duration_ms: z.number().optional(),
    num_turns: z.number().optional(),
    result: z.string().optional(),
    session_id: z.string().optional(),
    total_cost_usd: z.number().optional(),
    structured_output: z.unknown().optional(),
    terminal_reason: z.string().nullable().optional(),
    api_error_status: z.number().nullable().optional(),
    usage: z
      .object({
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
        cache_read_input_tokens: z.number().optional(),
        cache_creation_input_tokens: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

const RateLimitEvent = z
  .object({
    type: z.literal('rate_limit_event'),
    rate_limit_info: z
      .object({
        status: z.string(),
        resetsAt: z.number().optional(),
        unifiedWindows: z
          .object({
            five_hour: z.object({ utilization: z.number().optional(), resetsAt: z.number().optional() }).optional(),
            seven_day: z.object({ utilization: z.number().optional(), resetsAt: z.number().optional() }).optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

const AssistantUsage = z
  .object({
    type: z.literal('assistant'),
    message: z
      .object({
        id: z.string().optional(),
        usage: z
          .object({
            input_tokens: z.number().optional(),
            output_tokens: z.number().optional(),
            cache_read_input_tokens: z.number().optional(),
            cache_creation_input_tokens: z.number().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

/** Usage of a killed step: assistant messages carry usage per message id (one entry per content block). */
function partialUsage(events: readonly StreamEvent[]): { usage: Usage; turns: number } {
  const seen = new Map<string, Usage>();
  let anonymous = 0;
  for (const e of events) {
    const parsed = AssistantUsage.safeParse(e);
    if (!parsed.success) continue;
    const id = parsed.data.message.id ?? `anon-${anonymous++}`;
    const u = parsed.data.message.usage;
    if (!u) {
      if (!seen.has(id)) seen.set(id, { ...ZERO_USAGE });
      continue;
    }
    seen.set(id, {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    });
  }
  const usage = { ...ZERO_USAGE };
  for (const u of seen.values()) {
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;
    usage.cacheReadTokens += u.cacheReadTokens;
    usage.cacheWriteTokens += u.cacheWriteTokens;
  }
  return { usage, turns: seen.size };
}

function latestRateLimit(events: readonly StreamEvent[]): RateLimitInfo | null {
  const raw = [...events].reverse().find((e) => e.type === 'rate_limit_event');
  const parsed = raw ? RateLimitEvent.safeParse(raw) : null;
  if (!parsed || !parsed.success) return null;
  const info = parsed.data.rate_limit_info;
  return {
    status: info.status,
    resetsAt: info.resetsAt ?? null,
    fiveHourUtilization: info.unifiedWindows?.five_hour?.utilization ?? null,
    fiveHourResetsAt: info.unifiedWindows?.five_hour?.resetsAt ?? null,
    sevenDayUtilization: info.unifiedWindows?.seven_day?.utilization ?? null,
    sevenDayResetsAt: info.unifiedWindows?.seven_day?.resetsAt ?? null,
  };
}

export function summarizeStream(parsed: ParsedStream): ResultSummary {
  const compactions = parsed.events.filter((e) => e.type === 'system' && e.subtype === 'compact_boundary').length;
  const sessionId = parsed.events.find((e) => typeof e.session_id === 'string')?.session_id ?? null;
  const rateLimit = latestRateLimit(parsed.events);
  const raw = [...parsed.events].reverse().find((e) => e.type === 'result');
  const result = raw ? ResultEvent.safeParse(raw) : null;
  if (!result || !result.success) {
    const partial = partialUsage(parsed.events);
    return {
      found: false,
      isError: true,
      subtype: null,
      numTurns: partial.turns,
      durationMs: 0,
      costUsd: null,
      usage: partial.usage,
      sessionId,
      resultText: null,
      structuredOutput: null,
      structuredSource: null,
      terminalReason: null,
      apiErrorStatus: null,
      rateLimit,
      compactions,
    };
  }
  const r = result.data;
  const fromText = r.structured_output === undefined ? extractJsonObject(r.result ?? null) : null;
  const structuredOutput = r.structured_output ?? fromText;
  const structuredSource = r.structured_output !== undefined ? 'structured_output' : fromText ? 'text' : null;
  return {
    found: true,
    isError: r.is_error ?? r.subtype !== 'success',
    subtype: r.subtype ?? null,
    numTurns: r.num_turns ?? 0,
    durationMs: r.duration_ms ?? 0,
    costUsd: r.total_cost_usd ?? null,
    usage: {
      inputTokens: r.usage?.input_tokens ?? 0,
      outputTokens: r.usage?.output_tokens ?? 0,
      cacheReadTokens: r.usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: r.usage?.cache_creation_input_tokens ?? 0,
    },
    sessionId: r.session_id ?? sessionId,
    resultText: r.result ?? null,
    structuredOutput: structuredOutput ?? null,
    structuredSource,
    terminalReason: r.terminal_reason ?? null,
    apiErrorStatus: r.api_error_status ?? null,
    rateLimit,
    compactions,
  };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/runner/stream-events.test.ts && npm run typecheck`
Expected: 19 tests PASS; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add server/runner/stream-events.ts test/runner/stream-events.test.ts test/fixtures/stream
git commit -m "feat: extend stream summary with text fallback, partial usage and api status" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Budget accounting and `runStep`

**Files:**
- Create: `server/budget/accounting.ts`, `server/runner/step.ts`
- Test: `test/budget/accounting.test.ts`, `test/runner/step.test.ts`

**Interfaces:**
- Consumes: `buildInvocation`, `ensureTrusted` (Task 1); `AgentDefinition` (Task 2); `OUTPUT_SCHEMAS`, `toJsonSchema`, `StepKind` (Task 3); `runProcess`, `RunnerBinary`, `ProcessCaps` (Task 4); `validateAgentOutput`, `RefContext`, `References` (Plan 1 Task 7); `FailureKind` (Plan 1 Task 6); `Usage`, `ResultSummary` (Plan 2 Task 2); `ProviderProfile`, `Role` (Plan 2 Task 3).
- Produces:
  - `interface UsageRecord { role: Role; phase: string; taskId: string | null; attempt: number; stepKind: StepKind; provider: 'claude' | 'omniroute'; model: string; usage: Usage; costUsd: number | null; durationMs: number; numTurns: number; at: string }`
  - `class Accounting { record(r: UsageRecord): void; total(filter?: Partial<Pick<UsageRecord, 'role' | 'phase' | 'taskId' | 'provider'>>): Usage & { costUsd: number; steps: number }; records(): readonly UsageRecord[]; tokensOf(u: Usage): number }` — `tokensOf` = input + output + cacheRead + cacheWrite
  - `interface StepRequest { kind: StepKind; role: Role; agent: AgentDefinition; profile: ProviderProfile; model: string; cwd: string; prompt: string; expectedSpecHash: string; refContext?: RefContext; refs?: (value: never) => References; semantic?: ReadonlyArray<(value: never) => string[]>; phase: string; taskId: string | null; attempt: number; sessionId?: string; resume?: boolean; omniroute?: { baseUrl: string; token: string; compactWindow?: number } }`
  - `type StepOutcome<T> = { ok: true; value: T; summary: ResultSummary } | { ok: false; failure: FailureKind; errors: string[]; summary: ResultSummary; sandboxDisabled: boolean }`
  - `interface StepDeps { binary: RunnerBinary; caps: ProcessCaps; accounting: Accounting; claudeJsonPath: string; hostEnv?: NodeJS.ProcessEnv; onEvent?: (line: string) => void; clock?: () => Date }`
  - `runStep<K extends StepKind>(req: StepRequest, deps: StepDeps): Promise<StepOutcome<OutputOf<K>>>`
  - `classifyFailure(raw: RawStepResult): FailureKind | null` — `null` means the process result itself is not a failure

Classification order (findings rows 3, 4, 7 and spec §12): sandbox disabled → `environment`; killed by timeout/turns → `timeout`; compaction (`compactions > 0` or `terminalReason === 'rapid_refill_breaker'`) → `compaction`; `rateLimit.status !== 'allowed'` or result text matching `/usage limit|rate limit|out of .*quota/i` → `quota`; result text matching `/not logged in|authentication|invalid api key|login/i` with `isError` → `auth`; `found === false` or `isError` → `code` (the step ran and failed for reasons the agent must handle); otherwise `null`. The `DevOutput.status === 'spec-gap'` case is a success at this layer; Plan 6 routes it.

- [ ] **Step 1: Write the failing accounting test**

`test/budget/accounting.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { Accounting, type UsageRecord } from '../../server/budget/accounting.js';

const rec = (over: Partial<UsageRecord>): UsageRecord => ({
  role: 'dev',
  phase: 'tasks',
  taskId: 'T1-create',
  attempt: 1,
  stepKind: 'dev',
  provider: 'claude',
  model: 'opus',
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 50 },
  costUsd: 0.01,
  durationMs: 1000,
  numTurns: 2,
  at: '2026-09-24T10:00:00.000Z',
  ...over,
});

describe('Accounting', () => {
  it('sums usage, cost and steps', () => {
    const acc = new Accounting();
    acc.record(rec({}));
    acc.record(rec({ attempt: 2, costUsd: 0.02 }));
    expect(acc.total()).toEqual({ inputTokens: 20, outputTokens: 10, cacheReadTokens: 200, cacheWriteTokens: 100, costUsd: 0.03, steps: 2 });
  });

  it('filters by role, phase, task and provider', () => {
    const acc = new Accounting();
    acc.record(rec({}));
    acc.record(rec({ role: 'test', stepKind: 'review', provider: 'omniroute', costUsd: null }));
    expect(acc.total({ role: 'test' }).steps).toBe(1);
    expect(acc.total({ provider: 'omniroute' }).costUsd).toBe(0);
    expect(acc.total({ taskId: 'T9-none' }).steps).toBe(0);
  });

  it('counts every token class in tokensOf', () => {
    expect(new Accounting().tokensOf({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 })).toBe(10);
  });

  it('exposes an immutable copy of the records', () => {
    const acc = new Accounting();
    acc.record(rec({}));
    const list = acc.records();
    expect(list).toHaveLength(1);
    expect(() => (list as UsageRecord[]).push(rec({}))).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/budget/accounting.test.ts`
Expected: FAIL — cannot resolve `../../server/budget/accounting.js`.

- [ ] **Step 3: Write accounting**

`server/budget/accounting.ts`:
```ts
import type { StepKind } from '../agents/outputs.js';
import type { Role } from '../config/config.js';
import type { Usage } from '../runner/stream-events.js';

export interface UsageRecord {
  role: Role;
  phase: string;
  taskId: string | null;
  attempt: number;
  stepKind: StepKind;
  provider: 'claude' | 'omniroute';
  model: string;
  usage: Usage;
  costUsd: number | null;
  durationMs: number;
  numTurns: number;
  at: string;
}

type Filter = Partial<Pick<UsageRecord, 'role' | 'phase' | 'taskId' | 'provider'>>;

export class Accounting {
  private readonly list: UsageRecord[] = [];

  record(r: UsageRecord): void {
    this.list.push({ ...r, usage: { ...r.usage } });
  }

  records(): readonly UsageRecord[] {
    return Object.freeze([...this.list]);
  }

  tokensOf(u: Usage): number {
    return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  }

  total(filter: Filter = {}): Usage & { costUsd: number; steps: number } {
    const out = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, steps: 0 };
    for (const r of this.list) {
      if (filter.role !== undefined && r.role !== filter.role) continue;
      if (filter.phase !== undefined && r.phase !== filter.phase) continue;
      if (filter.taskId !== undefined && r.taskId !== filter.taskId) continue;
      if (filter.provider !== undefined && r.provider !== filter.provider) continue;
      out.inputTokens += r.usage.inputTokens;
      out.outputTokens += r.usage.outputTokens;
      out.cacheReadTokens += r.usage.cacheReadTokens;
      out.cacheWriteTokens += r.usage.cacheWriteTokens;
      out.costUsd += r.costUsd ?? 0;
      out.steps += 1;
    }
    out.costUsd = Math.round(out.costUsd * 1e6) / 1e6;
    return out;
  }
}
```

- [ ] **Step 4: Run the accounting test**

Run: `npx vitest run test/budget/accounting.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Write the failing step test**

`test/runner/step.test.ts`:
```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseAgentFile } from '../../server/agents/registry.js';
import { Accounting } from '../../server/budget/accounting.js';
import type { RawStepResult } from '../../server/runner/process-runner.js';
import { classifyFailure, runStep, type StepDeps, type StepRequest } from '../../server/runner/step.js';
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
  profile: { provider: 'claude', model: 'opus' },
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

const okValue = { specHash: HASH, status: 'done', summary: 'did it', commitMessage: 'feat: x', changedFiles: ['src/a.ts'] };
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

  it('classifies a kill by timeout and keeps the partial usage', async () => {
    withFake({ FAKE_CLAUDE_FIXTURE: fixture('killed-partial'), FAKE_CLAUDE_HANG_AFTER: '4' });
    const outcome = await runStep(request(), { ...deps, caps: { ...deps.caps, timeoutMs: 300 } });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure).toBe('timeout');
    expect(deps.accounting.total().outputTokens).toBe(50);
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

  it('trusts the working directory and writes the role settings before spawning', async () => {
    const capture = path.join(dir, 'capture.json');
    withFake({ FAKE_CLAUDE_FIXTURE: fixture('success'), FAKE_CLAUDE_CAPTURE: capture });
    await runStep(request(), deps);
    const json = JSON.parse(await fs.readFile(deps.claudeJsonPath, 'utf8'));
    expect(json.projects[await fs.realpath(dir)].hasTrustDialogAccepted).toBe(true);
    const captured = JSON.parse(await fs.readFile(capture, 'utf8'));
    const settingsPath = captured.argv[captured.argv.indexOf('--settings') + 1];
    expect(settingsPath).toBe(path.join(deps.settingsDir, 'dev.settings.json'));
    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    expect(settings.sandbox).toEqual({ enabled: true, network: { allowedDomains: ['registry.npmjs.org'] } });
    expect(settings.permissions.deny).toContain('Write(.claude/**)');
    expect(captured.prompt).toBe('Implement it');
  });

  it('sends the role agent definition inline with the step model', async () => {
    const capture = path.join(dir, 'capture.json');
    withFake({ FAKE_CLAUDE_FIXTURE: fixture('success'), FAKE_CLAUDE_CAPTURE: capture });
    await runStep(request({ model: 'sonnet' }), deps);
    const captured = JSON.parse(await fs.readFile(capture, 'utf8'));
    const agents = JSON.parse(captured.argv[captured.argv.indexOf('--agents') + 1]);
    expect(agents.dev).toMatchObject({ prompt: devAgent.body, tools: devAgent.tools, model: 'sonnet' });
  });

  it('returns an environment failure when the working directory does not exist, without trusting it', async () => {
    const missing = path.join(dir, 'missing');
    const outcome = await runStep(request({ cwd: missing }), deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure).toBe('environment');
    await expect(fs.readFile(deps.claudeJsonPath, 'utf8')).rejects.toThrow();
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

  it('maps a missing result to code and a kill to timeout', () => {
    expect(classifyFailure(raw('{"type":"system","subtype":"init"}'))).toBe('code');
    expect(classifyFailure(raw('{"type":"system","subtype":"init"}', { killedBy: 'turns' }))).toBe('timeout');
    expect(classifyFailure(raw('{"type":"system","subtype":"init"}', { killedBy: 'environment', sandboxDisabled: true }))).toBe('environment');
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/runner/step.test.ts`
Expected: FAIL — cannot resolve `../../server/runner/step.js`.

- [ ] **Step 7: Write runStep**

`server/runner/step.ts`:
```ts
import { promises as fs } from 'node:fs';
import { OUTPUT_SCHEMAS, toJsonSchema, type OutputOf, type StepKind } from '../agents/outputs.js';
import type { AgentDefinition } from '../agents/registry.js';
import { ALWAYS_DENIED } from '../agents/registry.js';
import type { Accounting } from '../budget/accounting.js';
import type { ProviderProfile, Role } from '../config/config.js';
import type { FailureKind } from '../scheduler/retry-policy.js';
import { validateAgentOutput } from '../validators/agent-output.js';
import type { RefContext, References } from '../validators/references.js';
import { buildInvocation, ensureTrusted } from './invocation.js';
import { preflightSandbox, runProcess, type ProcessCaps, type RawStepResult, type RunnerBinary } from './process-runner.js';
import { writeRoleSettings, type RoleSettingsInput } from './role-settings.js';
import type { ResultSummary } from './stream-events.js';

export interface StepRequest {
  kind: StepKind;
  role: Role;
  agent: AgentDefinition;
  profile: ProviderProfile;
  model: string;
  cwd: string;
  prompt: string;
  expectedSpecHash: string;
  refContext?: RefContext;
  refs?: (value: never) => References;
  semantic?: ReadonlyArray<(value: never) => string[]>;
  phase: string;
  taskId: string | null;
  attempt: number;
  sessionId?: string;
  resume?: boolean;
  omniroute?: { baseUrl: string; token: string; compactWindow?: number };
  /** Extra allow rules for this step's role settings (from the plan's commands). */
  extraAllow?: readonly string[];
}

export type StepOutcome<T> =
  | { ok: true; value: T; summary: ResultSummary }
  | { ok: false; failure: FailureKind; errors: string[]; summary: ResultSummary; sandboxDisabled: boolean };

export interface StepDeps {
  binary: RunnerBinary;
  caps: ProcessCaps;
  accounting: Accounting;
  claudeJsonPath: string;
  /** Directory (outside any worktree) where per-role settings files are written. */
  settingsDir: string;
  network: Pick<RoleSettingsInput, 'allowedDomains'>;
  hostEnv?: NodeJS.ProcessEnv;
  onEvent?: (line: string) => void;
  clock?: () => Date;
}

const QUOTA_TEXT = /usage limit|rate limit|out of .*quota/i;
const AUTH_TEXT = /not logged in|authentication|invalid api key|please run claude login/i;

/**
 * Order follows spec §12 and the CLI findings: environment → timeout → compaction → (only for a
 * failed step) quota → auth → code. A successful result is never reclassified by its rate-limit
 * reading; that reading goes to the breaker separately.
 */
export function classifyFailure(raw: RawStepResult): FailureKind | null {
  const s = raw.summary;
  if (raw.sandboxDisabled || raw.killedBy === 'environment') return 'environment';
  if (raw.killedBy) return 'timeout';
  if (s.compactions > 0 || s.terminalReason === 'rapid_refill_breaker') return 'compaction';
  if (s.found && !s.isError) return null;
  const text = s.resultText ?? '';
  if (s.apiErrorStatus === 429) return 'quota';
  if (s.apiErrorStatus === 401 || s.apiErrorStatus === 403) return 'auth';
  if (s.apiErrorStatus === null) {
    if ((s.rateLimit && s.rateLimit.status !== 'allowed') || QUOTA_TEXT.test(text)) return 'quota';
    if (AUTH_TEXT.test(text)) return 'auth';
  }
  return 'code';
}

const EMPTY_SUMMARY: ResultSummary = {
  found: false,
  isError: true,
  subtype: null,
  numTurns: 0,
  durationMs: 0,
  costUsd: null,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  sessionId: null,
  resultText: null,
  structuredOutput: null,
  structuredSource: null,
  terminalReason: null,
  apiErrorStatus: null,
  rateLimit: null,
  compactions: 0,
};

function environmentFailure<T>(message: string): StepOutcome<T> {
  return { ok: false, failure: 'environment', errors: [message], summary: EMPTY_SUMMARY, sandboxDisabled: false };
}

export async function runStep<K extends StepKind>(req: StepRequest, deps: StepDeps): Promise<StepOutcome<OutputOf<K>>> {
  const hostEnv = deps.hostEnv ?? process.env;
  try {
    const stat = await fs.stat(req.cwd);
    if (!stat.isDirectory()) return environmentFailure(`cwd is not a directory: ${req.cwd}`);
  } catch {
    return environmentFailure(`cwd does not exist: ${req.cwd}`);
  }
  if (deps.binary.requireSandboxTools) {
    const missing = await preflightSandbox(hostEnv);
    if (missing.length > 0) return environmentFailure(`sandbox tools missing on PATH: ${missing.join(', ')} (apt install bubblewrap socat)`);
  }

  await ensureTrusted(req.cwd, deps.claudeJsonPath);
  const settingsPath = await writeRoleSettings(deps.settingsDir, req.role, { allowedDomains: deps.network.allowedDomains, extraAllow: req.extraAllow });
  const invocation = buildInvocation(
    {
      role: req.role,
      model: req.model,
      profile: req.profile,
      cwd: req.cwd,
      prompt: req.prompt,
      jsonSchema: toJsonSchema(req.kind),
      tools: req.agent.tools,
      disallowedTools: ALWAYS_DENIED,
      settingsPath,
      sessionId: req.sessionId,
      resume: req.resume,
      omniroute: req.omniroute,
      agentDefinition: req.agent,
    },
    hostEnv,
  );

  let raw: RawStepResult;
  try {
    raw = await runProcess(deps.binary, invocation, deps.caps, deps.onEvent);
  } catch (err) {
    return environmentFailure(`spawn failed: ${(err as Error).message}`);
  }

  deps.accounting.record({
    role: req.role,
    phase: req.phase,
    taskId: req.taskId,
    attempt: req.attempt,
    stepKind: req.kind,
    provider: req.profile.provider,
    model: req.model,
    usage: raw.summary.usage,
    costUsd: raw.summary.costUsd,
    durationMs: raw.durationMs,
    numTurns: raw.summary.numTurns || raw.turns,
    at: (deps.clock ?? (() => new Date()))().toISOString(),
  });

  const failure = classifyFailure(raw);
  if (failure) {
    return { ok: false, failure, errors: [raw.summary.resultText ?? raw.stderr.slice(0, 500)], summary: raw.summary, sandboxDisabled: raw.sandboxDisabled };
  }

  const schema = OUTPUT_SCHEMAS[req.kind];
  const validation = validateAgentOutput(schema, raw.summary.structuredOutput, {
    expectedSpecHash: req.expectedSpecHash,
    refs: req.refs as ((value: { specHash: string }) => References) | undefined,
    refContext: req.refContext,
    semantic: req.semantic as ReadonlyArray<(value: { specHash: string }) => string[]> | undefined,
  });
  if (!validation.ok) {
    return { ok: false, failure: 'schema', errors: validation.errors, summary: raw.summary, sandboxDisabled: false };
  }
  return { ok: true, value: validation.value as OutputOf<K>, summary: raw.summary };
}
```

- [ ] **Step 8: Run tests and typecheck**

Run: `npx vitest run test/budget/accounting.test.ts test/runner/step.test.ts && npm run typecheck`
Expected: 21 tests PASS (accounting 4, step 17); typecheck exits 0.

- [ ] **Step 9: Commit**

```bash
git add server/budget/accounting.ts server/runner/step.ts test/budget/accounting.test.ts test/runner/step.test.ts
git commit -m "feat: add usage accounting and runStep with failure classification" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Concurrency governor and proactive quota breaker

**Files:**
- Create: `server/budget/governor.ts`, `server/budget/quota-breaker.ts`
- Test: `test/budget/governor.test.ts`, `test/budget/quota-breaker.test.ts`

**Interfaces:**
- Consumes: `RateLimitInfo` (Plan 2 Task 2).
- Produces:
  - `class Governor { constructor(limit: number); acquire(): Promise<() => void>; setLimit(n: number): void; get limit(): number; get active(): number; get waiting(): number }`
  - `interface BreakerConfig { pauseThreshold: number; probeBackoffMinutes: readonly number[] }`, `DEFAULT_BREAKER: BreakerConfig = { pauseThreshold: 0.95, probeBackoffMinutes: [5, 10, 20, 40, 60] }`
  - `type BreakerState = { status: 'closed' } | { status: 'paused'; until: Date; reason: 'window' | 'rejected' | 'probe' }`
  - `class QuotaBreaker { constructor(cfg?: BreakerConfig, clock?: () => Date); observe(info: RateLimitInfo | null): void; onQuotaFailure(info: RateLimitInfo | null): void; canStart(): boolean; state(): BreakerState; tick(): void }`

Behavior (findings row 7, spec §8.7): `observe` after every step — if any window utilization ≥ `pauseThreshold` or `status !== 'allowed'`, pause until that window's `resetsAt` (epoch seconds → Date). `onQuotaFailure` without a usable `resetsAt` pauses for the next backoff value (5, 10, 20, 40, 60 min, then stays at 60). A successful `observe` with utilization below the threshold after a pause resets the backoff index. `tick()` closes the breaker once `until` has passed.

- [ ] **Step 1: Write the failing governor test**

`test/budget/governor.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { Governor } from '../../server/budget/governor.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('Governor', () => {
  it('lets `limit` tasks run at once and queues the rest', async () => {
    const g = new Governor(2);
    const r1 = await g.acquire();
    const r2 = await g.acquire();
    let third = false;
    const p3 = g.acquire().then((release) => {
      third = true;
      return release;
    });
    await flush();
    expect(third).toBe(false);
    expect(g.active).toBe(2);
    expect(g.waiting).toBe(1);
    r1();
    const r3 = await p3;
    expect(third).toBe(true);
    r2();
    r3();
    expect(g.active).toBe(0);
  });

  it('lowering the limit takes effect as slots free up', async () => {
    const g = new Governor(3);
    const a = await g.acquire();
    const b = await g.acquire();
    g.setLimit(1);
    let got = false;
    const p = g.acquire().then((r) => {
      got = true;
      return r;
    });
    a();
    await flush();
    expect(got).toBe(false); // still 1 active, limit 1
    b();
    const c = await p;
    expect(got).toBe(true);
    c();
  });

  it('release is idempotent', async () => {
    const g = new Governor(1);
    const r = await g.acquire();
    r();
    r();
    expect(g.active).toBe(0);
  });

  it('rejects a non-positive limit', () => {
    expect(() => new Governor(0)).toThrow(RangeError);
    expect(() => new Governor(1).setLimit(0)).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/budget/governor.test.ts`
Expected: FAIL — cannot resolve `../../server/budget/governor.js`.

- [ ] **Step 3: Write the governor**

`server/budget/governor.ts`:
```ts
/** Async semaphore for concurrent claude processes (spec §8.6). */
export class Governor {
  private current: number;
  private running = 0;
  private readonly queue: Array<() => void> = [];

  constructor(limit: number) {
    this.current = Governor.check(limit);
  }

  private static check(n: number): number {
    if (!Number.isInteger(n) || n < 1) throw new RangeError(`limit must be a positive integer, got ${n}`);
    return n;
  }

  get limit(): number {
    return this.current;
  }

  get active(): number {
    return this.running;
  }

  get waiting(): number {
    return this.queue.length;
  }

  setLimit(n: number): void {
    this.current = Governor.check(n);
    this.drain();
  }

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      this.queue.push(() => resolve(this.makeRelease()));
      this.drain();
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running -= 1;
      this.drain();
    };
  }

  private drain(): void {
    while (this.running < this.current && this.queue.length > 0) {
      this.running += 1;
      this.queue.shift()!();
    }
  }
}
```

- [ ] **Step 4: Run the governor test**

Run: `npx vitest run test/budget/governor.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Write the failing breaker test**

`test/budget/quota-breaker.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_BREAKER, QuotaBreaker } from '../../server/budget/quota-breaker.js';
import type { RateLimitInfo } from '../../server/runner/stream-events.js';

const T0 = new Date('2026-09-24T10:00:00.000Z');
const epoch = (d: Date) => Math.floor(d.getTime() / 1000);
const FIVE_H_RESET = new Date('2026-09-24T12:00:00.000Z');
const SEVEN_D_RESET = new Date('2026-09-26T00:00:00.000Z');
const info = (over: Partial<RateLimitInfo> = {}): RateLimitInfo => ({
  status: 'allowed',
  resetsAt: epoch(FIVE_H_RESET),
  fiveHourUtilization: 0.1,
  fiveHourResetsAt: epoch(FIVE_H_RESET),
  sevenDayUtilization: 0.64,
  sevenDayResetsAt: epoch(SEVEN_D_RESET),
  ...over,
});

/** A settable fake clock: the breaker may read it more than once per call. */
function breaker(start = T0) {
  const clock = { now: start };
  return { b: new QuotaBreaker(DEFAULT_BREAKER, () => clock.now), clock };
}

describe('QuotaBreaker', () => {
  it('stays closed while every window is under the threshold', () => {
    const { b } = breaker();
    b.observe(info());
    expect(b.canStart()).toBe(true);
    expect(b.state()).toEqual({ status: 'closed' });
  });

  it('pauses until the reset of a window at or above the threshold', () => {
    const { b } = breaker();
    b.observe(info({ fiveHourUtilization: 0.97 }));
    expect(b.canStart()).toBe(false);
    expect(b.state()).toEqual({ status: 'paused', until: FIVE_H_RESET, reason: 'window' });
  });

  it('pauses on a rejected status even with low utilization, using the top-level reset', () => {
    const { b } = breaker();
    b.observe(info({ status: 'rejected', fiveHourUtilization: 0.2 }));
    expect(b.state()).toEqual({ status: 'paused', until: FIVE_H_RESET, reason: 'rejected' });
  });

  it('closes again once the reset time has passed', () => {
    const { b, clock } = breaker();
    b.observe(info({ fiveHourUtilization: 1 }));
    expect(b.canStart()).toBe(false);
    clock.now = new Date('2026-09-24T12:00:01.000Z');
    expect(b.canStart()).toBe(true);
  });

  it('ignores a healthy reading while paused (it may come from a step that started earlier)', () => {
    const { b } = breaker();
    b.observe(info({ status: 'rejected' }));
    b.observe(info({ status: 'allowed', fiveHourUtilization: 0.6 }));
    expect(b.canStart()).toBe(false);
    expect(b.state()).toMatchObject({ status: 'paused', reason: 'rejected' });
  });

  it('uses backoff probes when a quota failure carries no reset time', () => {
    const { b, clock } = breaker();
    b.onQuotaFailure(null);
    expect(b.state()).toEqual({ status: 'paused', until: new Date('2026-09-24T10:05:00.000Z'), reason: 'probe' });
    clock.now = new Date('2026-09-24T10:05:00.000Z');
    b.onQuotaFailure(null);
    expect(b.state()).toEqual({ status: 'paused', until: new Date('2026-09-24T10:15:00.000Z'), reason: 'probe' });
  });

  it('caps the backoff at the last value and resets the ladder after the pause ends with a healthy reading', () => {
    const { b, clock } = breaker();
    for (let i = 0; i < 7; i++) {
      const s = b.state();
      if (s.status === 'paused') clock.now = s.until; // each probe fails right when it fires
      b.onQuotaFailure(null);
    }
    // 5 + 10 + 20 + 40 + 60 + 60 + 60 minutes after T0
    expect(b.state()).toEqual({ status: 'paused', until: new Date('2026-09-24T14:15:00.000Z'), reason: 'probe' });
    clock.now = new Date('2026-09-24T14:15:00.000Z');
    b.observe(info());
    expect(b.canStart()).toBe(true);
    b.onQuotaFailure(null);
    expect(b.state()).toMatchObject({ until: new Date('2026-09-24T14:20:00.000Z') });
  });

  it('on a quota failure prefers the exhausted window reset over an earlier healthy one', () => {
    const { b } = breaker();
    b.onQuotaFailure(info({ status: 'rejected', sevenDayUtilization: 1, fiveHourUtilization: 0.3 }));
    expect(b.state()).toEqual({ status: 'paused', until: SEVEN_D_RESET, reason: 'rejected' });
  });

  it('on a quota failure falls back to the top-level resetsAt when no window is exhausted', () => {
    const { b } = breaker();
    b.onQuotaFailure(info({ status: 'rejected', resetsAt: epoch(new Date('2026-09-24T10:30:00.000Z')) }));
    expect(b.state()).toEqual({ status: 'paused', until: new Date('2026-09-24T10:30:00.000Z'), reason: 'rejected' });
  });

  it('does not shorten an existing longer pause with a later quota failure', () => {
    const { b } = breaker();
    b.observe(info({ sevenDayUtilization: 1 }));
    expect(b.state()).toMatchObject({ until: SEVEN_D_RESET });
    b.onQuotaFailure(info({ status: 'rejected', sevenDayUtilization: 0.5 }));
    expect(b.state()).toMatchObject({ until: SEVEN_D_RESET });
  });

  it('picks the earliest reset among exhausted windows', () => {
    const { b } = breaker();
    b.observe(info({ fiveHourUtilization: 0.99, sevenDayUtilization: 0.99 }));
    expect(b.state()).toMatchObject({ until: FIVE_H_RESET });
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/budget/quota-breaker.test.ts`
Expected: FAIL — cannot resolve `../../server/budget/quota-breaker.js`.

- [ ] **Step 7: Write the breaker**

`server/budget/quota-breaker.ts`:
```ts
import type { RateLimitInfo } from '../runner/stream-events.js';

export interface BreakerConfig {
  /** Window utilization at or above which the orchestrator stops starting steps. */
  pauseThreshold: number;
  probeBackoffMinutes: readonly number[];
}

export const DEFAULT_BREAKER: BreakerConfig = { pauseThreshold: 0.95, probeBackoffMinutes: [5, 10, 20, 40, 60] };

export type BreakerState = { status: 'closed' } | { status: 'paused'; until: Date; reason: 'window' | 'rejected' | 'probe' };

/**
 * Proactive quota circuit breaker (spec §8.7, findings row 7): every CLI run reports the
 * subscription windows, so the orchestrator pauses before a step would be rejected.
 *
 * While paused, only `tick()` (time passing) closes the breaker: a healthy reading may belong to
 * a step that started before the pause. A pause is never shortened by a later reading.
 */
export class QuotaBreaker {
  private current: BreakerState = { status: 'closed' };
  private backoffIndex = 0;

  constructor(
    private readonly cfg: BreakerConfig = DEFAULT_BREAKER,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  state(): BreakerState {
    return this.current;
  }

  canStart(): boolean {
    this.tick();
    return this.current.status === 'closed';
  }

  tick(): void {
    if (this.current.status === 'paused' && this.clock() >= this.current.until) this.current = { status: 'closed' };
  }

  observe(info: RateLimitInfo | null): void {
    if (!info) return;
    this.tick();
    const exhausted = this.exhaustedResets(info);
    if (info.status !== 'allowed') {
      const reset = exhausted[0] ?? this.topLevelReset(info);
      this.pauseUntil(reset ?? this.nextProbe(), reset ? 'rejected' : 'probe');
      return;
    }
    if (exhausted.length > 0) {
      this.pauseUntil(exhausted[0]!, 'window');
      return;
    }
    if (this.current.status === 'closed') this.backoffIndex = 0;
  }

  onQuotaFailure(info: RateLimitInfo | null): void {
    this.tick();
    const reset = info ? (this.exhaustedResets(info)[0] ?? this.topLevelReset(info)) : null;
    this.pauseUntil(reset ?? this.nextProbe(), reset ? 'rejected' : 'probe');
  }

  /** Extends the pause; never shortens one already in place. */
  private pauseUntil(until: Date, reason: 'window' | 'rejected' | 'probe'): void {
    if (this.current.status === 'paused' && this.current.until > until) return;
    this.current = { status: 'paused', until, reason };
  }

  private nextProbe(): Date {
    const minutes = this.cfg.probeBackoffMinutes[Math.min(this.backoffIndex, this.cfg.probeBackoffMinutes.length - 1)]!;
    this.backoffIndex += 1;
    return new Date(this.clock().getTime() + minutes * 60_000);
  }

  private topLevelReset(info: RateLimitInfo): Date | null {
    return typeof info.resetsAt === 'number' ? new Date(info.resetsAt * 1000) : null;
  }

  private exhaustedResets(info: RateLimitInfo): Date[] {
    const windows: Array<[number | null, number | null]> = [
      [info.fiveHourUtilization, info.fiveHourResetsAt],
      [info.sevenDayUtilization, info.sevenDayResetsAt],
    ];
    return windows
      .filter(([u, r]) => u !== null && r !== null && u >= this.cfg.pauseThreshold)
      .map(([, r]) => new Date((r as number) * 1000))
      .sort((a, b) => a.getTime() - b.getTime());
  }
}
```

- [ ] **Step 8: Run tests and typecheck**

Run: `npx vitest run test/budget && npm run typecheck`
Expected: 19 tests PASS (accounting 4, governor 4, breaker 11); typecheck exits 0.

- [ ] **Step 9: Run the full suite and commit**

Run: `npm test && npm run typecheck`
Expected: 27 test files, 277 tests PASS (Plan 1 + Plan 2 + this plan); typecheck exits 0.

```bash
git add server/budget/governor.ts server/budget/quota-breaker.ts test/budget
git commit -m "feat: add concurrency governor and proactive quota breaker" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Real-CLI smoke and OmniRoute probe (manual, WSL)

Runs inside Ubuntu after the code above is merged and pulled into `~/workspace/teams-ai`.

**Files:**
- Create: `scripts/wsl/omniroute/up.sh`, `scripts/wsl/omniroute/down.sh`, `scripts/smoke/real-step.ts`
- Modify: `docs/superpowers/spikes/2026-09-23-cli-findings.md` (row 6)

- [ ] **Step 1: Write the smoke script**

`scripts/smoke/real-step.ts` (run with `node --experimental-strip-types` or `npx tsx`; prints one line per outcome, never used in `npm test`):
```ts
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { parseAgentFile } from '../../server/agents/registry.js';
import { Accounting } from '../../server/budget/accounting.js';
import { QuotaBreaker } from '../../server/budget/quota-breaker.js';
import { runStep } from '../../server/runner/step.js';

const agent = parseAgentFile(await fs.readFile(path.resolve('.claude/agents/dev.md'), 'utf8'), 'dev');
const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-smoke-'));
const accounting = new Accounting();
const breaker = new QuotaBreaker();
const specHash = `sha256:${'a'.repeat(64)}`;

const provider = process.env.SMOKE_PROVIDER === 'omniroute' ? 'omniroute' : 'claude';
if (provider === 'omniroute' && !process.env.OMNIROUTE_TOKEN) {
  console.error('OMNIROUTE_TOKEN is required for the omniroute provider (an empty token could fall back to the subscription login)');
  process.exit(2);
}
const model = process.env.SMOKE_MODEL ?? (provider === 'omniroute' ? 'kimi/k2' : 'sonnet');

const outcome = await runStep(
  {
    kind: 'dev',
    role: 'dev',
    agent,
    profile: { provider, model },
    model,
    cwd,
    prompt: `Do not touch any file. Return status "done", summary "smoke", commitMessage "chore: smoke", changedFiles [] and specHash "${specHash}".`,
    expectedSpecHash: specHash,
    phase: 'smoke',
    taskId: null,
    attempt: 1,
    omniroute: provider === 'omniroute' ? { baseUrl: 'http://localhost:20128', token: process.env.OMNIROUTE_TOKEN!, compactWindow: 120000 } : undefined,
  },
  {
    binary: { bin: 'claude', prefixArgs: [], env: {}, requireSandboxTools: process.platform === 'linux' },
    caps: { timeoutMs: 120_000, maxTurns: 6 },
    accounting,
    claudeJsonPath: path.join(os.homedir(), '.claude.json'),
    settingsDir: path.join(os.homedir(), '.teams-ai', 'settings'),
    network: { allowedDomains: ['registry.npmjs.org'] },
    onEvent: (line) => {
      if (line.includes('"type":"result"') || line.includes('rate_limit_event')) console.error(line);
    },
  },
);
breaker.observe(outcome.summary.rateLimit);
console.log(
  JSON.stringify(
    {
      provider,
      model,
      ok: outcome.ok,
      failure: outcome.ok ? null : outcome.failure,
      errors: outcome.ok ? [] : outcome.errors.slice(0, 3),
      resultText: outcome.summary.resultText?.slice(0, 800) ?? null,
      structuredOutput: outcome.summary.structuredOutput,
      numTurns: outcome.summary.numTurns,
      usage: accounting.total(),
      breaker: breaker.state(),
    },
    null,
    2,
  ),
);
await fs.rm(cwd, { recursive: true, force: true });
```

`scripts/wsl/omniroute/up.sh`:
```bash
#!/usr/bin/env bash
# Pinned OmniRoute gateway for the non-Claude provider profile (spec §10). Never route the Claude subscription through it.
set -euo pipefail
VERSION="${OMNIROUTE_VERSION:?set OMNIROUTE_VERSION to a pinned release, e.g. 4.12.0}"
docker run -d --name omniroute --restart unless-stopped -p 127.0.0.1:20128:20128 \
  -v omniroute-data:/app/data "diegosouzapw/omniroute:${VERSION}"
echo "OmniRoute ${VERSION} on http://localhost:20128 — open the dashboard, add a free provider, pin a model, create an API key, disable compression for that key."
```

`scripts/wsl/omniroute/down.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
docker rm -f omniroute >/dev/null 2>&1 || true
echo "OmniRoute container removed (volume omniroute-data kept)"
```

Run: `bash -n scripts/wsl/omniroute/*.sh && npx tsc --noEmit && echo OK`
Expected: `OK` (the smoke script must typecheck even though it never runs in tests; add `scripts` to `tsconfig.json` `include`).

- [ ] **Step 2: Real Claude smoke (inside WSL)**

```bash
cd ~/workspace/teams-ai && git pull && npm ci && npx tsx scripts/smoke/real-step.ts
```
Expected: JSON with `ok: true` (or `failure: "schema"` with the errors listed — then the agent prompt in `.claude/agents/dev.md` needs to state the output contract more firmly; adjust and rerun), `usage.steps: 1`, `breaker: { status: 'closed' }`. Record the output in the findings document under a new "Runner smoke" heading.

- [ ] **Step 3: OmniRoute probe p6 (inside WSL)**

```bash
OMNIROUTE_VERSION=<pinned> bash scripts/wsl/omniroute/up.sh
# configure a free provider + pinned model + API key in the dashboard, compression off
OMNIROUTE_TOKEN=<key> OMNIROUTE_MODEL=<pinned model> bash scripts/wsl/probes/p6-omniroute-env.sh
SMOKE_PROVIDER=omniroute SMOKE_MODEL=<pinned model> OMNIROUTE_TOKEN=<key> npx tsx scripts/smoke/real-step.ts
```
Expected: `init.model` in the recording is the pinned non-Claude model; `structured_output` present or a `schema` failure whose errors explain what the free model got wrong. Fill row 6 of the findings table with: model used, whether `--json-schema` was honored, `X-OmniRoute-Decision` from the OmniRoute logs, and the token/cost delta versus the Claude smoke.

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke scripts/wsl/omniroute docs/superpowers/spikes tsconfig.json
git update-index --chmod=+x scripts/wsl/omniroute/*.sh
git commit -m "docs: add runner smoke, OmniRoute scripts and p6 findings" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
