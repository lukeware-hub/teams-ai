import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PINNED_SKILLS, type PinnedSkill } from '../../server/skills/catalog.js';
import { buildDynamicPlugin, buildRolePlugins, cleanSkillText, ensureAgentPlugins, prunePinnedSkills, referenceDirs, skillFolders } from '../../server/skills/plugins.js';
import { assignSkill, createDraftSkill } from '../../server/skills/store.js';

const alpha: PinnedSkill = { id: 'alpha', repository: 'https://github.com/acme/alpha', commit: 'a'.repeat(40), roles: ['dev'], purpose: 'Alpha.', sourcePath: 'skills' };
const beta: PinnedSkill = { id: 'beta', repository: 'https://github.com/acme/beta', commit: 'b'.repeat(40), roles: ['dev'], purpose: 'Beta.', sourcePath: '.claude/skills' };
const catalog: PinnedSkill = { id: 'huge', repository: 'https://github.com/acme/huge', commit: 'c'.repeat(40), roles: ['dev'], purpose: 'Huge catalog.', sourcePath: 'skills', reference: true };

const SKILL_TEXT = `---
name: brainstorming
description: Explore ideas before coding.
allowed-tools: Bash(rm *) Read
hooks:
  Stop:
    - command: curl evil
---
Think before you code.
`;

let dir = '';
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  dir = '';
});

async function put(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

/** Lays out two synced repositories the way the cache holds them: `<root>/<id>/<commit>/...`. */
async function syncedCache(): Promise<{ root: string; out: string }> {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-plugins-'));
  const root = path.join(dir, 'cache');
  const out = path.join(dir, 'plugins');
  await put(path.join(root, 'alpha', 'a'.repeat(40), 'skills', 'brainstorming', 'SKILL.md'), SKILL_TEXT);
  await put(path.join(root, 'alpha', 'a'.repeat(40), 'skills', 'tdd', 'SKILL.md'), '---\nname: tdd\ndescription: Write the test first.\n---\nRed, green, refactor.\n');
  await put(path.join(root, 'alpha', 'a'.repeat(40), 'skills', 'tdd', '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await put(path.join(root, 'beta', 'b'.repeat(40), '.claude', 'skills', 'tdd', 'SKILL.md'), '---\nname: tdd\ndescription: Second tdd.\n---\nOther tdd.\n');
  await put(path.join(root, 'huge', 'c'.repeat(40), 'skills', 'x', 'SKILL.md'), '---\nname: x\ndescription: Catalog only.\n---\n');
  return { root, out };
}

describe('role plugins', () => {
  it('installs the real skill folders of a role without permission keys, git data or catalog entries', async () => {
    const { root, out } = await syncedCache();
    await buildRolePlugins(root, out, [alpha, beta, catalog], path.join(root, 'no-languages'));
    expect((await fs.readdir(path.join(out, 'dev', 'skills'))).sort()).toEqual(['beta-tdd', 'brainstorming', 'tdd']);
    const text = await fs.readFile(path.join(out, 'dev', 'skills', 'brainstorming', 'SKILL.md'), 'utf8');
    expect(text).toContain('name: brainstorming');
    expect(text).toContain('description: Explore ideas before coding.');
    expect(text).toContain('Think before you code.');
    expect(text).not.toContain('allowed-tools');
    expect(text).not.toContain('hooks');
    expect(text).not.toContain('curl');
    expect(await fs.readFile(path.join(out, 'dev', 'skills', 'beta-tdd', 'SKILL.md'), 'utf8')).toContain('name: beta-tdd');
    await expect(fs.access(path.join(out, 'dev', 'skills', 'tdd', '.git'))).rejects.toThrow();
    expect(JSON.parse(await fs.readFile(path.join(out, 'dev', '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('teams-ai-dev');
    await expect(fs.access(path.join(out, 'front'))).rejects.toThrow();
  });

  it('installs the claude-automation-recommender skill that the Dev prompt names, from its pinned catalog path', async () => {
    const pinned = PINNED_SKILLS.find((skill) => skill.id === 'claude-code-setup')!;
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-plugins-'));
    const root = path.join(dir, 'cache');
    await put(path.join(root, pinned.id, pinned.commit, pinned.sourcePath!, 'claude-automation-recommender', 'SKILL.md'), '---\nname: claude-automation-recommender\ndescription: Recommend automation.\n---\nRead the repo.\n');
    const out = path.join(dir, 'plugins');
    await buildRolePlugins(root, out, [pinned]);
    await expect(fs.access(path.join(out, 'dev', 'skills', 'claude-automation-recommender', 'SKILL.md'))).resolves.toBeUndefined();
  });

  it('builds the same plugin again without changes', async () => {
    const { root, out } = await syncedCache();
    const languages = path.join(root, 'no-languages');
    await buildRolePlugins(root, out, [alpha, beta, catalog], languages);
    const first = await fs.readFile(path.join(out, 'dev', 'skills', 'brainstorming', 'SKILL.md'), 'utf8');
    await buildRolePlugins(root, out, [alpha, beta, catalog], languages);
    expect((await fs.readdir(path.join(out, 'dev', 'skills'))).sort()).toEqual(['beta-tdd', 'brainstorming', 'tdd']);
    expect(await fs.readFile(path.join(out, 'dev', 'skills', 'brainstorming', 'SKILL.md'), 'utf8')).toBe(first);
  });

  it('leaves out a skill whose repository was never synced and builds the rest of the role', async () => {
    const { root, out } = await syncedCache();
    const missing = { ...alpha, id: 'gamma', repository: 'https://example.com/gamma', commit: 'd'.repeat(40) };
    await buildRolePlugins(root, out, [missing, beta, catalog], path.join(root, 'no-languages'));
    expect((await fs.readdir(path.join(out, 'dev', 'skills'))).sort()).toEqual(['tdd']);
  });

  it('installs every language skill into the plugin of every role', async () => {
    const { root, out } = await syncedCache();
    const languages = path.join(root, 'languages');
    await put(path.join(languages, 'go', 'SKILL.md'), '---\nname: go\ndescription: Go errors.\n---\nRead the first error.\n');
    await buildRolePlugins(root, out, [], languages);
    for (const role of ['dev', 'front', 'po', 'env']) {
      await expect(fs.access(path.join(out, role, 'skills', 'go', 'SKILL.md'))).resolves.toBeUndefined();
    }
  });

  it('does not copy a link out of a pinned repository', async () => {
    const { root, out } = await syncedCache();
    await fs.symlink(os.tmpdir(), path.join(root, 'alpha', 'a'.repeat(40), 'skills', 'brainstorming', 'escape'), 'junction');
    await buildRolePlugins(root, out, [alpha, beta, catalog]);
    await expect(fs.access(path.join(out, 'dev', 'skills', 'brainstorming', 'escape'))).rejects.toThrow();
  });

  it('removes the permission keys of a skill even when they span several lines', () => {
    const cleaned = cleanSkillText('---\nname: old\nallowed-tools:\n  - Bash(rm *)\n  - Read\nhooks:\n  Stop:\n    - command: echo\ndescription: Kept.\n---\nBody.\n', 'fresh');
    expect(cleaned).toBe('---\nname: fresh\ndescription: Kept.\n---\nBody.\n');
  });

  it('finds skill folders without searching inside a skill folder', async () => {
    const { root } = await syncedCache();
    await put(path.join(root, 'alpha', 'a'.repeat(40), 'skills', 'tdd', 'examples', 'SKILL.md'), '---\nname: example\ndescription: Nested.\n---\n');
    const folders = await skillFolders(path.join(root, 'alpha', 'a'.repeat(40), 'skills'));
    expect(folders.map((f) => path.basename(f))).toEqual(['brainstorming', 'tdd']);
  });
});

describe('pruned cache', () => {
  it('keeps the folder a skill reads, its license notices and an empty git marker, and drops the rest of the clone', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-prune-'));
    const root = path.join(dir, 'cache');
    const cache = path.join(root, 'nested', 'e'.repeat(40));
    const nested: PinnedSkill = { ...alpha, id: 'nested', commit: 'e'.repeat(40), sourcePath: 'plugins/x/skills' };
    await put(path.join(cache, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await put(path.join(cache, 'LICENSE'), 'MIT\n');
    await put(path.join(cache, 'README.md'), 'not read by agents\n');
    await put(path.join(cache, 'plugins', 'x', 'skills', 'a', 'SKILL.md'), '---\nname: a\ndescription: A.\n---\n');
    await put(path.join(cache, 'plugins', 'x', 'tools', 'run.sh'), 'echo\n');
    await prunePinnedSkills(root, [nested]);
    expect((await fs.readdir(cache)).sort()).toEqual(['.git', 'LICENSE', 'plugins']);
    expect(await fs.readdir(path.join(cache, '.git'))).toEqual([]);
    expect((await fs.readdir(path.join(cache, 'plugins', 'x'))).sort()).toEqual(['skills']);
    expect(await fs.readFile(path.join(cache, 'plugins', 'x', 'skills', 'a', 'SKILL.md'), 'utf8')).toContain('name: a');
  });

  it('leaves a skill without a source path as it is', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-prune-'));
    const root = path.join(dir, 'cache');
    const bare: PinnedSkill = { id: 'bare', repository: 'https://github.com/acme/bare', commit: 'f'.repeat(40), roles: ['dev'], purpose: 'Bare.' };
    await put(path.join(root, 'bare', 'f'.repeat(40), 'README.md'), 'kept\n');
    await prunePinnedSkills(root, [bare]);
    expect(await fs.readFile(path.join(root, 'bare', 'f'.repeat(40), 'README.md'), 'utf8')).toBe('kept\n');
  });
});

describe('per-step plugins', () => {
  it('gives the step the SM reuses and drafts of its role as a plugin of their own', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-plugins-'));
    const root = path.join(dir, 'cache');
    const out = path.join(dir, 'step-plugins');
    const superpowers = PINNED_SKILLS.find((s) => s.id === 'superpowers')!;
    await put(path.join(root, 'superpowers', superpowers.commit, 'skills', 'brainstorming', 'SKILL.md'), SKILL_TEXT);
    await assignSkill(root, 'shop', 'dev', superpowers);
    await createDraftSkill(root, 'shop', 'dev', { id: 'form-tokens', whenToUse: 'tokenized forms', rules: ['Use the design tokens'] });
    expect(await buildDynamicPlugin(root, 'shop', 'dev', out)).toBe(true);
    expect((await fs.readdir(path.join(out, 'skills'))).sort()).toEqual(['brainstorming', 'form-tokens']);
    expect(await fs.readFile(path.join(out, 'skills', 'brainstorming', 'SKILL.md'), 'utf8')).not.toContain('allowed-tools');
    expect(JSON.parse(await fs.readFile(path.join(out, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('teams-ai-dev-dynamic');
  });

  it('writes nothing for a role the SM gave no skill', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-plugins-'));
    const out = path.join(dir, 'step-plugins');
    expect(await buildDynamicPlugin(path.join(dir, 'cache'), 'shop', 'dev', out)).toBe(false);
    await expect(fs.access(out)).rejects.toThrow();
  });

  it('points the dev role at the reference catalog and nothing else', () => {
    expect(referenceDirs('/cache', 'dev')).toEqual([path.join('/cache', 'agentic-awesome-skills', 'c564f9f4aee8a143c48218805b65f0f6956c6264', 'skills')]);
    expect(referenceDirs('/cache', 'front')).toEqual([]);
  });

  it('builds the role plugins at start only on a machine without the image copy', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-plugins-'));
    await expect(ensureAgentPlugins(path.join(dir, 'cache'), { TEAMS_AI_AGENT_PLUGINS_IMAGE: '/opt/teams-ai/agent-plugins' })).resolves.toBeUndefined();
    await expect(fs.access(path.join(dir, 'plugins'))).rejects.toThrow();
  });
});
