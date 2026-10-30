import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GLOBAL_RULES, SKILL_NOTICE } from '../../server/agents/global-rules.js';
import { loadAgents } from '../../server/agents/registry.js';
import { ROLES } from '../../server/config/roles.js';
import { buildInvocation } from '../../server/runner/invocation.js';

const AGENTS_DIR = path.resolve('.claude/agents');

describe('global rules', () => {
  it('state the English code rule and say they outrank every other instruction', () => {
    expect(GLOBAL_RULES).toContain('100% English');
    expect(GLOBAL_RULES).toContain('outrank');
    expect(GLOBAL_RULES).toContain('Brazilian Portuguese (pt-BR)');
    expect(GLOBAL_RULES).toContain('A reviewer reports a breach of rule 1 as a defect');
  });

  it('stay short, so every step pays little for them', () => {
    expect(GLOBAL_RULES.length).toBeLessThanOrEqual(1500);
  });

  it('tell every skill that the global rules outrank it', () => {
    expect(SKILL_NOTICE).toContain('Global rules');
  });
});

describe('agent prompts', () => {
  it.each(ROLES)('give the %s role a system prompt that starts with the global rules, once', async (role) => {
    const agents = await loadAgents(AGENTS_DIR);
    const inv = buildInvocation(
      {
        role,
        model: 'opus',
        profile: { model: 'opus' },
        cwd: '/w',
        prompt: 'p',
        jsonSchema: {},
        tools: agents[role].tools,
        disallowedTools: [],
        settingsPath: '/s.json',
        agentDefinition: agents[role],
        agentsPath: path.join(os.tmpdir(), `${role}.agents.json`),
      },
      {},
    );
    const prompt = JSON.parse(inv.agentsFile.content)[role].prompt as string;
    expect(prompt.startsWith(`${GLOBAL_RULES}\n\n`)).toBe(true);
    expect(prompt.split(GLOBAL_RULES)).toHaveLength(2);
    expect(prompt).toContain(agents[role].body);
  });

  it('keep one role file per role of the code, so no role runs without its rules', () => {
    const files = readdirSync(AGENTS_DIR)
      .filter((file) => file.endsWith('.md'))
      .map((file) => file.replace(/\.md$/, ''))
      .sort();
    expect(files).toEqual([...ROLES].sort());
  });

  it('name no language: the language rule lives only in GLOBAL_RULES', () => {
    for (const role of ROLES) expect(readFileSync(path.join(AGENTS_DIR, `${role}.md`), 'utf8')).not.toMatch(/pt-BR|Brazilian|Portuguese/);
  });
});
