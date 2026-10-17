import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ALWAYS_DENIED, NESTED_DENIED } from '../agents/registry.js';
import type { Role } from '../config/config.js';
import { STACK_BASH } from './stacks.js';

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

/**
 * `--permission-mode dontAsk` denies every tool that is not allowed here, so editing roles must be
 * granted the file tools explicitly (the first live run's Dev could not write the tech spec).
 */
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit'] as const;
// In dontAsk mode a compound command is denied unless every segment matches a rule, so the read-only
// helpers a Dev chains onto npm/node (`... 2>&1 | tail -20`, `mktemp -d`, `grep`) are allowed too;
// without them the Dev concluded "Bash is denied" and stopped installing its own toolchain.
const SUITE_BASH = [
  'Bash(npm:*)',
  'Bash(npx:*)',
  'Bash(node:*)',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(ls:*)',
  'Bash(cat:*)',
  'Bash(head:*)',
  'Bash(tail:*)',
  'Bash(grep:*)',
  'Bash(wc:*)',
  'Bash(mktemp:*)',
  'Bash(mkdir:*)',
  'Bash(echo:*)',
  'Bash(pwd:*)',
  'Bash(true:*)',
  ...STACK_BASH,
] as const;
// `find` is deliberately absent (audit H3): `-exec` runs any command; use ls/grep.
const ROLE_ALLOW: Record<Role, readonly string[]> = {
  sm: [],
  po: [],
  front: [...EDIT_TOOLS, ...SUITE_BASH],
  dev: [...EDIT_TOOLS, ...SUITE_BASH],
  test: [...EDIT_TOOLS, ...SUITE_BASH],
  sec: [],
  devops: [...EDIT_TOOLS],
  env: [],
  reviewer: [],
};

export interface RoleSettingsInput {
  allowedDomains: readonly string[];
  /** Extra allow rules derived from the plan's commands (e.g. `Bash(pytest:*)` for a Python stack). */
  extraAllow?: readonly string[];
  /** Config `sandbox.enabled`; defaults to on. */
  sandboxEnabled?: boolean;
  /** The orchestrator's real HOME: the `~` deny rules resolve against the step HOME, so the real credential stores get absolute rules too. */
  hostHome?: string;
  /** The step's own HOME: it holds a copy of the credentials, which no command of the step may read either. */
  stepHome?: string;
  /** The secrets directory of every project (`<workspaces>/<project>/secrets`): the values the platform made up or the owner gave, which no step may read, whatever project it works in. */
  projectSecretsDirs?: readonly string[];
  /**
   * Directories (globs allowed) the step's commands must not read, for a step that gets Bash but needs none of the project data.
   * Denied twice: to every command by the sandbox, and to the Read, Grep and Glob tools by a `Read(dir)` rule. The rule has no `/**`:
   * that form over a workspace with millions of files made the CLI take gigabytes of memory for every command.
   */
  extraDenyRead?: readonly string[];
}

export interface RoleSettings {
  sandbox: { enabled: boolean; network: { allowedDomains: string[] }; filesystem?: { denyRead: string[] } };
  permissions: { allow: string[]; deny: string[] };
}

// A permission rule with one leading slash is relative to the working directory: only `//path` is the absolute path.
const absoluteRule = (dir: string) => `/${dir.replace(/\/+$/, '')}`;

export function buildRoleSettings(role: Role, input: RoleSettingsInput): RoleSettings {
  const deny = [
    ...PROTECTED_READ_PATHS.map((p) => `Read(${p})`),
    ...(input.hostHome ? PROTECTED_READ_PATHS.map((p) => `Read(${absoluteRule(input.hostHome!)}/${p.slice(2)})`) : []),
    ...(input.projectSecretsDirs ?? []).map((d) => `Read(${absoluteRule(d)}/**)`),
    // No `/**` here: that form over a workspace with millions of files made the CLI take gigabytes per command. The bare path still blocks the Read, Grep and Glob tools there.
    ...(input.extraDenyRead ?? []).map((d) => `Read(${absoluteRule(d)})`),
    // Edit(path) rules cover every file-editing tool; a Write(path) rule is not matched by the file permission checks.
    'Edit(.claude/**)',
    ...ALWAYS_DENIED,
    ...NESTED_DENIED,
  ];
  // Read rules only stop the Read tool; the sandbox stops every command (`cat`) from opening the credential stores.
  const denyRead = [
    ...(input.hostHome ? PROTECTED_READ_PATHS.map((p) => `${input.hostHome!.replace(/\/+$/, '')}/${p.slice(2).replace(/\/\*\*$/, '')}`) : []),
    ...(input.stepHome ? [`${input.stepHome.replace(/\/+$/, '')}/.claude`] : []),
    ...(input.projectSecretsDirs ?? []).map((d) => d.replace(/\/+$/, '')),
    ...(input.extraDenyRead ?? []).map((d) => d.replace(/\/+$/, '')),
  ];
  return {
    sandbox: { enabled: input.sandboxEnabled ?? true, network: { allowedDomains: [...input.allowedDomains] }, ...(denyRead.length > 0 ? { filesystem: { denyRead } } : {}) },
    permissions: { allow: [...ROLE_ALLOW[role], ...(input.extraAllow ?? [])], deny: [...new Set(deny)] },
  };
}

/** Tail of the queued writes per target file; see `writeRoleSettings`. */
const pendingWrites = new Map<string, Promise<void>>();

/** Writes `<dir>/<step>/<role>.settings.json` (outside any worktree) and returns its path; one file per step, so concurrent steps never read each other's policy. */
export async function writeRoleSettings(dir: string, role: Role, input: RoleSettingsInput): Promise<string> {
  const stepDir = input.stepHome ? path.join(dir, path.basename(input.stepHome)) : dir;
  await fs.mkdir(stepDir, { recursive: true });
  const file = path.join(stepDir, `${role}.settings.json`);
  const content = `${JSON.stringify(buildRoleSettings(role, input), null, 2)}\n`;
  // Concurrent steps of one role share `file`. Windows fails renames onto the same target that overlap with EPERM,
  // so writers of one file run one at a time, and a failed write does not block the next one.
  const write = (pendingWrites.get(file) ?? Promise.resolve()).then(async () => {
    // Unique per call, so no writer ever renames or truncates another writer's tmp file (that was ENOENT).
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, content);
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  });
  const tail = write.catch(() => {});
  pendingWrites.set(file, tail);
  try {
    await write;
  } finally {
    if (pendingWrites.get(file) === tail) pendingWrites.delete(file);
  }
  return file;
}
