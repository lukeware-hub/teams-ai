import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PINNED_SKILLS, skillsForRole } from '../../server/skills/catalog.js';
import type { Exec } from '../../server/exec/command.js';
import { acceptReuseSkill, assignSkill, capabilityKey, clearPrivateSkills, createDraftSkill, pinnedSkillsReady, seedPinnedSkills, skillCacheDir, syncPinnedSkills, syncSkill, validateSkill } from '../../server/skills/store.js';

describe('skill catalog', () => {
  it('pins a commit for every fetched skill and never uses latest', () => {
    for (const skill of PINNED_SKILLS) {
      expect(skill.commit).toMatch(/^[a-f0-9]{40}$/);
      expect(skill.repository).not.toMatch(/latest/i);
    }
    expect(skillsForRole('front').map((s) => s.id)).toEqual(expect.arrayContaining(['impeccable', 'taste-skill', 'ui-ux-pro-max', 'web-asset-generator', 'playwright-cli']));
    expect(skillsForRole('sm').map((s) => s.id)).toEqual(['find-skills']);
  });
});

describe('skill store', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = '';
  });

  it('rejects an unpinned or non-github reuse', () => {
    expect(validateSkill({ id: 'ok-skill', repository: 'https://github.com/acme/ok', commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', roles: ['dev'], purpose: 'x' })).toEqual([]);
    expect(validateSkill({ id: 'Bad', repository: 'https://github.com/acme/ok', commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', roles: ['dev'], purpose: 'x' })).toContain('skill id must be kebab-case');
    expect(validateSkill({ id: 'ok-skill', repository: 'https://gitlab.com/acme/ok', commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', roles: ['dev'], purpose: 'x' })).toContain('skill repository must be https://github.com');
    expect(acceptReuseSkill({ id: 'ok-skill', repository: 'https://github.com/teams-ai/private-skill', commit: '0000000000000000000000000000000000000000', roles: ['dev'], purpose: 'x' })).toContain('reused skill must come from a public GitHub repository');
  });

  it('normalizes a capability key for the journal cache', () => {
    expect(capabilityKey('  Validate   JSON Schema ')).toBe('validate json schema');
  });

  it('writes a private draft and refuses forbidden tools', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-skills-'));
    await createDraftSkill(dir, 'shop', 'dev', { id: 'form-tokens', whenToUse: 'tokenized forms', rules: ['Use the design tokens'] });
    expect(await fs.readFile(path.join(dir, 'private', 'shop', 'form-tokens', 'SKILL.md'), 'utf8')).toContain('Use the design tokens');
    await expect(createDraftSkill(dir, 'shop', 'dev', { id: 'push-main', whenToUse: 'ship', rules: ['run git push'] })).rejects.toThrow(/forbidden/);
  });

  it('seeds a home cache from the image copy and skips a skill that is already there', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-skills-'));
    const image = path.join(dir, 'image');
    const home = path.join(dir, 'home');
    const find = PINNED_SKILLS.find((s) => s.id === 'find-skills')!;
    await fs.mkdir(path.join(skillCacheDir(image, find), '.git'), { recursive: true });
    await fs.writeFile(path.join(skillCacheDir(image, find), 'SKILL.md'), 'find\n');
    expect(await pinnedSkillsReady(image)).toBe(false);
    expect(await seedPinnedSkills(image, home)).toBe(1);
    expect(await fs.readFile(path.join(skillCacheDir(home, find), 'SKILL.md'), 'utf8')).toBe('find\n');
    expect(await seedPinnedSkills(image, home)).toBe(0);
  });

  it('refuses a reused or drafted skill that takes a pinned id', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-skills-'));
    expect(acceptReuseSkill({ id: 'superpowers', repository: 'https://github.com/acme/ok', commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', roles: ['dev'], purpose: 'x' })).toContain('reused skill must be a pinned catalog skill');
    await expect(createDraftSkill(dir, 'shop', 'dev', { id: 'superpowers', whenToUse: 'tokenized forms', rules: ['Use the design tokens'] })).rejects.toThrow('skill id belongs to a pinned skill');
  });

  it('keeps a multi-line purpose on one line of the frontmatter', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-skills-'));
    await createDraftSkill(dir, 'shop', 'dev', { id: 'form-tokens', whenToUse: 'tokenized forms\nname: evil', rules: ['Use the design tokens'] });
    const text = await fs.readFile(path.join(dir, 'private', 'shop', 'form-tokens', 'SKILL.md'), 'utf8');
    expect(text.split('\n').slice(0, 4)).toEqual(['---', 'name: form-tokens', 'description: tokenized forms name: evil', '---']);
  });

  it('leaves no partial copy in the cache when a pinned fetch fails', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-skills-'));
    const find = PINNED_SKILLS.find((s) => s.id === 'find-skills')!;
    const offline: Exec = async (req) => ({ exitCode: req.args[0] === 'fetch' ? 1 : 0, signal: null, stdout: '', stderr: 'could not resolve host', timedOut: false, durationMs: 1, truncated: false });
    await expect(syncSkill(dir, find, offline)).rejects.toThrow('could not resolve host');
    expect(await fs.readdir(path.join(dir, find.id))).toEqual([]);
  });

  it('reuses only the pinned catalog entry, with its own repository and commit', () => {
    const find = PINNED_SKILLS.find((s) => s.id === 'find-skills')!;
    expect(acceptReuseSkill({ ...find, roles: ['dev'] })).toEqual([]);
    expect(acceptReuseSkill({ ...find, roles: ['dev'], repository: 'https://github.com/acme/find-skills' })).toContain('reused skill must be a pinned catalog skill');
  });

  it('syncs the other pinned skills when one fetch fails', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-skills-'));
    const broken = PINNED_SKILLS.find((s) => s.id === 'impeccable')!;
    const other = PINNED_SKILLS.find((s) => s.id === 'taste-skill')!;
    const exec: Exec = async (req) => {
      if (req.args[0] === 'init') await fs.mkdir(path.join(req.cwd!, '.git'), { recursive: true });
      const fails = req.args[0] === 'fetch' && req.args.includes(broken.commit);
      return { exitCode: fails ? 1 : 0, signal: null, stdout: '', stderr: 'could not resolve host', timedOut: false, durationMs: 1, truncated: false };
    };
    await expect(syncPinnedSkills(dir, exec)).rejects.toThrow('impeccable: git fetch failed: could not resolve host');
    await expect(fs.access(path.join(skillCacheDir(dir, other), '.git'))).resolves.toBeUndefined();
  });

  it('drops the private drafts of a project and keeps its pinned assignments', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-skills-'));
    const find = PINNED_SKILLS.find((s) => s.id === 'find-skills')!;
    await createDraftSkill(dir, 'shop', 'dev', { id: 'form-tokens', whenToUse: 'tokenized forms', rules: ['Use the design tokens'] });
    await assignSkill(dir, 'shop', 'dev', find);
    await clearPrivateSkills(dir, 'shop');
    await expect(fs.access(path.join(dir, 'private', 'shop'))).rejects.toThrow();
    const assigned = JSON.parse(await fs.readFile(path.join(dir, 'assignments', 'shop', 'dev.json'), 'utf8')) as Array<{ id: string }>;
    expect(assigned.map((s) => s.id)).toEqual(['find-skills']);
  });
});
