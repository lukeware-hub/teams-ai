import { AgentSetting, ROLES, type Role } from '../config/config.js';
import { ID_PATTERNS } from '../core/ids.js';
import { readUserConfig, setAgentSetting } from '../onboarding/config-store.js';
import { HttpError, type Route } from './server.js';
import { configProblem } from './onboarding-routes.js';

export interface SettingsDeps {
  home?: string;
}

const P = '/api/settings/agents';

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

export function settingsRoutes(deps: SettingsDeps): Route[] {
  return [
    {
      method: 'GET',
      path: `${P}/:projectId`,
      handler: async ({ params, json }) => {
        const projectId = slugOf(params.projectId!);
        const { cfg } = await readUserConfig(deps.home).catch(configProblem);
        const settings = cfg.agentSettings[projectId] ?? {};
        json(200, { agents: ROLES.map((role) => ({ role, setting: settings[role] ?? null })) });
      },
    },
    {
      method: 'PUT',
      path: `${P}/:projectId/:role`,
      handler: async ({ params, body, json }) => {
        const projectId = slugOf(params.projectId!);
        const role = roleOf(params.role!);
        const setting = settingOf(await body());
        await setAgentSetting(projectId, role, setting, deps.home).catch(configProblem);
        json(200, { setting });
      },
    },
  ];
}
