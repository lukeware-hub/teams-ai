import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROLES } from '../../server/config/config.js';
import { ALWAYS_DENIED } from '../../server/agents/registry.js';
import { PROTECTED_READ_PATHS, buildRoleSettings, writeRoleSettings } from '../../server/runner/role-settings.js';

describe('buildRoleSettings', () => {
  it('enables the sandbox with the configured network allowlist', () => {
    const s = buildRoleSettings('dev', { allowedDomains: ['registry.npmjs.org'] });
    expect(s.sandbox).toEqual({ enabled: true, network: { allowedDomains: ['registry.npmjs.org'] } });
  });

  it('adds absolute deny rules for the orchestrator HOME, which the ~ rules do not reach', () => {
    const deny = buildRoleSettings('dev', { allowedDomains: [], hostHome: '/home/node/' }).permissions.deny;
    expect(deny).toContain('Read(//home/node/.teams-ai/secrets/**)');
    expect(deny).toContain('Read(//home/node/.config/gh/**)');
    expect(buildRoleSettings('dev', { allowedDomains: [] }).permissions.deny.some((d) => d.startsWith('Read(/'))).toBe(false);
  });

  it('hides the credential stores of the orchestrator HOME from every command in the sandbox, not only from the Read tool', () => {
    const { filesystem } = buildRoleSettings('dev', { allowedDomains: [], hostHome: '/home/node/' }).sandbox;
    expect(filesystem?.denyRead).toEqual(expect.arrayContaining(['/home/node/.teams-ai/secrets', '/home/node/.config/gh', '/home/node/.claude/.credentials.json']));
    expect(buildRoleSettings('dev', { allowedDomains: [] }).sandbox.filesystem).toBeUndefined();
  });

  it('denies secrets, credential stores, the settings directory and orchestrator-only commands for every role', () => {
    for (const role of ROLES) {
      const deny = buildRoleSettings(role, { allowedDomains: [] }).permissions.deny;
      for (const p of PROTECTED_READ_PATHS) expect(deny, role).toContain(`Read(${p})`);
      expect(deny, role).toContain('Edit(.claude/**)');
      expect(deny, role).not.toContain('Write(.claude/**)'); // not a valid file rule; Claude warns and ignores it
      for (const d of ALWAYS_DENIED) expect(deny, role).toContain(d);
    }
  });

  it('gives a step with full access any shell command and the web, and keeps every deny rule', () => {
    const plain = buildRoleSettings('dev', { allowedDomains: ['registry.npmjs.org'] });
    const full = buildRoleSettings('dev', { allowedDomains: ['registry.npmjs.org'], fullAccess: true });
    expect(plain.permissions.allow).not.toContain('Bash');
    expect(full.permissions.allow).toEqual(expect.arrayContaining(['Bash', 'WebSearch', 'WebFetch(domain:*)']));
    expect(full.permissions.deny).toEqual(plain.permissions.deny);
  });

  it('grants Bash allow rules only to roles that may run the suite', () => {
    expect(buildRoleSettings('dev', { allowedDomains: [], stacks: ['node'] }).permissions.allow).toEqual(
      expect.arrayContaining(['Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)', 'Bash(git status:*)', 'Bash(git diff:*)']),
    );
    expect(buildRoleSettings('test', { allowedDomains: [], stacks: ['node'] }).permissions.allow).toContain('Bash(npm:*)');
    // `mkdir -p reports && npm test` is denied unless every segment matches a rule (todo-api-r10: T3 blocked on it).
    expect(buildRoleSettings('dev', { allowedDomains: [] }).permissions.allow).toContain('Bash(mkdir:*)');
    expect(buildRoleSettings('devops', { allowedDomains: [], stacks: ['node'] }).permissions.allow).not.toContain('Bash(npm:*)');
    // Every role may run only the Agent Reach CLI from Bash, besides its own rules.
    expect(buildRoleSettings('sm', { allowedDomains: [] }).permissions.allow).toEqual(['Skill', 'Bash(agent-reach:*)']);
    expect(buildRoleSettings('po', { allowedDomains: [] }).permissions.allow).toEqual(['Skill', 'Bash(agent-reach:*)']);
    expect(buildRoleSettings('env', { allowedDomains: [] }).permissions.allow).toEqual(['Bash(agent-reach:*)']);
  });

  it('gives the Front, Dev and Test roles the toolchain of their stacks only, and never npm without a node stack', () => {
    for (const role of ['front', 'dev', 'test'] as const) {
      const python = buildRoleSettings(role, { allowedDomains: [], stacks: ['python'] }).permissions.allow;
      expect(python, role).toEqual(expect.arrayContaining(['Bash(.tools/venv/bin/pip:*)', 'Bash(python3:*)']));
      expect(python, role).not.toEqual(expect.arrayContaining(['Bash(npm:*)', 'Bash(go:*)']));
      expect(buildRoleSettings(role, { allowedDomains: [], stacks: ['java'] }).permissions.allow, role).toEqual(expect.arrayContaining(['Bash(mvn:*)', 'Bash(./gradlew:*)']));
      expect(buildRoleSettings(role, { allowedDomains: [], stacks: ['rust', 'go'] }).permissions.allow, role).toEqual(expect.arrayContaining(['Bash(cargo:*)', 'Bash(go:*)']));
      for (const stacks of [undefined, ['other'], ['python'], ['go'], ['java'], ['rust']] as const) {
        expect(buildRoleSettings(role, { allowedDomains: [], stacks: stacks as undefined }).permissions.allow, `${role} ${stacks}`).not.toContain('Bash(npm:*)');
      }
      expect(buildRoleSettings(role, { allowedDomains: [], stacks: ['node'] }).permissions.allow).toContain('Bash(npm:*)');
    }
    // A Java step never gets the Python or Go commands, and a Python step never gets Maven.
    const java = buildRoleSettings('dev', { allowedDomains: [], stacks: ['java'] }).permissions.allow;
    expect(java).not.toContain('Bash(python3:*)');
    expect(java).not.toContain('Bash(go:*)');
    expect(buildRoleSettings('dev', { allowedDomains: [], stacks: ['python'] }).permissions.allow).not.toContain('Bash(mvn:*)');
    // Roles without a toolchain get no stack commands, whatever the stacks.
    expect(buildRoleSettings('devops', { allowedDomains: [], stacks: ['python'] }).permissions.allow).not.toContain('Bash(python3:*)');
  });

  it('forbids every write to the installed skill plugins, by the Edit tool and by any command of the sandbox', () => {
    const s = buildRoleSettings('dev', { allowedDomains: [], protectedDirs: ['/opt/teams-ai/agent-plugins/'] });
    expect(s.permissions.deny).toContain('Edit(//opt/teams-ai/agent-plugins/**)');
    expect(s.sandbox.filesystem?.denyWrite).toEqual(['/opt/teams-ai/agent-plugins']);
  });

  it('denies every read of the secrets directory of every project, by the Read tool and by any command of the sandbox', () => {
    const s = buildRoleSettings('dev', { allowedDomains: [], projectSecretsDirs: ['/ws/kayron-hub/secrets/', '/ws/other/secrets'] });
    expect(s.permissions.deny).toEqual(expect.arrayContaining(['Read(//ws/kayron-hub/secrets/**)', 'Read(//ws/other/secrets/**)']));
    expect(s.sandbox.filesystem?.denyRead).toEqual(expect.arrayContaining(['/ws/kayron-hub/secrets', '/ws/other/secrets']));
    expect(buildRoleSettings('dev', { allowedDomains: [] }).sandbox.filesystem).toBeUndefined();
  });

  it('writes a Windows drive path behind the absolute prefix, with forward slashes', () => {
    const s = buildRoleSettings('dev', { allowedDomains: [], projectSecretsDirs: ['C:\\ws\\secrets\\'] });
    expect(s.permissions.deny).toContain('Read(//C:/ws/secrets/**)');
  });

  it('denies the extra directories to every command of the sandbox and to the Read tools, with a bare path rule that does not make the CLI walk the tree', () => {
    const s = buildRoleSettings('po', { allowedDomains: [], extraDenyRead: ['/ws/*/repo/', '/home/node/.teams-ai/runs'] });
    expect(s.sandbox.filesystem?.denyRead).toEqual(['/ws/*/repo', '/home/node/.teams-ai/runs']);
    expect(s.permissions.deny.filter((d) => d.includes('/ws/') || d.includes('.teams-ai/runs'))).toEqual(['Read(//ws/*/repo)', 'Read(//home/node/.teams-ai/runs)']);
    expect(s.permissions.deny.some((d) => d.includes('/**') && (d.includes('/ws/') || d.includes('.teams-ai/runs')))).toBe(false);
  });

  it('grants the file editing tools to editing roles, since dontAsk denies anything not allowed', () => {
    // Found by the first live run: the Dev answered techSpecPath "NOT_WRITTEN:..." because Write was denied.
    for (const role of ['dev', 'test', 'devops'] as const) {
      const allow = buildRoleSettings(role, { allowedDomains: [] }).permissions.allow;
      expect(allow).toEqual(expect.arrayContaining(['Edit', 'Write', 'MultiEdit']));
    }
    for (const role of ['sm', 'po', 'sec'] as const) {
      const allow = buildRoleSettings(role, { allowedDomains: [] }).permissions.allow;
      expect(allow).not.toContain('Write');
      expect(allow).not.toContain('Edit');
    }
  });

  it('adds extra allow rules from the plan commands without touching the deny list', () => {
    const s = buildRoleSettings('dev', { allowedDomains: [], extraAllow: ['Bash(pytest:*)'] });
    expect(s.permissions.allow).toContain('Bash(pytest:*)');
    expect(s.permissions.deny).toContain('Bash(gh:*)');
  });
});

describe('writeRoleSettings', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-role-settings-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes one file per role outside the worktree and returns its path', async () => {
    const file = await writeRoleSettings(dir, 'dev', { allowedDomains: ['registry.npmjs.org'] });
    expect(path.dirname(file)).toBe(dir);
    expect(path.basename(file)).toBe('dev.settings.json');
    const json = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(json.sandbox.enabled).toBe(true);
    expect(json.permissions.deny).toContain('Bash(gh:*)');
  });

  it('survives concurrent writers of the same role: none rejects, the file is valid JSON, no tmp file is left', async () => {
    // Concurrent steps of one role share the target file; a shared tmp name made the slower rename fail with ENOENT.
    const input = { allowedDomains: ['registry.npmjs.org'] };
    const results = await Promise.allSettled(Array.from({ length: 100 }, () => writeRoleSettings(dir, 'dev', input)));
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    const json = JSON.parse(await fs.readFile(path.join(dir, 'dev.settings.json'), 'utf8'));
    expect(json.sandbox.network.allowedDomains).toEqual(['registry.npmjs.org']);
    expect(await fs.readdir(dir)).toEqual(['dev.settings.json']);
  });

  it('removes its tmp file when a write fails and does not block the writer queued behind it', async () => {
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('boom'));
    const results = await Promise.allSettled([
      writeRoleSettings(dir, 'dev', { allowedDomains: [] }),
      writeRoleSettings(dir, 'dev', { allowedDomains: [] }),
    ]);
    rename.mockRestore();
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await fs.readdir(dir)).toEqual(['dev.settings.json']);
  });
});

describe('sandbox.enabled', () => {
  it('turns the sandbox off when the config says so, keeping the permission rules', async () => {
    const { buildRoleSettings } = await import('../../server/runner/role-settings.js');
    const s = buildRoleSettings('dev', { allowedDomains: ['registry.npmjs.org'], stacks: ['node'], sandboxEnabled: false });
    expect(s.sandbox).toEqual({ enabled: false, network: { allowedDomains: ['registry.npmjs.org'] } });
    expect(s.permissions.allow).toContain('Bash(npm:*)');
  });
});
