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
    expect(GLOBAL_RULES).toContain('A reviewer reports a breach of the language rule as a defect');
    expect(GLOBAL_RULES).toContain('at least 90% test coverage');
    expect(GLOBAL_RULES).toContain('8. Before you finish a task');
  });

  it('make the five main documents the only source of truth, with the spec, plan and tasks derived from them', () => {
    expect(GLOBAL_RULES).toContain('the only source of truth of every project');
    expect(GLOBAL_RULES).toContain('derived from them');
    expect(GLOBAL_RULES).toContain('the document wins');
  });

  it('stay within the size a system prompt can carry', () => {
    expect(GLOBAL_RULES.length).toBeLessThanOrEqual(6000);
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

  it.each(ROLES)('state in the %s role file that the five main documents are the only source of truth', (role) => {
    expect(readFileSync(path.join(AGENTS_DIR, `${role}.md`), 'utf8')).toContain('only source of truth');
  });

  it('name no language: the language rule lives only in GLOBAL_RULES', () => {
    for (const role of ROLES) expect(readFileSync(path.join(AGENTS_DIR, `${role}.md`), 'utf8')).not.toMatch(/pt-BR|Brazilian|Portuguese/);
  });
});
