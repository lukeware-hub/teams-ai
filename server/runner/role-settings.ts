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
