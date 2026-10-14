import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALWAYS_DENIED, AgentFileError, QUALITY_RULES, ROLE_TOOL_POLICY, loadAgents, parseAgentFile } from '../../server/agents/registry.js';

const AGENTS_DIR = path.resolve('.claude/agents');

describe('parseAgentFile', () => {
  it('parses frontmatter and body', () => {
    const def = parseAgentFile(`---\nname: dev\ndescription: Developer.\nmodel: opus\ntools: Read, Edit, Bash\n---\n\nEcho the specHash.\n`, 'dev');
    expect(def).toEqual({ role: 'dev', description: 'Developer.', model: 'opus', tools: ['Read', 'Edit', 'Bash'], body: 'Echo the specHash.' });
  });

  it('rejects a name that does not match the expected role', () => {
    expect(() => parseAgentFile(`---\nname: po\ndescription: x\nmodel: opus\ntools: Read\n---\nb`, 'dev')).toThrow(AgentFileError);
  });

  it('rejects missing frontmatter fields', () => {
    expect(() => parseAgentFile(`---\nname: dev\nmodel: opus\ntools: Read\n---\nb`, 'dev')).toThrow(/description/);
  });

  it('rejects a tool outside the role policy', () => {
    expect(() => parseAgentFile(`---\nname: devops\ndescription: x\nmodel: sonnet\ntools: Read, Bash\n---\nb`, 'devops')).toThrow(/Bash/);
    expect(() => parseAgentFile(`---\nname: sm\ndescription: x\nmodel: opus\ntools: Read, Edit\n---\nb`, 'sm')).toThrow(/Edit/);
  });

  it('rejects an always-denied pattern even for roles that may use Bash', () => {
    expect(() => parseAgentFile(`---\nname: dev\ndescription: x\nmodel: opus\ntools: Read, Bash(gh:*)\n---\nb`, 'dev')).toThrow(/gh/);
  });

  it('rejects a body that does not mention specHash', () => {
    expect(() => parseAgentFile(`---\nname: dev\ndescription: x\nmodel: opus\ntools: Read\n---\nNo hash rule here.`, 'dev')).toThrow(/specHash/);
  });
});

describe('loadAgents', () => {
  it('loads all eight role files from .claude/agents', async () => {
    const agents = await loadAgents(AGENTS_DIR);
    expect(Object.keys(agents).sort()).toEqual(['dev', 'devops', 'env', 'front', 'po', 'sec', 'sm', 'test']);
    expect(agents.dev.tools).toContain('Bash');
    expect(agents.devops.tools).not.toContain('Bash');
    expect(agents.sec.tools).toEqual(['Read', 'Grep', 'Glob']);
    // The environment agent only reads: it never edits, runs a command or sees a secret.
    expect(agents.env.tools).toEqual(['Read', 'Grep', 'Glob']);
    // sm's frontmatter now states its real default model (server/config/config.ts CLAUDE_DEFAULTS); this
    // AgentDefinition.model field itself is never read by buildInvocation (see server/agents/registry.ts).
    expect(agents.sm.model).toBe('opus');
    expect(agents.test.model).toBe('sonnet');
  });

  it('every role file respects its policy and the always-denied list', async () => {
    const agents = await loadAgents(AGENTS_DIR);
    for (const def of Object.values(agents)) {
      for (const tool of def.tools) expect(ROLE_TOOL_POLICY[def.role].allowed).toContain(tool);
      for (const denied of ALWAYS_DENIED) expect(def.tools).not.toContain(denied);
    }
  });

  it('fails when a role file is missing', async () => {
    await expect(loadAgents(path.resolve('test/fixtures/no-such-dir'))).rejects.toThrow(AgentFileError);
  });
});

describe('settings directory protection', () => {
  it('always denies editing or writing the project settings directory', () => {
    expect(ALWAYS_DENIED).toEqual(expect.arrayContaining(['Edit(.claude/**)']));
    expect(ALWAYS_DENIED).not.toContain('Write(.claude/**)'); // Edit(path) covers every file-editing tool; Write(path) is not a valid rule
    expect(() => parseAgentFile(`---\nname: dev\ndescription: x\nmodel: opus\ntools: Read, Write(.claude/**)\n---\nEcho specHash.`, 'dev')).toThrow(/\.claude/);
  });

  it('every agent prompt requires 100% Brazilian Portuguese for human-readable text', async () => {
    const agents = await loadAgents(AGENTS_DIR);
    for (const def of Object.values(agents)) expect(def.body).toMatch(/Brazilian Portuguese \(pt-BR\), 100%/);
  });

  it('every agent prompt carries the shared quality rules and delivery goals', async () => {
    const agents = await loadAgents(AGENTS_DIR);
    for (const def of Object.values(agents)) {
      expect(def.body).toContain(QUALITY_RULES);
      expect(def.body).toMatch(/KISS/);
      expect(def.body).toMatch(/YAGNI/);
      expect(def.body).toMatch(/DRY/);
    }
  });

  it('the SM prompt tells the agent to decide spec gaps and log assumptions, never to ask the human mid-run', async () => {
    const agents = await loadAgents(AGENTS_DIR);
    expect(agents.sm.body).toMatch(/spec-gap|spec gap/i);
    expect(agents.sm.body).toMatch(/assumption/i);
    expect(agents.sm.body).not.toMatch(/never an assumption during a run/);
  });

  it('the sec prompt states the one blocking rule the task runner enforces: severities decide, medium and low never block', async () => {
    const { sec } = await loadAgents(AGENTS_DIR);
    expect(sec.body).toMatch(/exactly when at least one finding is `critical` or `high`/);
    expect(sec.body).toMatch(/`medium` and `low` findings never block/);
  });

  it('the sec prompt names the notice the task runner appends to a cut diff and what to do about it', async () => {
    const { sec } = await loadAgents(AGENTS_DIR);
    expect(sec.body).toContain('[diff truncated');
    expect(sec.body).toMatch(/affectedPaths/);
    expect(sec.body).toMatch(/Change set under review/);
  });
});
