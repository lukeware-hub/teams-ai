import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ConfigError, loadConfig, type AgentSetting, type Config, type Role } from '../config/config.js';
import { updateFileAtomic } from '../core/atomic-write.js';
import { expandHome } from '../orchestrator/workspace.js';

/** GitHub login: 1–39 alphanumerics or single hyphens, no leading/trailing hyphen. */
export const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export function userConfigFile(home?: string): string {
  return path.join(expandHome('~/.teams-ai', home), 'config.json');
}

/**
 * The keys of config.json, `{}` when there is no file yet. Anything else that goes wrong throws and leaves the file
 * alone: reading a corrupt or momentarily unreadable config as empty would let the next write replace all of it with
 * one key. The message names the file but does not quote it (JSON.parse's own message carries a snippet of it).
 */
function parseUserConfig(text: string | undefined, file: string): Record<string, unknown> {
  if (text === undefined) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON; fix or delete it (it was left unchanged)`, { cause: err });
  }
}

/** The CLI reads this file with `loadConfig(JSON.parse(...))`; the UI writes only the keys it owns. */
export async function readUserConfig(home?: string): Promise<{ raw: Record<string, unknown>; cfg: Config }> {
  const file = userConfigFile(home);
  const text = await fs.readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return undefined; // only a missing file is an empty config
    throw err;
  });
  const raw = parseUserConfig(text, file);
  return { raw, cfg: loadConfig(raw) };
}

/**
 * Read-modify-write of config.json. Updates in this process run one at a time, each on the file as the one before it
 * left it, so none is lost (see `updateFileAtomic`). `change` returns the new keys, or undefined to leave the file
 * alone; it can run again on a write by another process, so it may use only its arguments.
 */
async function updateUserConfig(home: string | undefined, change: (raw: Record<string, unknown>, cfg: Config) => Record<string, unknown> | undefined): Promise<Config> {
  const file = userConfigFile(home);
  await fs.mkdir(path.dirname(file), { recursive: true });
  let result!: Config; // set by the last run of the update below
  await updateFileAtomic(file, (text) => {
    const raw = parseUserConfig(text, file);
    const cfg = loadConfig(raw);
    const next = change(raw, cfg);
    if (next === undefined) {
      result = cfg;
      return undefined;
    }
    result = loadConfig(next); // validate before writing
    return `${JSON.stringify(next, null, 2)}\n`;
  });
  return result;
}

export async function setGithubOwner(owner: string, home?: string): Promise<Config> {
  if (!GITHUB_OWNER.test(owner)) throw new RangeError(`not a GitHub login: ${JSON.stringify(owner)}`);
  return updateUserConfig(home, (raw) => {
    const github = typeof raw.github === 'object' && raw.github !== null ? (raw.github as Record<string, unknown>) : {};
    return { ...raw, github: { ...github, owner } };
  });
}

/** Fixes one agent's model and effort in one project; `null` gives it back to the automatic choice. */
export async function setAgentSetting(projectId: string, role: Role, setting: AgentSetting | null, home?: string): Promise<Config> {
  return updateUserConfig(home, (raw, cfg) => {
    const roles = { ...cfg.agentSettings[projectId] };
    if (setting) roles[role] = setting;
    else delete roles[role];
    return { ...raw, agentSettings: { ...cfg.agentSettings, [projectId]: roles } };
  });
}

/** Sets how many agents prepare the Spec Kit items at once; the other settings stay. */
export async function setSpeckitAgents(agents: number, home?: string): Promise<Config> {
  return updateUserConfig(home, (raw, cfg) => ({ ...raw, concurrency: { ...cfg.concurrency, speckitAgents: agents } }));
}

/** Sets the time limit of each agent step of one project, in ms; its other settings stay. */
export async function setStepTimeout(projectId: string, timeoutMs: number, home?: string): Promise<Config> {
  return updateUserConfig(home, (raw, cfg) => ({ ...raw, stepTimeouts: { ...cfg.stepTimeouts, [projectId]: timeoutMs } }));
}

/** Drops a project's agent settings and time limit, so a project created later under the same id starts on the defaults. */
export async function removeProjectSettings(projectId: string, home?: string): Promise<Config> {
  return updateUserConfig(home, (raw, cfg) => {
    if (!(projectId in cfg.agentSettings) && !(projectId in cfg.stepTimeouts)) return undefined;
    const agentSettings = { ...cfg.agentSettings };
    const stepTimeouts = { ...cfg.stepTimeouts };
    delete agentSettings[projectId];
    delete stepTimeouts[projectId];
    return { ...raw, agentSettings, stepTimeouts };
  });
}

export async function addProject(dir: string, home?: string): Promise<Config> {
  return updateUserConfig(home, (raw, cfg) => (cfg.projects.some((p) => p.dir === dir) ? undefined : { ...raw, projects: [...cfg.projects, { dir }] }));
}

/** Drops every `dirs` entry from `projects`; used when a project is deleted, after its directories are removed from disk. */
export async function removeProjectDirs(dirs: readonly string[], home?: string): Promise<Config> {
  const set = new Set(dirs);
  return updateUserConfig(home, (raw, cfg) => (cfg.projects.some((p) => set.has(p.dir)) ? { ...raw, projects: cfg.projects.filter((p) => !set.has(p.dir)) } : undefined));
}
