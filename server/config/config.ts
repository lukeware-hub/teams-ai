import { z } from 'zod';
import { ROLES, type Role } from './roles.js';
export { ROLES, type Role };
import { STEP_KINDS, type StepKind } from '../agents/outputs.js';
import { DEFAULT_MAX_PARALLEL } from '../scheduler/scheduler.js';
import { DEFAULT_POLICY } from '../scheduler/retry-policy.js';
import { BACKEND_NAMES, DECISION_IDS, type DecisionConfig, type DecisionId } from '../decide/types.js';
import { EFFORT_LEVELS, type Effort } from '../decide/decisions/model-tier.js';

/** Pinned model ids: an alias like `sonnet` resolves to whichever version the CLI ships, so a run would not be reproducible. */
export const MODELS = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' } as const;


/** Every role runs the Claude Code CLI; strict, so a leftover `provider` key is refused instead of ignored. */
export const RoleProfile = z
  .object({
    model: z.string().min(1),
  })
  .strict();
export type RoleProfile = z.infer<typeof RoleProfile>;

/** Sonnet runs every role; Opus is only for the architecture steps (`ARCHITECTURE_MODELS`) and Haiku for small tasks (`routing.models`). */
const CLAUDE_DEFAULTS: Record<Role, RoleProfile> = {
  sm: { model: MODELS.sonnet },
  po: { model: MODELS.sonnet },
  front: { model: MODELS.sonnet },
  dev: { model: MODELS.sonnet },
  test: { model: MODELS.sonnet },
  sec: { model: MODELS.sonnet },
  devops: { model: MODELS.sonnet },
  env: { model: MODELS.sonnet },
};

/** The steps that decide architecture: the only ones that run on Opus by default (at low effort by default, see `effortFor`). */
const ARCHITECTURE_MODELS = { 'tech-spec': MODELS.opus, plan: MODELS.opus, 'services-plan': MODELS.opus, architecture: MODELS.opus } as const;

/** The model of each refinement step from the second cycle on: the schema default, and the row's model when the config drops one. */
const LATER_CYCLE_MODELS = { refine: MODELS.sonnet, derive: MODELS.sonnet, coverage: MODELS.sonnet, backlog: MODELS.sonnet, answer: MODELS.sonnet } as const;

/** The architecture steps: the Settings screen sets their model as one. */
export const ARCHITECTURE_KINDS = ['tech-spec', 'plan', 'services-plan', 'architecture'] as const satisfies readonly StepKind[];
/** The refinement steps from the second cycle on: the Settings screen sets their model as one. */
export const LATER_CYCLE_KINDS = ['refine', 'derive', 'coverage', 'backlog', 'answer'] as const satisfies readonly StepKind[];
/** The most effort each model family takes on the automatic path; Settings sets it. */
export type EffortCaps = Record<'haiku' | 'sonnet' | 'opus', Effort>;
/** The caps that keep the model-policy rules: Haiku and Opus at low, Sonnet at high. */
export const DEFAULT_EFFORT_CAPS: EffortCaps = { haiku: 'low', sonnet: 'high', opus: 'low' };

const positive = z.number().int().min(1);
/** The most agents that prepare the plans at once. */
export const PLAN_AGENTS_MAX = 5;
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
  // R11.5.7: shadow mode by default, so labelled data builds up; on its own it never answers, drops or hides a question.
  'question-routing': { chain: ['jev', 'local'], escalateTo: 'po' },
  // R11.5a item 2: same risk class as the already-active byte-identical patch dedupe (R11.10), just catching
  // paraphrases of it, so it ships active rather than shadow.
  'patch-dedup': { chain: ['jev', 'local'], escalateTo: 'sm' },
  // R11.14: only decides whether another run is worth trying; a wrong answer costs one bounded run or one question to the owner.
  'failure-cause': { chain: ['jev', 'local'], escalateTo: 'sm' },
  // R11.5a item 3: every detailing check asks the Jev; the other two were off until an eval, and the human turned them on (2026-10-13).
  'spec-cited-sections': { chain: ['jev', 'local'], escalateTo: 'po' },
  'criterion-shared-deploy': { chain: ['jev', 'local'], escalateTo: 'po' },
  'preplan-tech-decisions': { chain: ['jev', 'local'], escalateTo: 'sm' },
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
  timeoutMs: positive.default(60 * 60_000),
  /** The time limit of one stage review part: a review that runs longer is asked again, up to three tries. */
  reviewTimeoutMs: positive.default(5 * 60_000),
  maxTurns: positive.default(60),
  /** Output tokens one stage review may write: it is sent to the CLI as CLAUDE_CODE_MAX_OUTPUT_TOKENS. */
  maxOutputTokens: positive.default(40_000),
});

/** The longest timer Node runs: a longer one fires at once. */
export const TIMER_MAX_MS = 2 ** 31 - 1;

const RolesSchema = z
  .object(Object.fromEntries(ROLES.map((r) => [r, RoleProfile.default(CLAUDE_DEFAULTS[r])])) as Record<
    Role,
    z.ZodDefault<typeof RoleProfile>
  >)
  .strict();

/** A model and effort the user fixed for one agent of one project; the orchestrator picks them when absent. */
export const AgentSetting = z
  .object({
    model: z.enum([MODELS.haiku, MODELS.sonnet, MODELS.opus]),
    effort: z.enum(EFFORT_LEVELS),
  })
  .strict();
export type AgentSetting = z.infer<typeof AgentSetting>;

/** The setting a role takes when its project has none: a manual Haiku at low effort. */
export const DEFAULT_AGENT_SETTING: AgentSetting = { model: MODELS.haiku, effort: 'low' };

/** The setting the product owner and the scrum master take when their project has none: they review the documents, so they get the deeper model. */
const REVIEWER_DEFAULT: AgentSetting = { model: MODELS.sonnet, effort: 'low' };

/** The two model settings a project keeps beside its roles: the chat and the graphify extraction. */
export const SLOTS = ['chat', 'graphify'] as const;
export type Slot = (typeof SLOTS)[number];
export const isSlot = (key: string): key is Slot => (SLOTS as readonly string[]).includes(key);

/** Every key a project keeps a model setting under: the roles, then the slots. */
export const SETTING_KEYS = [...ROLES, ...SLOTS] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];
export type StoredSettings = Partial<Record<SettingKey, AgentSetting | null>>;

/** The setting a slot takes when its project has none: the chat on Haiku, graphify on Sonnet, both at low effort. */
const SLOT_DEFAULTS: Record<Slot, AgentSetting> = { chat: DEFAULT_AGENT_SETTING, graphify: { model: MODELS.sonnet, effort: 'low' } };

/** The setting a key takes when its project has none. */
export const defaultAgentSetting = (key: SettingKey): AgentSetting =>
  isSlot(key) ? SLOT_DEFAULTS[key] : key === 'po' || key === 'sm' ? REVIEWER_DEFAULT : DEFAULT_AGENT_SETTING;

/** A slot's setting in its project, else its default: a slot never goes automatic. */
export const slotSettingOf = (stored: StoredSettings, slot: Slot): AgentSetting => stored[slot] ?? defaultAgentSetting(slot);

/** What a key takes from its project's stored settings: its own setting, else the default; a role stored as null is automatic. */
export function storedSettingOf(stored: StoredSettings, key: SettingKey): AgentSetting | null {
  if (isSlot(key)) return slotSettingOf(stored, key);
  return key in stored ? (stored[key] ?? null) : defaultAgentSetting(key);
}

/** The manual settings a run uses: a key never set takes the default, and a role stored as null (automatic) takes none. */
export function manualAgentSettings(stored: StoredSettings = {}): Partial<Record<SettingKey, AgentSetting>> {
  const out: Partial<Record<SettingKey, AgentSetting>> = {};
  for (const key of SETTING_KEYS) {
    const setting = storedSettingOf(stored, key);
    if (setting) out[key] = setting;
  }
  return out;
}

export const Config = z.object({
  roles: RolesSchema.prefault({}),
  /** Per project id, per role and slot: the manual model and effort; a role absent here runs on the automatic choice, a slot never does. */
  agentSettings: z.record(z.string().min(1), z.partialRecord(z.enum(SETTING_KEYS), AgentSetting.nullable())).default({}),
  /** Per project id: the time limit of each agent step in ms, set in Settings; a project absent here takes `budgets.step.timeoutMs`. */
  stepTimeouts: z.record(z.string().min(1), positive.max(TIMER_MAX_MS)).default({}),
  /** Per project id: whether its agents decide a block themselves, set in Settings; a project absent here does not. */
  agentsDecide: z.record(z.string().min(1), z.boolean()).default({}),
  budgets: z
    .object({
      step: StepBudget.prefault({}),
      perTaskTokens: positive.default(1_500_000),
      /** Caps a task by what it costs instead of by tokens: `perTaskTokens` counts a cache read like an output token (R11.13 slice 8). */
      perTaskCostUsd: z.number().positive().optional(),
      perRunTokens: positive.default(15_000_000),
      /** A run that spends more than this records one alert; cost only warns and never stops a run (owner decision). */
      perRunCostUsd: z.number().positive().default(3),
      /** First run only measures; caps are enforced once calibrated (spec §8.5). */
      observeOnly: z.boolean().default(true),
    })
    .prefault({}),
  /**
   * Which model a step runs on, beyond the role profile (R11.13 slices 6 and 10). Defaults (human, 2026-10-13): Sonnet everywhere, Haiku for small tasks, Opus only for the architecture steps.
   * `tiers`: the Dev's model per task size; `shadow` journals the choice (MODEL_TIER_CHOSEN) without applying it, `on` applies it.
   * `stepModels`: a model for every step of one kind (e.g. the refinement checklists), whatever the role profile says.
   * `laterCycleModels`: the same for refinement steps from the second cycle on, ahead of `stepModels` (Opus finds the gaps in the
   * first cycle, a cheaper model closes the loop).
   */
  routing: z
    .object({
      tiers: z.enum(['off', 'shadow', 'on']).default('on'),
      models: z.object({ small: z.string().min(1).default(MODELS.haiku), medium: z.string().min(1).default(MODELS.sonnet), large: z.string().min(1).default(MODELS.sonnet) }).prefault({}),
      stepModels: z.partialRecord(z.enum(STEP_KINDS), z.string().min(1)).default(ARCHITECTURE_MODELS),
      laterCycleModels: z.partialRecord(z.enum(STEP_KINDS), z.string().min(1)).default(LATER_CYCLE_MODELS),
      /** The model that suggests the names of projects, specs and requests. */
      namingModel: z.string().min(1).default(MODELS.haiku),
      /** The effort of the naming step, shown beside its model in Settings. */
      namingEffort: z.enum(EFFORT_LEVELS).default('low'),
      /** The effort of each automatic group, shown beside its model in Settings: the task sizes, the architecture steps and the later cycles. */
      efforts: z
        .object({
          small: z.enum(EFFORT_LEVELS).default('low'),
          medium: z.enum(EFFORT_LEVELS).default('low'),
          large: z.enum(EFFORT_LEVELS).default('low'),
          architecture: z.enum(EFFORT_LEVELS).default('low'),
          laterCycle: z.enum(EFFORT_LEVELS).default('low'),
          /** The default effort of the automatic steps, set in Settings; the task-size, architecture and later-cycle rows keep their own. */
          automatic: z.enum(EFFORT_LEVELS).default('low'),
        })
        .prefault({}),
      /** The most effort each model family takes on the automatic path, set in Settings. */
      automaticEffortCap: z
        .object({
          haiku: z.enum(EFFORT_LEVELS).default(DEFAULT_EFFORT_CAPS.haiku),
          sonnet: z.enum(EFFORT_LEVELS).default(DEFAULT_EFFORT_CAPS.sonnet),
          opus: z.enum(EFFORT_LEVELS).default(DEFAULT_EFFORT_CAPS.opus),
        })
        .prefault({}),
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
      /** Agents that prepare the plans at once, set in Settings; a preparation runs one at a time when 1. */
      planAgents: positive.max(PLAN_AGENTS_MAX).optional(),
      /** The name before the rename, read for a config written earlier. */
      speckitAgents: positive.max(PLAN_AGENTS_MAX).optional(),
    })
    .transform((c) => ({ maxParallel: c.maxParallel, maxClaudeProcesses: c.maxClaudeProcesses, planAgents: c.planAgents ?? c.speckitAgents ?? PLAN_AGENTS_MAX }))
    .prefault({}),
  retry: z
    .object({
      maxAttempts: positive.default(DEFAULT_POLICY.maxAttempts),
      maxInfraRetriesPerGate: positive.default(DEFAULT_POLICY.maxInfraRetriesPerGate),
      maxFlakyRetriesPerGate: positive.default(DEFAULT_POLICY.maxFlakyRetriesPerGate),
      maxSchemaRetriesPerStep: positive.default(DEFAULT_POLICY.maxSchemaRetriesPerStep),
      /** Tokens a task may spend while its attempts continue past `maxAttempts`; unset keeps the attempt count alone. */
      taskTokenBudget: positive.optional(),
    })
    .prefault({}),
  github: z.object({ owner: z.string().min(1).optional(), /** Hosts `POST /projects` may clone from (audit M1). */ allowedHosts: z.array(z.string().min(1)).default(['github.com']) }).prefault({}),
  /** The Claude Code sandbox (bubblewrap) for agent steps. Mandatory: `enabled: false` is refused unless
   * `unsafeNoSandbox` is true AND the env TEAMS_AI_UNSAFE_NO_SANDBOX=1 is set (see runner/sandbox-policy.ts). */
  sandbox: z.object({ enabled: z.boolean().default(true), unsafeNoSandbox: z.boolean().default(false) }).prefault({}),
  /** What this machine's environment provides to every project it runs. */
  environment: z
    .object({
      /** Names of internal credentials the platform creates for each project and hands to every service's compose file and to the smoke and e2e gates (an admin token one service accepts and another sends). A value already in the project's secrets wins. */
      generatedSecrets: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).default([]),
    })
    .prefault({}),
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
  /** Refinement settings. The heal driver starts a new cycle or preparation for the drafts a restart or a failure left in error; on by default. */
  refine: z.object({ heal: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }) }).default({ heal: { enabled: true } }),
  decisions: z
    .object({
      /** Off for runs 1 and 2 (spec §1.3); every decision then takes its System 2 path or default. */
      enabled: z.boolean().default(false),
      /** Spec 10A.5 decision 10: tier names map to the role's Claude models. */
      modelTiers: z
        .object({ small: z.string().min(1).default(MODELS.haiku), medium: z.string().min(1).default(MODELS.sonnet), large: z.string().min(1).default(MODELS.sonnet) })
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
      /** R11.5.7: the confidence at or above which a blocking refinement question Jev routes `auto` is answered from the docs; `measured` (the default) takes it from the project's labelled answers, `off` never answers. */
      autoAnswerFloor: z.union([unit, z.enum(['measured', 'off'])]).default('measured'),
    })
    .prefault({}),
  paths: z
    .object({
      workspaces: linuxPath.default('~/.teams-ai/workspaces'),
      secrets: linuxPath.default('~/.teams-ai/secrets'),
      runs: linuxPath.default('~/.teams-ai/runs'),
      /** The running total of what the Jev charged: one line per charge. */
      usage: linuxPath.default('~/.teams-ai/usage'),
      /** Scanner downloads and the trivy DB shared by the security gates of every task (R11.13 slice 4). */
      gateCache: linuxPath.default('~/.teams-ai/gate-cache'),
    })
    .prefault({}),
});
export type Config = z.infer<typeof Config>;

/** The model `routing.stepModels` gives a step; a services plan is a plan, so it falls back to the plan's model. */
export const stepModelFor = (routing: Config['routing'], kind: StepKind): string | undefined =>
  routing.stepModels[kind] ?? (kind === 'services-plan' ? routing.stepModels.plan : undefined);

/** The model and effort of one automatic row. */
export interface AutomaticRow {
  model: string;
  effort: Effort;
}

/** The rows of the automatic choice, shared by every project: the three task sizes, the architecture steps and the later refinement cycles. */
export interface AutomaticSettings {
  tiers: { small: AutomaticRow; medium: AutomaticRow; large: AutomaticRow };
  architecture: AutomaticRow;
  laterCycle: AutomaticRow;
  /** The model and effort of the steps that name projects, specs and requests. */
  naming: AutomaticRow;
  /** The effort of every automatic step that is not an architecture step. */
  defaultEffort: Effort;
  effortCaps: EffortCaps;
}

/** Reads the automatic rows from the routing settings; a group with no model left in the file shows its default. */
export const automaticSettingsOf = (routing: Config['routing']): AutomaticSettings => ({
  tiers: {
    small: { model: routing.models.small, effort: routing.efforts.small },
    medium: { model: routing.models.medium, effort: routing.efforts.medium },
    large: { model: routing.models.large, effort: routing.efforts.large },
  },
  architecture: { model: routing.stepModels[ARCHITECTURE_KINDS[0]] ?? ARCHITECTURE_MODELS[ARCHITECTURE_KINDS[0]], effort: routing.efforts.architecture },
  laterCycle: { model: routing.laterCycleModels[LATER_CYCLE_KINDS[0]] ?? LATER_CYCLE_MODELS[LATER_CYCLE_KINDS[0]], effort: routing.efforts.laterCycle },
  naming: { model: routing.namingModel, effort: routing.namingEffort },
  defaultEffort: routing.efforts.automatic,
  effortCaps: routing.automaticEffortCap,
});

/** The automatic model and effort of one step: a step from the second refinement cycle on takes `laterCycleModels`, else `stepModels`. */
export const automaticStepOf = (routing: Config['routing'], kind: StepKind, cycle = 1): AutomaticRow | undefined => {
  const later = cycle > 1 ? routing.laterCycleModels[kind] : undefined;
  if (later) return { model: later, effort: routing.efforts.laterCycle };
  const model = stepModelFor(routing, kind);
  if (!model) return undefined;
  return { model, effort: ARCHITECTURE_KINDS.some((k) => k === kind) ? routing.efforts.architecture : routing.efforts.automatic };
};

/** The step budget one project runs with: its time limit from Settings, else `budgets.step`. */
export function stepBudgetFor(cfg: Config, projectId?: string): Config['budgets']['step'] {
  if (projectId === undefined || !Object.hasOwn(cfg.stepTimeouts, projectId)) return cfg.budgets.step;
  const timeoutMs = cfg.stepTimeouts[projectId];
  return { ...cfg.budgets.step, timeoutMs, reviewTimeoutMs: timeoutMs };
}

/** Whether the agents of one project decide its blocks themselves; a project absent from Settings does not. */
export const agentsDecideFor = (cfg: Config, projectId: string): boolean => Object.hasOwn(cfg.agentsDecide, projectId) && cfg.agentsDecide[projectId] === true;

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
