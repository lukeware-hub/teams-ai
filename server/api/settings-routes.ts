import { AgentSetting, Config, DEFAULT_AGENT_SETTING, ROLES, PLAN_AGENTS_MAX, TIMER_MAX_MS, stepBudgetFor, type Role } from '../config/config.js';
import { ID_PATTERNS } from '../core/ids.js';
import { effortFor } from '../runner/model-policy.js';
import { readUserConfig, setAgentSetting, setSpeckitAgents, setStepTimeout } from '../onboarding/config-store.js';
import { HttpError, type Route } from './server.js';
import { configProblem } from './onboarding-routes.js';

export interface SettingsDeps {
  home?: string;
}

const P = '/api/settings/agents';
const T = '/api/settings/step-timeout';
const S = '/api/settings/plan-agents';
const MINUTE_MS = 60_000;

const slugOf = (id: string): string => {
  if (!ID_PATTERNS.SLUG.test(id)) throw new HttpError(400, 'project id is not a slug');
  return id;
};

const roleOf = (role: string): Role => {
  if (!(ROLES as readonly string[]).includes(role)) throw new HttpError(404, `unknown agent ${role}`);
  return role as Role;
};

/** `{mode:'auto'}` gives the agent back to the orchestrator; `{mode:'manual', model, effort}` fixes both. */
const settingOf = (input: unknown): AgentSetting | null => {
  const body = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  if (body.mode === 'auto') return null;
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

/** `{agents}` from the Settings page: how many agents prepare the plan items at once, a whole number from 1 to 5. */
const agentsOf = (input: unknown): number => {
  const agents = (input as { agents?: unknown } | null)?.agents;
  if (typeof agents !== 'number' || !Number.isInteger(agents) || agents < 1 || agents > PLAN_AGENTS_MAX) {
    throw new HttpError(400, `agents must be a whole number from 1 to ${PLAN_AGENTS_MAX}`);
  }
  return agents;
};

/** The model and effort an automatic role uses by default: its role profile model, at the effort the model allows when nothing is asked. */
const automaticSetting = (cfg: Config, role: Role): AgentSetting => {
  const model = cfg.roles[role].model;
  return { model, effort: effortFor(model, undefined) } as AgentSetting;
};

/** What a role runs on now: its manual setting, else the automatic default. */
const inUseOf = (cfg: Config, role: Role, setting: AgentSetting | null): AgentSetting => setting ?? automaticSetting(cfg, role);

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
          agents: ROLES.map((role) => {
            const setting = role in settings ? settings[role] ?? null : DEFAULT_AGENT_SETTING;
            return { role, setting, inUse: inUseOf(cfg, role, setting) };
          }),
        });
      },
    },
    {
      method: 'PUT',
      path: `${P}/:projectId/:role`,
      handler: async ({ params, body, json }) => {
        const projectId = slugOf(params.projectId!);
        const role = roleOf(params.role!);
        const setting = settingOf(await body());
        const cfg = await setAgentSetting(projectId, role, setting, deps.home).catch(configProblem);
        json(200, { setting, inUse: inUseOf(cfg, role, setting) });
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
  ];
}
