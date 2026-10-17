import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ROLES } from '../config/config.js';
import { PINNED_SKILLS, type PinnedSkill } from './catalog.js';
import { skillCacheDir } from './store.js';

/** Keys a skill may not carry into an agent: they would widen its permissions or run commands. */
const DROPPED_KEYS = new Set(['allowed-tools', 'hooks', 'mcpServers']);
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

const exists = (file: string): Promise<boolean> => fs.access(file).then(() => true, () => false);

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
    const used = new Set<string>();
    for (const skill of skills) {
      const source = path.join(skillCacheDir(cacheRoot, skill), skill.sourcePath ?? '.');
      if (!(await exists(source))) throw new Error(`${skill.id} is not synced at ${source}: run the sync first`);
      for (const folder of await skillFolders(source)) {
        const base = path.basename(folder);
        const name = used.has(base) ? `${skill.id}-${base}` : base;
        if (used.has(name)) throw new Error(`skill ${name} is used twice in role ${role}`);
        used.add(name);
        await copySkill(folder, path.join(staged, 'skills', name), name);
      }
    }
    await fs.mkdir(path.join(staged, '.claude-plugin'), { recursive: true });
    await fs.writeFile(path.join(staged, '.claude-plugin', 'plugin.json'), `${JSON.stringify({ name: `teams-ai-${role}`, version: '1.0.0', description: `Skills installed for the ${role} role` }, null, 2)}\n`);
    await fs.rename(staged, target);
  }
}
