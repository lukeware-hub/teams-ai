import { z } from 'zod';
import { DEFAULT_MAX_PARALLEL } from '../scheduler/scheduler.js';
import { DEFAULT_POLICY } from '../scheduler/retry-policy.js';
import { BACKEND_NAMES, DECISION_IDS, type DecisionConfig, type DecisionId } from '../decide/types.js';

export const ROLES = ['sm', 'po', 'front', 'dev', 'test', 'sec', 'devops'] as const;
export type Role = (typeof ROLES)[number];

export const ProviderProfile = z.object({
  provider: z.enum(['claude', 'omniroute']),
  model: z.string().min(1),
});
export type ProviderProfile = z.infer<typeof ProviderProfile>;

const CLAUDE_DEFAULTS: Record<Role, ProviderProfile> = {
  sm: { provider: 'claude', model: 'opus' },
  po: { provider: 'claude', model: 'opus' },
  front: { provider: 'claude', model: 'opus' },
  dev: { provider: 'claude', model: 'opus' },
  test: { provider: 'claude', model: 'sonnet' },
  sec: { provider: 'claude', model: 'sonnet' },
  devops: { provider: 'claude', model: 'sonnet' },
};

const positive = z.number().int().min(1);
const linuxPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/mnt/'), { message: 'must live on the Linux filesystem, not under /mnt (spec §15)' });

const unit = z.number().min(0).max(1);

/** Spec 10A.0: one entry per decision; thresholds are per backend. */
export const DecisionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  chain: z.array(z.enum(BACKEND_NAMES)).default([...BACKEND_NAMES]),
  thresholds: z.object({ jev: unit.default(0.8), local: unit.default(0.9) }).prefault({}),
  escalateTo: z.enum(ROLES).default('test'),
});

/** Spec 10A.5 "Escalates to" column; decisions with "—" never reach Claude. */
const DECISION_DEFAULTS: Partial<Record<DecisionId, Partial<DecisionConfig>>> = {
  'attempt-progress': { escalateTo: 'sm' },
  'model-tier': { chain: ['jev', 'local'] },
  // Runs in the UI server, which has no claude step to escalate to; the PO reads the report anyway.
  'report-routing': { chain: ['jev', 'local'], escalateTo: 'po' },
  // Spec 10A.5 row 8 escalates to no one; a Claude escalation would itself be a step that can fail.
  'cli-error': { chain: ['jev', 'local'] },
  'plan-rank': { escalateTo: 'sm' },
  // Gate 1 runs in the UI server, which has no claude step to escalate to.
  'gate1-readiness': { chain: ['jev', 'local'], escalateTo: 'po' },
  'question-dedup': { chain: ['jev', 'local'], escalateTo: 'sm' },
  'history-contradiction': { chain: ['jev', 'local'], escalateTo: 'po' },
};

const PerDecisionSchema = z
  .object(
    Object.fromEntries(DECISION_IDS.map((id) => [id, DecisionConfigSchema.prefault(DECISION_DEFAULTS[id] ?? {})])) as Record<
      DecisionId,
      z.ZodPrefault<typeof DecisionConfigSchema>
    >,
  )
  .strict();

/** Spec 10A.2: the model is pinned; aliases such as `jev-latest` would make attempts irreproducible. */
const pinnedModel = z
  .string()
  .min(1)
  .refine((m) => !/latest|auto/i.test(m), { message: 'decision model must be pinned (no latest/auto alias)' });

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
  /** The Claude Code sandbox (bubblewrap) for agent steps. Mandatory: `enabled: false` is refused unless
   * `unsafeNoSandbox` is true AND the env TEAMS_AI_UNSAFE_NO_SANDBOX=1 is set (see runner/sandbox-policy.ts). */
  sandbox: z.object({ enabled: z.boolean().default(true), unsafeNoSandbox: z.boolean().default(false) }).prefault({}),
  docker: z
    .object({
      /** When the orchestrator itself runs in a container, the daemon it talks to cannot see its paths.
       * Bind sources under `from` (the orchestrator's view) are rewritten to `to` (the daemon's view),
       * e.g. from ~/.teams-ai to /var/lib/docker/volumes/teams-ai-config/_data. */
      bindRewrite: z.object({ from: linuxPath, to: z.string().min(1) }).optional(),
      /** Host the orchestrator and the smoke gate use to reach a locally deployed service (docker-local target). */
      serviceHost: z.string().min(1).default('127.0.0.1'),
      /** Address the deployed container port is published on. */
      publishBind: z.string().min(1).default('127.0.0.1'),
    })
    .prefault({}),
  /** Where quality gates and the smoke suite run: `docker` (default) or Kubernetes Jobs. */
  executor: z
    .object({
      kind: z.enum(['docker', 'k8s']).default('docker'),
      namespace: z.string().min(1).default('teams-ai'),
      serviceAccount: z.string().min(1).default('default'),
      /** PVC holding the workspace; the orchestrator mounts it at `workspaceRoot` (backend.yaml: teams-ai-data at ~/.teams-ai). */
      workspacePvc: z.string().min(1).default('teams-ai-data'),
      workspaceRoot: linuxPath.default('/root/.teams-ai'),
      /** The PVC subPath that `workspaceRoot` is. */
      workspaceSubPath: z.string().min(1).default('teams-ai'),
      runAsUser: z.number().int().nonnegative().default(1000),
      runAsGroup: z.number().int().nonnegative().default(1000),
    })
    .prefault({}),
  /** Directories holding docs/project.json, registered from the UI (spec run API §2). */
  projects: z.array(z.object({ dir: z.string().min(1) })).default([]),
  omniroute: z
    .object({
      baseUrl: z.string().url().default('http://localhost:20128'),
      enabled: z.boolean().default(false),
    })
    .prefault({}),
  decisions: z
    .object({
      /** Off for runs 1 and 2 (spec §1.3); every decision then takes its System 2 path or default. */
      enabled: z.boolean().default(false),
      /** Spec 10A.5 decision 10: tier names map to the role's Claude models; OmniRoute pins are never replaced. */
      modelTiers: z
        .object({ small: z.string().min(1).default('haiku'), medium: z.string().min(1).default('sonnet'), large: z.string().min(1).default('opus') })
        .prefault({}),
      openrouter: z
        .object({
          baseUrl: z.string().url().default('https://openrouter.ai/api'),
          model: pinnedModel.default('typesafe/jev-1.13'),
          timeoutMs: positive.default(15_000),
          maxTries: positive.default(3),
          backoffMs: positive.default(500),
        })
        .prefault({}),
      /** Spec 10A.2a: a llama.cpp server on this host; off until one is running, then the chain's free middle step. */
      local: z
        .object({
          enabled: z.boolean().default(false),
          baseUrl: z.string().url().default('http://127.0.0.1:8080'),
          timeoutMs: positive.default(30_000),
          nProbs: positive.default(20),
        })
        .prefault({}),
      perDecision: PerDecisionSchema.prefault({}),
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

/** A disabled layer switches every decision off without touching its other settings (spec 10A.0). */
export function resolveDecision(cfg: Config, id: DecisionId): DecisionConfig {
  const d = cfg.decisions.perDecision[id];
  return { ...d, chain: [...d.chain], thresholds: { ...d.thresholds }, enabled: cfg.decisions.enabled && d.enabled };
}
