import { AgentSetting, automaticSettingsOf, Config, defaultAgentSetting, isSlot, PLAN_AGENTS_MAX, SETTING_KEYS, storedSettingOf, TIMER_MAX_MS, agentsDecideFor, stepBudgetFor, type AutomaticRow, type AutomaticSettings, type Role, type SettingKey } from '../config/config.js';
import { ID_PATTERNS } from '../core/ids.js';
import { effortFor } from '../runner/model-policy.js';
import type { Effort } from '../decide/decisions/model-tier.js';
import { readUserConfig, setAgentSetting, setAgentsDecide, setAutomaticSettings, setSpeckitAgents, setStepTimeout } from '../onboarding/config-store.js';
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

/** `{tiers, architecture, laterCycle, naming, defaultEffort, effortCaps}` from the Settings page: each row a model the agents accept and an effort. */
const automaticOf = (input: unknown): AutomaticSettings => {
  const body = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const tiers = typeof body.tiers === 'object' && body.tiers !== null ? (body.tiers as Record<string, unknown>) : {};
  const caps = typeof body.effortCaps === 'object' && body.effortCaps !== null ? (body.effortCaps as Record<string, unknown>) : {};
  const rowOf = (value: unknown): AutomaticRow => {
    const parsed = AgentSetting.safeParse(value);
    if (!parsed.success) throw new HttpError(400, 'each row needs a model the agents accept and an effort of low, medium, high or max');
    return parsed.data;
  };
  const effortOf = (value: unknown): Effort => {
    const parsed = AgentSetting.shape.effort.safeParse(value);
    if (!parsed.success) throw new HttpError(400, 'O esforço deve ser low, medium, high ou max.');
    return parsed.data;
  };
  return {
    tiers: { small: rowOf(tiers.small), medium: rowOf(tiers.medium), large: rowOf(tiers.large) },
    architecture: rowOf(body.architecture),
    laterCycle: rowOf(body.laterCycle),
    // The naming step has its own model and effort.
    naming: rowOf(body.naming),
    defaultEffort: effortOf(body.defaultEffort),
    effortCaps: { haiku: effortOf(caps.haiku), sonnet: effortOf(caps.sonnet), opus: effortOf(caps.opus) },
  };
};

/** The model and effort an automatic role uses by default: its role profile model, at the default effort when nothing is asked, held to the caps. */
const automaticSetting = (cfg: Config, role: Role): AgentSetting => {
  const model = cfg.roles[role].model;
  return { model, effort: effortFor(model, undefined, cfg.routing.efforts.automatic, cfg.routing.automaticEffortCap) } as AgentSetting;
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
        json(200, automaticSettingsOf(cfg.routing));
      },
    },
    {
      method: 'PUT',
      path: A,
      handler: async ({ body, json }) => {
        const settings = automaticOf(await body());
        const cfg = await setAutomaticSettings(settings, deps.home).catch(configProblem);
        json(200, automaticSettingsOf(cfg.routing));
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
