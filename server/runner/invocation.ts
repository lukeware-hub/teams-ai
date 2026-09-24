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

/** Only these host variables reach an agent process (spec §14). */
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
  sessionId?: string;
  resume?: boolean;
  omniroute?: { baseUrl: string; token: string; compactWindow?: number };
}

export interface Invocation {
  args: string[];
  env: Record<string, string>;
  cwd: string;
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
  const args: string[] = ['-p', input.prompt, '--agent', input.role, ...ISOLATION_FLAGS];
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
    env.ANTHROPIC_BASE_URL = input.omniroute.baseUrl;
    env.ANTHROPIC_AUTH_TOKEN = input.omniroute.token;
    env.ANTHROPIC_MODEL = input.model;
    if (input.omniroute.compactWindow) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(input.omniroute.compactWindow);
  }
  return { args, env, cwd: input.cwd };
}

/**
 * Project-level permissions.allow is ignored until the workspace is trusted
 * (findings row 5b). The orchestrator trusts every worktree it creates.
 */
export async function ensureTrusted(dir: string, claudeJsonPath: string): Promise<void> {
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(await fs.readFile(claudeJsonPath, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const projects = (json.projects ?? {}) as Record<string, Record<string, unknown>>;
  projects[dir] = { ...(projects[dir] ?? {}), hasTrustDialogAccepted: true };
  json.projects = projects;
  await fs.mkdir(path.dirname(claudeJsonPath), { recursive: true });
  await fs.writeFile(claudeJsonPath, `${JSON.stringify(json, null, 2)}\n`);
}
