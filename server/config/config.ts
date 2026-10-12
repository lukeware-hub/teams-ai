import { z } from 'zod';
import { STEP_KINDS, type StepKind } from '../agents/outputs.js';
import { DEFAULT_MAX_PARALLEL } from '../scheduler/scheduler.js';
import { DEFAULT_POLICY } from '../scheduler/retry-policy.js';
import { BACKEND_NAMES, DECISION_IDS, type DecisionConfig, type DecisionId } from '../decide/types.js';

export const ROLES = ['sm', 'po', 'front', 'dev', 'test', 'sec', 'devops'] as const;
export type Role = (typeof ROLES)[number];

/** Every role runs the Claude Code CLI; strict, so a leftover `provider` key is refused instead of ignored. */
export const RoleProfile = z
  .object({
    model: z.string().min(1),
  })
  .strict();
export type RoleProfile = z.infer<typeof RoleProfile>;

const CLAUDE_DEFAULTS: Record<Role, RoleProfile> = {
  sm: { model: 'opus' },
  po: { model: 'opus' },
  front: { model: 'opus' },
  dev: { model: 'opus' },
  test: { model: 'sonnet' },
  sec: { model: 'sonnet' },
  devops: { model: 'sonnet' },
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
  // Plan 53 (R11.5a slice 1): shadow mode until an eval exists; off unless a session turns it on explicitly.
  'question-routing': { enabled: false, chain: ['jev', 'local'], escalateTo: 'po' },
  // R11.5a item 2: same risk class as the already-active byte-identical patch dedupe (R11.10), just catching
  // paraphrases of it, so it ships active rather than shadow.
  'patch-dedup': { chain: ['jev', 'local'], escalateTo: 'sm' },
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
  .object(Object.fromEntries(ROLES.map((r) => [r, RoleProfile.default(CLAUDE_DEFAULTS[r])])) as Record<
    Role,
    z.ZodDefault<typeof RoleProfile>
  >)
  .strict();

export const Config = z.object({
  roles: RolesSchema.prefault({}),
  budgets: z
    .object({
      step: StepBudget.prefault({}),
      perTaskTokens: positive.default(1_500_000),
      /** Caps a task by what it costs instead of by tokens: `perTaskTokens` counts a cache read like an output token (R11.13 slice 8). */
      perTaskCostUsd: z.number().positive().optional(),
      perRunTokens: positive.default(15_000_000),
      /** First run only measures; caps are enforced once calibrated (spec §8.5). */
      observeOnly: z.boolean().default(true),
    })
    .prefault({}),
  /**
   * Which model a step runs on, beyond the role profile (R11.13 slices 6 and 10). Defaults: Dev tiers on and Sonnet after the first refinement cycle (cheaper, measured 2026-10-09); set `tiers: "off"` and `laterCycleModels: {}` for Opus everywhere.
   * `tiers`: the Dev's model per task size; `shadow` journals the choice (MODEL_TIER_CHOSEN) without applying it, `on` applies it.
   * `stepModels`: a model for every step of one kind (e.g. the refinement checklists), whatever the role profile says.
   * `laterCycleModels`: the same for refinement steps from the second cycle on, ahead of `stepModels` (Opus finds the gaps in the
   * first cycle, a cheaper model closes the loop).
   */
  routing: z
    .object({
      tiers: z.enum(['off', 'shadow', 'on']).default('on'),
      models: z.object({ small: z.string().min(1).default('sonnet'), medium: z.string().min(1).default('sonnet'), large: z.string().min(1).default('opus') }).prefault({}),
      stepModels: z.partialRecord(z.enum(STEP_KINDS), z.string().min(1)).default({}),
      laterCycleModels: z.partialRecord(z.enum(STEP_KINDS), z.string().min(1)).default({ refine: 'sonnet', derive: 'sonnet', coverage: 'sonnet', backlog: 'sonnet' }),
    })
    .prefault({}),
  /**
   * How agent steps log in to Claude (R11.13 slice 12). `subscription` (default): the host login, copied into each step HOME.
   * `api-key`: the Claude Console key stored as the secret ANTHROPIC_API_KEY, passed to the agent steps only. Steps then bill
   * the Console organization (Max plans include monthly API credits) and leave the 5h/7d window alone, and no refresh token
   * rotates between concurrent steps. Cap the spend with a workspace limit in the Console.
   */
  claude: z.object({ auth: z.enum(['subscription', 'api-key']).default('subscription') }).prefault({}),
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
  github: z.object({ owner: z.string().min(1).optional(), /** Hosts `POST /projects` may clone from (audit M1). */ allowedHosts: z.array(z.string().min(1)).default(['github.com']) }).prefault({}),
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
      /** The daemon is rootless (the `dind` sidecar): gate containers run as its mapped root, not as this process's uid. */
      rootless: z.boolean().default(false),
      /** Address the deployed container port is published on. */
      publishBind: z.string().min(1).default('127.0.0.1'),
    })
    .prefault({}),
  /** Directories holding docs/project.json, registered from the UI (spec run API §2). */
  projects: z.array(z.object({ dir: z.string().min(1) })).default([]),
  decisions: z
    .object({
      /** Off for runs 1 and 2 (spec §1.3); every decision then takes its System 2 path or default. */
      enabled: z.boolean().default(false),
      /** Spec 10A.5 decision 10: tier names map to the role's Claude models. */
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
      /** Scanner downloads and the trivy DB shared by the security gates of every task (R11.13 slice 4). */
      gateCache: linuxPath.default('~/.teams-ai/gate-cache'),
    })
    .prefault({}),
});
export type Config = z.infer<typeof Config>;

/** The model `routing.stepModels` gives a step; a services plan is a plan, so it falls back to the plan's model. */
export const stepModelFor = (routing: Config['routing'], kind: StepKind): string | undefined =>
  routing.stepModels[kind] ?? (kind === 'services-plan' ? routing.stepModels.plan : undefined);

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

/** A disabled layer switches every decision off without touching its other settings (spec 10A.0). */
export function resolveDecision(cfg: Config, id: DecisionId): DecisionConfig {
  const d = cfg.decisions.perDecision[id];
  return { ...d, chain: [...d.chain], thresholds: { ...d.thresholds }, enabled: cfg.decisions.enabled && d.enabled };
}
