import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ProviderProfile, Role } from '../config/config.js';
import type { Effort } from '../decide/decisions/model-tier.js';

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
  /** Per-step empty HOME (outside the worktree); replaces the host HOME and TMPDIR in the child env. */
  home?: string;
  /** Claude Code effort level for this step (spec 10A.5 decision 11); absent means the CLI default. */
  effort?: Effort;
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

  const env = sanitizeEnv(hostEnv);
  if (input.home) {
    env.HOME = input.home;
    env.TMPDIR = path.join(input.home, 'tmp');
  }
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

/**
 * Drops the trust entry of a worktree that is being removed, so `~/.claude.json` does not grow
 * without bound and a directory recreated later at the same path does not inherit the trust.
 * Other settings stored under the project entry are kept.
 */
export function removeTrusted(dir: string, claudeJsonPath: string): Promise<void> {
  const work = async () => {
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(await fs.readFile(claudeJsonPath, 'utf8')) as Record<string, unknown>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    const projects = (json.projects ?? {}) as Record<string, Record<string, unknown>>;
    let real = dir;
    try {
      real = await fs.realpath(dir);
    } catch {
      real = dir;
    }
    let changed = false;
    for (const key of new Set([dir, real])) {
      const entry = projects[key];
      if (!entry || !('hasTrustDialogAccepted' in entry)) continue;
      const { hasTrustDialogAccepted: _dropped, ...rest } = entry;
      if (Object.keys(rest).length === 0) delete projects[key];
      else projects[key] = rest;
      changed = true;
    }
    if (!changed) return;
    json.projects = projects;
    const tmp = `${claudeJsonPath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(json, null, 2)}\n`);
    await fs.rename(tmp, claudeJsonPath);
  };
  const result = trustQueue.then(work, work);
  trustQueue = result.catch(() => undefined);
  return result;
}
