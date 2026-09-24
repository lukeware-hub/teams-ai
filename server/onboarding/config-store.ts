import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig, type Config } from '../config/config.js';
import { expandHome } from '../orchestrator/workspace.js';

/** GitHub login: 1–39 alphanumerics or single hyphens, no leading/trailing hyphen. */
export const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export function userConfigFile(home?: string): string {
  return path.join(expandHome('~/.teams-ai', home), 'config.json');
}

/** The CLI reads this file with `loadConfig(JSON.parse(...))`; the UI writes only the keys it owns. */
export async function readUserConfig(home?: string): Promise<{ raw: Record<string, unknown>; cfg: Config }> {
  const raw = await fs
    .readFile(userConfigFile(home), 'utf8')
    .then((t) => JSON.parse(t) as Record<string, unknown>)
    .catch(() => ({}) as Record<string, unknown>);
  return { raw, cfg: loadConfig(raw) };
}

async function writeUserConfig(next: Record<string, unknown>, home?: string): Promise<Config> {
  const cfg = loadConfig(next); // validate before writing
  const file = userConfigFile(home);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
  await fs.rename(tmp, file);
  return cfg;
}

export async function setGithubOwner(owner: string, home?: string): Promise<Config> {
  if (!GITHUB_OWNER.test(owner)) throw new RangeError(`not a GitHub login: ${JSON.stringify(owner)}`);
  const { raw } = await readUserConfig(home);
  const github = typeof raw.github === 'object' && raw.github !== null ? (raw.github as Record<string, unknown>) : {};
  return writeUserConfig({ ...raw, github: { ...github, owner } }, home);
}

export async function addProject(dir: string, home?: string): Promise<Config> {
  const { raw, cfg } = await readUserConfig(home);
  if (cfg.projects.some((p) => p.dir === dir)) return cfg;
  return writeUserConfig({ ...raw, projects: [...cfg.projects, { dir }] }, home);
}
