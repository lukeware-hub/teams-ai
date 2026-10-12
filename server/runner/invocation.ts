import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RoleProfile, Role } from '../config/config.js';
import { updateFileAtomic } from '../core/atomic-write.js';
import type { StepKind } from '../agents/outputs.js';
import type { Effort } from '../decide/decisions/model-tier.js';
import { goProxyUrl, stackEnv } from './stacks.js';

/** Flags fixed by the CLI spike (docs/superpowers/spikes/2026-09-23-cli-findings.md). */
export const ISOLATION_FLAGS: readonly string[] = [
  '--output-format',
  'stream-json',
  '--verbose',
  '--setting-sources',
  // Never 'project': the worktree's .claude/settings*.json is agent-writable (audit M2). All policy
  // arrives through --settings; 'user' reads only the per-step empty HOME, which holds no settings.
  'user',
  '--strict-mcp-config',
  '--mcp-config',
  '{"mcpServers":{}}',
  '--exclude-dynamic-system-prompt-sections',
  '--permission-mode',
  'dontAsk',
];

/**
 * Only these host variables reach an agent process (spec §14). runStep overrides HOME
 * with an empty per-step directory (see step-home.ts), so the host credential stores are not reachable;
 * the Read deny rules in role-settings.ts PROTECTED_READ_PATHS remain as a second layer.
 */
export const ENV_ALLOWLIST: readonly string[] = ['HOME', 'PATH', 'TERM', 'LANG', 'LC_ALL', 'USER', 'SHELL', 'TMPDIR', 'TZ'];

/**
 * R11.13 slice 1: steps that never wait on a long command write their prompt cache with the 5-minute TTL (1.25x the input
 * price) instead of the subscription default of 1 hour (2x). Dev and deployment steps run suites and installs that can
 * outlast 5 minutes, which would expire the cache mid-step, so they keep the default.
 */
const SHORT_CACHE_KINDS: ReadonlySet<StepKind> = new Set<StepKind>([
  'refine', 'derive', 'coverage', 'plan', 'services-plan', 'review', 'security', 'report', 'readme', 'decide', 'spec-gap', 'replan', 'fix-tasks', 'backlog', 'spec', 'preplan', 'conflicts', 'name', 'answer',
]);

/** The `CLAUDE_CODE_PROMPT_CACHE_TTL` value for a step kind, or undefined to keep the CLI default. */
export function promptCacheTtl(kind: StepKind): '5m' | undefined {
  return SHORT_CACHE_KINDS.has(kind) ? '5m' : undefined;
}

/**
 * Fixed child environment (R11.13 slice 9), set by the orchestrator, never read from the host. Git instructions and per-turn
 * attachments (task and file-change reminders) are prompt text a step does not use: -10% of the fixed prefix, measured. The
 * rest keeps the child quiet and bounded: no feature-flag or telemetry traffic, no self-update, and API retries capped at
 * 5 (the default is 300, about 3 hours of backoff) so a 429 surfaces as a quota failure instead of a timeout.
 */
export const STEP_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
  CLAUDE_CODE_DISABLE_ATTACHMENTS: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_AUTOUPDATER: '1',
  CLAUDE_CODE_MAX_RETRIES: '5',
};

export interface InvocationInput {
  role: Role;
  model: string;
  profile: RoleProfile;
  cwd: string;
  prompt: string;
  jsonSchema: object;
  tools: readonly string[];
  disallowedTools: readonly string[];
  /** Role settings file written by the orchestrator (sandbox + permissions), passed with --settings. */
  settingsPath: string;
  sessionId?: string;
  resume?: boolean;
  /**
   * Inline agent definition (`--agents` JSON). Agents in `.claude/agents` are loaded from the
   * process cwd, which is the product worktree, so the orchestrator ships the role definition itself.
   * The step model wins over the agent file's model.
   */
  agentDefinition?: { description: string; model: string; tools: readonly string[]; body: string };
  /** Per-step empty HOME (outside the worktree); replaces the host HOME and TMPDIR in the child env. */
  home?: string;
  /** Claude Code effort level for this step (spec 10A.5 decision 11); absent means the CLI default. */
  effort?: Effort;
  /** Env entries the orchestrator sets explicitly (e.g. an ephemeral test database's DATABASE_URL), never read
   * from the host: these are not secrets leaking in, they are resources the orchestrator itself provisioned
   * for this one step. Bypasses ENV_ALLOWLIST; never put a real platform secret here. */
  extraEnv?: Readonly<Record<string, string>>;
  /** Claude Console key for `claude.auth: "api-key"`; the step logs in with it instead of the subscription login. */
  apiKey?: string;
  /** Prompt cache TTL for this step (env `CLAUDE_CODE_PROMPT_CACHE_TTL`, which wins over settings); absent keeps the CLI default. */
  cacheTtl?: '5m' | '1h';
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
  if (input.effort) args.push('--effort', input.effort);
  args.push('--json-schema', JSON.stringify(input.jsonSchema));
  args.push('--tools', input.tools.join(','));
  if (input.disallowedTools.length > 0) args.push('--disallowed-tools', ...input.disallowedTools);
  if (input.sessionId) {
    if (input.resume) args.push('--resume', input.sessionId);
    else args.push('--session-id', input.sessionId);
  } else {
    args.push('--no-session-persistence');
  }

  const env = { ...sanitizeEnv(hostEnv), ...STEP_ENV };
  if (input.home) {
    env.HOME = input.home;
    env.TMPDIR = path.join(input.home, 'tmp');
    Object.assign(env, stackEnv(input.cwd));
    const goProxy = goProxyUrl(hostEnv);
    if (goProxy) env.GOPROXY = goProxy;
  }
  // Plan 38: a host-provided long-lived token replaces the copied credential file.
  if ((hostEnv.CLAUDE_CODE_OAUTH_TOKEN ?? '').trim() !== '') env.CLAUDE_CODE_OAUTH_TOKEN = hostEnv.CLAUDE_CODE_OAUTH_TOKEN!;
  // Never read from the host env: only the key the config chose (`claude.auth: "api-key"`) reaches a step.
  if (input.apiKey) env.ANTHROPIC_API_KEY = input.apiKey;
  if (input.cacheTtl) env.CLAUDE_CODE_PROMPT_CACHE_TTL = input.cacheTtl;
  if (input.extraEnv) Object.assign(env, input.extraEnv);
  return { args, env, cwd: input.cwd, stdin: input.prompt };
}

// Writes to ~/.claude.json go through `updateFileAtomic`: serialized per file in this process and atomic (temp file +
// rename), because parallel steps trust their worktrees at the same time and the CLI reads the file at startup.
// The claude CLI also saves this file on its own, and no lock keeps it out: the file is read again right before the
// rename and the change redone if it moved, which narrows that window but cannot close it.

/**
 * Project-level permissions.allow is ignored until the workspace is trusted
 * (findings row 5b). The orchestrator trusts every worktree it creates, keyed by its resolved path.
 */
export async function ensureTrusted(dir: string, claudeJsonPath: string): Promise<void> {
  // Key by the resolved real path when the directory exists (symlinks, trailing slashes);
  // otherwise keep the caller's spelling so a foreign-platform path is not rewritten.
  const key = await fs.realpath(dir).catch(() => dir);
  await fs.mkdir(path.dirname(claudeJsonPath), { recursive: true });
  await updateFileAtomic(claudeJsonPath, (current) => {
    const json: Record<string, unknown> = current === undefined ? {} : (JSON.parse(current) as Record<string, unknown>);
    const projects = (json.projects ?? {}) as Record<string, Record<string, unknown>>;
    projects[key] = { ...(projects[key] ?? {}), hasTrustDialogAccepted: true };
    json.projects = projects;
    return `${JSON.stringify(json, null, 2)}\n`;
  });
}

/**
 * Drops the trust entry of a worktree that is being removed, so `~/.claude.json` does not grow
 * without bound and a directory recreated later at the same path does not inherit the trust.
 * Other settings stored under the project entry are kept.
 */
export async function removeTrusted(dir: string, claudeJsonPath: string): Promise<void> {
  const real = await fs.realpath(dir).catch(() => dir);
  await updateFileAtomic(claudeJsonPath, (current) => {
    if (current === undefined) return undefined;
    const json = JSON.parse(current) as Record<string, unknown>;
    const projects = (json.projects ?? {}) as Record<string, Record<string, unknown>>;
    let changed = false;
    for (const key of new Set([dir, real])) {
      const entry = projects[key];
      if (!entry || !('hasTrustDialogAccepted' in entry)) continue;
      const { hasTrustDialogAccepted: _dropped, ...rest } = entry;
      if (Object.keys(rest).length === 0) delete projects[key];
      else projects[key] = rest;
      changed = true;
    }
    if (!changed) return undefined;
    json.projects = projects;
    return `${JSON.stringify(json, null, 2)}\n`;
  });
}
