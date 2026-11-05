import { AgentSetting, automaticModelsOf, Config, defaultAgentSetting, isSlot, PLAN_AGENTS_MAX, SETTING_KEYS, storedSettingOf, TIMER_MAX_MS, agentsDecideFor, stepBudgetFor, type AutomaticModels, type Role, type SettingKey } from '../config/config.js';
import { ID_PATTERNS } from '../core/ids.js';
import { effortFor } from '../runner/model-policy.js';
import { readUserConfig, setAgentSetting, setAgentsDecide, setAutomaticModels, setSpeckitAgents, setStepTimeout } from '../onboarding/config-store.js';
import { HttpError, type Route } from './server.js';
import { configProblem } from './onboarding-routes.js';

export interface SettingsDeps {
  home?: string;
}

const P = '/api/settings/agents';
const T = '/api/settings/step-timeout';
const S = '/api/settings/plan-agents';
const D = '/api/settings/agents-decide';
const A = '/api/settings/automatic';
const MINUTE_MS = 60_000;

const slugOf = (id: string): string => {
  if (!ID_PATTERNS.SLUG.test(id)) throw new HttpError(400, 'project id is not a slug');
  return id;
};

const keyOf = (key: string): SettingKey => {
  if (!(SETTING_KEYS as readonly string[]).includes(key)) throw new HttpError(404, `unknown agent ${key}`);
  return key as SettingKey;
};

/** `{mode:'auto'}` gives the agent back to the orchestrator; `{mode:'manual', model, effort}` fixes both. A chat or graphify slot is always manual. */
const settingOf = (input: unknown, key: SettingKey): AgentSetting | null => {
  const body = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  if (body.mode === 'auto') {
    if (isSlot(key)) throw new HttpError(400, 'este agente não tem modo automático');
    return null;
  }
  if (body.mode !== 'manual') throw new HttpError(400, 'mode must be auto or manual');
  const parsed = AgentSetting.safeParse({ model: body.model, effort: body.effort });
  if (!parsed.success) throw new HttpError(400, 'model must be claude-haiku-5-5, claude-sonnet-5-5 or claude-opus-5-5; effort must be low, medium, high or max');
  return parsed.data;
};

/** `{timeoutMinutes}` from the Settings page: a whole number of minutes that a timer can hold. */
const minutesOf = (input: unknown): number => {
  const minutes = (input as { timeoutMinutes?: unknown } | null)?.timeoutMinutes;
  if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes * MINUTE_MS > TIMER_MAX_MS) {
    throw new HttpError(400, `timeoutMinutes must be a whole number from 1 to ${Math.floor(TIMER_MAX_MS / MINUTE_MS)}`);
  }
  return minutes;
};

/** `{agentsDecide}` from the Settings page: a yes or no answer. */
const agentsDecideOf = (input: unknown): boolean => {
  const value = (input as { agentsDecide?: unknown } | null)?.agentsDecide;
  if (typeof value !== 'boolean') throw new HttpError(400, 'agentsDecide must be true or false');
  return value;
};

/** `{agents}` from the Settings page: how many agents prepare the plan items at once, a whole number from 1 to 5. */
const agentsOf = (input: unknown): number => {
  const agents = (input as { agents?: unknown } | null)?.agents;
  if (typeof agents !== 'number' || !Number.isInteger(agents) || agents < 1 || agents > PLAN_AGENTS_MAX) {
    throw new HttpError(400, `agents must be a whole number from 1 to ${PLAN_AGENTS_MAX}`);
  }
  return agents;
};

/** `{tiers: {small, medium, large}, architecture, laterCycle}` from the Settings page: each a model the agents accept. */
const automaticOf = (input: unknown): AutomaticModels => {
  const body = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const tiers = typeof body.tiers === 'object' && body.tiers !== null ? (body.tiers as Record<string, unknown>) : {};
  const modelOf = (value: unknown): string => {
    const parsed = AgentSetting.shape.model.safeParse(value);
    if (!parsed.success) throw new HttpError(400, 'model must be claude-haiku-5-5, claude-sonnet-5-5 or claude-opus-5-5');
    return parsed.data;
  };
  return { tiers: { small: modelOf(tiers.small), medium: modelOf(tiers.medium), large: modelOf(tiers.large) }, architecture: modelOf(body.architecture), laterCycle: modelOf(body.laterCycle) };
};

/** The model and effort an automatic role uses by default: its role profile model, at the effort the model allows when nothing is asked. */
const automaticSetting = (cfg: Config, role: Role): AgentSetting => {
  const model = cfg.roles[role].model;
  return { model, effort: effortFor(model, undefined) } as AgentSetting;
};

/** What a key runs on now: its manual setting, else the automatic default (a slot has no automatic one, so its default). */
const inUseOf = (cfg: Config, key: SettingKey, setting: AgentSetting | null): AgentSetting =>
  setting ?? (isSlot(key) ? defaultAgentSetting(key) : automaticSetting(cfg, key));

export function settingsRoutes(deps: SettingsDeps): Route[] {
  return [
    {
      method: 'GET',
      path: S,
      handler: async ({ json }) => {
        const { cfg } = await readUserConfig(deps.home).catch(configProblem);
        json(200, { agents: cfg.concurrency.planAgents });
      },
    },
    {
      method: 'PUT',
      path: S,
      handler: async ({ body, json }) => {
        const agents = agentsOf(await body());
        await setSpeckitAgents(agents, deps.home).catch(configProblem);
        json(200, { agents });
      },
    },
    {
      method: 'GET',
      path: `${P}/:projectId`,
      handler: async ({ params, json }) => {
        const projectId = slugOf(params.projectId!);
        const { cfg } = await readUserConfig(deps.home).catch(configProblem);
        const settings = cfg.agentSettings[projectId] ?? {};
        json(200, {
          agents: SETTING_KEYS.map((key) => {
            const setting = storedSettingOf(settings, key);
            return { role: key, setting, inUse: inUseOf(cfg, key, setting) };
          }),
        });
      },
    },
    {
      method: 'PUT',
      path: `${P}/:projectId/:role`,
      handler: async ({ params, body, json }) => {
        const projectId = slugOf(params.projectId!);
        const key = keyOf(params.role!);
        const setting = settingOf(await body(), key);
        const cfg = await setAgentSetting(projectId, key, setting, deps.home).catch(configProblem);
        json(200, { setting, inUse: inUseOf(cfg, key, setting) });
      },
    },
    {
      method: 'GET',
      path: `${T}/:projectId`,
      handler: async ({ params, json }) => {
        const projectId = slugOf(params.projectId!);
        const { cfg } = await readUserConfig(deps.home).catch(configProblem);
        json(200, { timeoutMinutes: stepBudgetFor(cfg, projectId).timeoutMs / MINUTE_MS });
      },
    },
    {
      method: 'PUT',
      path: `${T}/:projectId`,
      handler: async ({ params, body, json }) => {
        const projectId = slugOf(params.projectId!);
        const timeoutMinutes = minutesOf(await body());
        await setStepTimeout(projectId, timeoutMinutes * MINUTE_MS, deps.home).catch(configProblem);
        json(200, { timeoutMinutes });
      },
    },
    {
      method: 'GET',
      path: A,
      handler: async ({ json }) => {
        const { cfg } = await readUserConfig(deps.home).catch(configProblem);
        json(200, automaticModelsOf(cfg.routing));
      },
    },
    {
      method: 'PUT',
      path: A,
      handler: async ({ body, json }) => {
        const models = automaticOf(await body());
        const cfg = await setAutomaticModels(models, deps.home).catch(configProblem);
        json(200, automaticModelsOf(cfg.routing));
      },
    },
    {
      method: 'GET',
      path: `${D}/:projectId`,
      handler: async ({ params, json }) => {
        const projectId = slugOf(params.projectId!);
        const { cfg } = await readUserConfig(deps.home).catch(configProblem);
        json(200, { agentsDecide: agentsDecideFor(cfg, projectId) });
      },
    },
    {
      method: 'PUT',
      path: `${D}/:projectId`,
      handler: async ({ params, body, json }) => {
        const projectId = slugOf(params.projectId!);
        const agentsDecide = agentsDecideOf(await body());
        await setAgentsDecide(projectId, agentsDecide, deps.home).catch(configProblem);
        json(200, { agentsDecide });
      },
    },
  ];
}
