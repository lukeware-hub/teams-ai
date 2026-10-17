import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Role } from '../config/config.js';
import type { Exec } from '../exec/command.js';
import { PINNED_SKILLS, type PinnedSkill } from './catalog.js';

const SAFE_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SHA = /^[a-f0-9]{40}$/;
const isPinnedId = (id: string): boolean => PINNED_SKILLS.some((skill) => skill.id === id);
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
/** A reuse names a pinned skill with its own repository and commit, never one the SM chose. */
const matchesCatalog = (skill: PinnedSkill): boolean => PINNED_SKILLS.some((pinned) => pinned.id === skill.id && pinned.repository === skill.repository && pinned.commit === skill.commit);

export function validateSkill(skill: PinnedSkill): string[] {
  const errors: string[] = [];
  if (!SAFE_ID.test(skill.id)) errors.push('skill id must be kebab-case');
  if (!SHA.test(skill.commit)) errors.push('skill commit must be a full SHA');
  try {
    const url = new URL(skill.repository);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') errors.push('skill repository must be https://github.com');
  } catch {
    errors.push('skill repository must be a URL');
  }
  if (skill.sourcePath && (path.isAbsolute(skill.sourcePath) || skill.sourcePath.split(/[\\/]/).includes('..'))) errors.push('skill sourcePath must stay inside the repository');
  return errors;
}

export const skillCacheDir = (root: string, skill: Pick<PinnedSkill, 'id' | 'commit'>): string => path.join(root, skill.id, skill.commit);
const assignmentFile = (root: string, scope: string, role: Role) => path.join(root, 'assignments', scope, `${role}.json`);

export async function assignedSkills(root: string, scope: string | undefined, role: Role): Promise<PinnedSkill[]> {
  if (!scope) return [];
  const parsed = await fs.readFile(assignmentFile(root, scope, role), 'utf8').then((text) => JSON.parse(text) as unknown).catch(() => []);
  return Array.isArray(parsed) ? parsed.filter((item): item is PinnedSkill => typeof item === 'object' && item !== null && validateSkill(item as PinnedSkill).length === 0 && (!isPinnedId((item as PinnedSkill).id) || matchesCatalog(item as PinnedSkill))) : [];
}

export function capabilityKey(capability: string): string {
  return capability.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function acceptReuseSkill(skill: PinnedSkill): string[] {
  const errors = validateSkill(skill);
  if (skill.repository.endsWith('/private-skill') || skill.commit === '0000000000000000000000000000000000000000') {
    errors.push('reused skill must come from a public GitHub repository');
  }
  if (!matchesCatalog(skill)) errors.push('reused skill must be a pinned catalog skill');
  return errors;
}

export async function assignSkill(root: string, scope: string, role: Role, skill: PinnedSkill): Promise<void> {
  const errors = acceptReuseSkill(skill);
  if (errors.length > 0) throw new Error(`${skill.id}: ${errors.join('; ')}`);
  const file = assignmentFile(root, scope, role);
  const current = await assignedSkills(root, scope, role);
  const next = [...current.filter((item) => item.id !== skill.id), { ...skill, roles: [role] }];
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(next, null, 2)}\n`);
}

export async function createDraftSkill(root: string, scope: string, role: Role, draft: { id: string; whenToUse: string; rules: readonly string[] }): Promise<void> {
  if (!SAFE_ID.test(draft.id)) throw new Error('skill id must be kebab-case');
  if (isPinnedId(draft.id)) throw new Error('skill id belongs to a pinned skill');
  const text = `${draft.whenToUse}\n${draft.rules.join('\n')}`;
  if (/\b(git push|docker|kubectl|gh\b|credential|secret value|outside the worktree)\b/i.test(text)) throw new Error('private skill requests a forbidden capability');
  const dir = path.join(root, 'private', scope, draft.id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${draft.id}\ndescription: ${oneLine(draft.whenToUse)}\n---\n\n${draft.rules.map((rule) => `- ${rule}`).join('\n')}\n`);
  const file = assignmentFile(root, scope, role);
  const current = await assignedSkills(root, scope, role);
  const privateSkill: PinnedSkill = { id: draft.id, repository: 'https://github.com/teams-ai/private-skill', commit: '0000000000000000000000000000000000000000', roles: [role], purpose: draft.whenToUse, sourcePath: path.relative(root, dir).replace(/\\/g, '/') };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify([...current.filter((item) => item.id !== draft.id), privateSkill], null, 2)}\n`);
}

/** A private draft lives only in the run that created it, so a new run drops its project's drafts. */
export async function clearPrivateSkills(root: string, scope: string): Promise<void> {
  await fs.rm(path.join(root, 'private', scope), { recursive: true, force: true });
  const dir = path.join(root, 'assignments', scope);
  for (const file of await fs.readdir(dir).catch(() => [] as string[])) {
    const current = await fs.readFile(path.join(dir, file), 'utf8').then((text) => JSON.parse(text) as PinnedSkill[]).catch(() => [] as PinnedSkill[]);
    await fs.writeFile(path.join(dir, file), `${JSON.stringify(current.filter((item) => !item.repository.endsWith('/private-skill')), null, 2)}\n`);
  }
}

async function run(exec: Exec, cwd: string, args: readonly string[]): Promise<void> {
  const result = await exec({ bin: 'git', args, cwd, timeoutMs: 120_000, outputLimit: 20_000 });
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr || result.stdout}`);
}

/** Builds a cache copy in a temp folder, then moves it to `target`; a copy another run finished first stands. */
async function publishCache(target: string, build: (temp: string) => Promise<void>): Promise<void> {
  const temp = `${target}.tmp-${process.pid}`;
  await fs.rm(temp, { recursive: true, force: true });
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await build(temp);
    await fs.rename(temp, target);
  } catch (error) {
    if (!(await hasGit(target))) throw error;
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

export async function syncSkill(root: string, skill: PinnedSkill, exec: Exec): Promise<string> {
  const errors = validateSkill(skill);
  if (errors.length > 0) throw new Error(`${skill.id}: ${errors.join('; ')}`);
  const target = skillCacheDir(root, skill);
  if (await hasGit(target)) return target;
  await publishCache(target, async (temp) => {
    await fs.mkdir(temp, { recursive: true });
    await run(exec, temp, ['init', '--quiet']);
    await run(exec, temp, ['remote', 'add', 'origin', skill.repository]);
    await run(exec, temp, ['fetch', '--quiet', '--depth', '1', 'origin', skill.commit]);
    await run(exec, temp, ['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
  });
  return target;
}

export async function syncPinnedSkills(root: string, exec: Exec): Promise<void> {
  const failed: string[] = [];
  for (const skill of PINNED_SKILLS) {
    if (skill.fetch === false) continue;
    await syncSkill(root, skill, exec).catch((error: Error) => failed.push(`${skill.id}: ${error.message}`));
  }
  if (failed.length > 0) throw new Error(failed.join('; '));
}

const hasGit = (dir: string) => fs.access(path.join(dir, '.git')).then(() => true, () => false);

export async function pinnedSkillsReady(root: string): Promise<boolean> {
  for (const skill of PINNED_SKILLS) {
    if (skill.fetch === false) continue;
    if (!(await hasGit(skillCacheDir(root, skill)))) return false;
  }
  return true;
}

export async function seedPinnedSkills(from: string, to: string): Promise<number> {
  let copied = 0;
  for (const skill of PINNED_SKILLS) {
    if (skill.fetch === false) continue;
    const src = skillCacheDir(from, skill);
    const dest = skillCacheDir(to, skill);
    if (!(await hasGit(src)) || (await hasGit(dest))) continue;
    await publishCache(dest, (temp) => fs.cp(src, temp, { recursive: true }));
    copied += 1;
  }
  return copied;
}

export async function ensurePinnedSkills(homeRoot: string, exec: Exec, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const imageRoot = env.TEAMS_AI_SKILLS_IMAGE || '/opt/teams-ai/skills';
  if (await pinnedSkillsReady(imageRoot)) {
    await seedPinnedSkills(imageRoot, homeRoot);
    return;
  }
  if (env.TEAMS_AI_SYNC_SKILLS !== '0') await syncPinnedSkills(homeRoot, exec);
}

