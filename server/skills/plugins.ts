import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROLES, type Role } from '../config/config.js';
import { PINNED_SKILLS, type PinnedSkill } from './catalog.js';
import { assignedSkills, skillCacheDir } from './store.js';

/** Keys a skill may not carry into an agent: they would widen its permissions or run commands. */
const DROPPED_KEYS = new Set(['allowed-tools', 'hooks', 'mcpServers']);
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

const exists = (file: string): Promise<boolean> => fs.access(file).then(() => true, () => false);
const catalogEntry = (id: string): PinnedSkill | undefined => PINNED_SKILLS.find((pinned) => pinned.id === id);
const catalogSource = (skill: PinnedSkill): string => skill.sourcePath ?? '.';

/** The skill text with `name` set to its folder name, and the keys in DROPPED_KEYS removed. */
export function cleanSkillText(text: string, name: string): string {
  const match = text.match(FRONTMATTER);
  if (!match) throw new Error(`skill ${name} has no frontmatter`);
  const kept: string[] = [];
  let dropping = false;
  for (const line of match[1]!.split(/\r?\n/)) {
    const key = line.match(/^([A-Za-z][\w-]*):/)?.[1];
    if (key !== undefined) {
      dropping = DROPPED_KEYS.has(key);
      if (key === 'name') continue;
    }
    if (!dropping) kept.push(line);
  }
  return `---\nname: ${name}\n${kept.join('\n')}\n---\n${text.slice(match[0].length)}`;
}

/** Every folder under `source` that holds a SKILL.md; a skill folder is not searched further. */
export async function skillFolders(source: string): Promise<string[]> {
  if (await exists(path.join(source, 'SKILL.md'))) return [source];
  const found: string[] = [];
  for (const entry of await fs.readdir(source, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.name === '.git' || entry.name === 'node_modules') continue;
    found.push(...(await skillFolders(path.join(source, entry.name))));
  }
  return found.sort();
}

async function copySkill(from: string, to: string, name: string): Promise<void> {
  await fs.cp(from, to, { recursive: true, filter: (entry) => !entry.split(/[\\/]/).includes('.git') });
  const file = path.join(to, 'SKILL.md');
  await fs.writeFile(file, cleanSkillText(await fs.readFile(file, 'utf8'), name));
}

/** Where the role plugins live: the image copy when set, otherwise this user's home folder. */
export function agentPluginsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.TEAMS_AI_AGENT_PLUGINS_IMAGE || path.join(os.homedir(), '.teams-ai', 'agent-plugins');
}

/** Copies every skill folder of `sources` into `staged/skills`; a name already used gets the catalog id in front. */
async function installSkills(staged: string, sources: ReadonlyArray<{ id: string; source: string }>, owner: string): Promise<void> {
  const used = new Set<string>();
  for (const { id, source } of sources) {
    if (!(await exists(source))) throw new Error(`${id} is not synced at ${source}: run the sync first`);
    for (const folder of await skillFolders(source)) {
      const base = path.basename(folder);
      const name = used.has(base) ? `${id}-${base}` : base;
      if (used.has(name)) throw new Error(`skill ${name} is used twice in ${owner}`);
      used.add(name);
      await copySkill(folder, path.join(staged, 'skills', name), name);
    }
  }
}

async function writePlugin(dir: string, name: string, role: Role): Promise<void> {
  await fs.mkdir(path.join(dir, '.claude-plugin'), { recursive: true });
  await fs.writeFile(path.join(dir, '.claude-plugin', 'plugin.json'), `${JSON.stringify({ name, version: '1.0.0', description: `Skills installed for the ${role} role` }, null, 2)}\n`);
}

/**
 * Installs the native skills of every role as a plugin folder `<outRoot>/<role>`: the real skill folders of the
 * pinned repositories, as upstream ships them. Roles with no native skill get no folder. Built once, then read-only.
 */
export async function buildRolePlugins(cacheRoot: string, outRoot: string, catalog: readonly PinnedSkill[] = PINNED_SKILLS): Promise<void> {
  for (const role of ROLES) {
    const target = path.join(outRoot, role);
    const skills = catalog.filter((skill) => !skill.reference && skill.roles.includes(role));
    await fs.rm(target, { recursive: true, force: true });
    if (skills.length === 0) continue;
    const staged = `${target}.tmp-${process.pid}`;
    await fs.rm(staged, { recursive: true, force: true });
    await installSkills(staged, skills.map((skill) => ({ id: skill.id, source: path.join(skillCacheDir(cacheRoot, skill), catalogSource(skill)) })), `role ${role}`);
    await writePlugin(staged, `teams-ai-${role}`, role);
    await fs.rename(staged, target);
  }
}

/**
 * The reuses and private drafts the SM gave one role of a project, as a plugin folder for one step.
 * Returns false when the role has none, and then writes nothing.
 */
export async function buildDynamicPlugin(cacheRoot: string, scope: string, role: Role, out: string): Promise<boolean> {
  const assigned = (await assignedSkills(cacheRoot, scope, role)).filter((skill) => skill.repository.endsWith('/private-skill') || catalogEntry(skill.id));
  if (assigned.length === 0) return false;
  await installSkills(out, assigned.map((skill) => ({
    id: skill.id,
    source: skill.repository.endsWith('/private-skill') ? path.join(cacheRoot, skill.sourcePath ?? '') : path.join(skillCacheDir(cacheRoot, skill), catalogSource(catalogEntry(skill.id)!)),
  })), `the ${role} role of ${scope}`);
  await writePlugin(out, `teams-ai-${role}-dynamic`, role);
  return true;
}

/** The reference catalogs a role searches with Grep: their folders in the cache, never installed as skills. */
export function referenceDirs(cacheRoot: string, role: Role, catalog: readonly PinnedSkill[] = PINNED_SKILLS): string[] {
  return catalog.filter((skill) => skill.reference && skill.roles.includes(role)).map((skill) => path.join(skillCacheDir(cacheRoot, skill), catalogSource(skill)));
}

/** Builds the role plugins from the synced cache when this machine has no image copy (a development install). */
export async function ensureAgentPlugins(cacheRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (env.TEAMS_AI_AGENT_PLUGINS_IMAGE) return;
  await buildRolePlugins(cacheRoot, agentPluginsRoot(env));
}
