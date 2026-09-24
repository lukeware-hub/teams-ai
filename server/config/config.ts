import { z } from 'zod';
import { DEFAULT_MAX_PARALLEL } from '../scheduler/scheduler.js';
import { DEFAULT_POLICY } from '../scheduler/retry-policy.js';

export const ROLES = ['sm', 'po', 'dev', 'test', 'devops'] as const;
export type Role = (typeof ROLES)[number];

export const ProviderProfile = z.object({
  provider: z.enum(['claude', 'omniroute']),
  model: z.string().min(1),
});
export type ProviderProfile = z.infer<typeof ProviderProfile>;

const CLAUDE_DEFAULTS: Record<Role, ProviderProfile> = {
  sm: { provider: 'claude', model: 'opus' },
  po: { provider: 'claude', model: 'opus' },
  dev: { provider: 'claude', model: 'opus' },
  test: { provider: 'claude', model: 'sonnet' },
  devops: { provider: 'claude', model: 'sonnet' },
};

const positive = z.number().int().min(1);
const linuxPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/mnt/'), { message: 'must live on the Linux filesystem, not under /mnt (spec §15)' });

export const StepBudget = z.object({
  timeoutMs: positive.default(20 * 60_000),
  maxTurns: positive.default(60),
  maxOutputTokens: positive.default(40_000),
});

const RolesSchema = z
  .object(Object.fromEntries(ROLES.map((r) => [r, ProviderProfile.default(CLAUDE_DEFAULTS[r])])) as Record<
    Role,
    z.ZodDefault<typeof ProviderProfile>
  >)
  .strict();

export const Config = z.object({
  roles: RolesSchema.prefault({}),
  budgets: z
    .object({
      step: StepBudget.prefault({}),
      perTaskTokens: positive.default(1_500_000),
      perRunTokens: positive.default(15_000_000),
      /** First run only measures; caps are enforced once calibrated (spec §8.5). */
      observeOnly: z.boolean().default(true),
    })
    .prefault({}),
  concurrency: z
    .object({
      maxParallel: positive.default(DEFAULT_MAX_PARALLEL),
      maxClaudeProcesses: positive.default(3),
    })
    .prefault({}),
  retry: z
    .object({
      maxAttempts: positive.default(DEFAULT_POLICY.maxAttempts),
      maxInfraRetriesPerGate: positive.default(DEFAULT_POLICY.maxInfraRetriesPerGate),
      maxFlakyRetriesPerGate: positive.default(DEFAULT_POLICY.maxFlakyRetriesPerGate),
      maxSchemaRetriesPerStep: positive.default(DEFAULT_POLICY.maxSchemaRetriesPerStep),
    })
    .prefault({}),
  github: z.object({ owner: z.string().min(1).optional() }).prefault({}),
  omniroute: z
    .object({
      baseUrl: z.string().url().default('http://localhost:20128'),
      enabled: z.boolean().default(false),
    })
    .prefault({}),
  paths: z
    .object({
      workspaces: linuxPath.default('~/.teams-ai/workspaces'),
      secrets: linuxPath.default('~/.teams-ai/secrets'),
      runs: linuxPath.default('~/.teams-ai/runs'),
    })
    .prefault({}),
});
export type Config = z.infer<typeof Config>;

export class ConfigError extends Error {}

export function loadConfig(json: unknown): Config {
  const parsed = Config.safeParse(json);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`invalid config:\n${lines.join('\n')}`);
  }
  return parsed.data;
}

export const DEFAULT_CONFIG: Config = loadConfig({});

/** OmniRoute is never used for confidential projects or while disabled (spec §10). */
export function resolveProfile(cfg: Config, role: Role, project: { confidential: boolean }): ProviderProfile {
  const profile = cfg.roles[role];
  if (profile.provider === 'omniroute' && (project.confidential || !cfg.omniroute.enabled)) {
    return CLAUDE_DEFAULTS[role];
  }
  return profile;
}
