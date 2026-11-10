import { describe, expect, it } from 'vitest';
import { planFileOf, taskFileOf } from '../../server/refine/plan-file.js';
import { CENTRAL_REPO, docsTarget, githubOwnerOf, isAliasFolder, isAllowedPath, isAlias, legacyPath, repoPath, startTagOf } from '../../server/docs/layout.js';

describe('legacy layout keeps its output', () => {
  it('names the plan of a spec implementation-plan.md under its folder', () => {
    expect(planFileOf('user-login')).toBe('docs/specs/user-login/implementation-plan.md');
    expect(legacyPath('plan', 'user-login')).toBe('docs/specs/user-login/implementation-plan.md');
  });

  it('names the task list and the spec of the legacy folder', () => {
    expect(taskFileOf('user-login')).toBe('docs/specs/user-login/task.md');
    expect(legacyPath('task', 'user-login')).toBe('docs/specs/user-login/task.md');
    expect(legacyPath('spec', 'user-login')).toBe('docs/specs/user-login/spec.md');
  });
});

describe('documentation repository paths', () => {
  it('puts the three files of a monolith spec in one folder under specify', () => {
    expect(repoPath('monolith', 'spec', 'user-login')).toBe('docs/specify/user-login/spec.md');
    expect(repoPath('monolith', 'plan', 'user-login')).toBe('docs/specify/user-login/plan.md');
    expect(repoPath('monolith', 'task', 'user-login')).toBe('docs/specify/user-login/task.md');
  });

  it('puts a microservice spec under the folder of its service', () => {
    expect(repoPath('microservices', 'plan', 'user-login', 'user-api')).toBe('docs/user-api/specify/user-login/plan.md');
  });

  it('refuses a service folder for a monolith and a missing or untyped service for microservices', () => {
    expect(() => repoPath('monolith', 'plan', 'user-login', 'user-api')).toThrow(RangeError);
    expect(() => repoPath('microservices', 'plan', 'user-login')).toThrow(RangeError);
    expect(() => repoPath('microservices', 'plan', 'user-login', 'users')).toThrow(RangeError);
  });

  it('refuses an alias that cannot be a folder name', () => {
    expect(() => repoPath('monolith', 'spec', 'con')).toThrow(RangeError);
  });
});

describe('alias folders', () => {
  it('is the folder of one spec under specify, in each style', () => {
    expect(isAliasFolder('monolith', 'docs/specify/user-login')).toBe(true);
    expect(isAliasFolder('microservices', 'docs/user-api/specify/user-login')).toBe(true);
  });

  it('is never the docs folder, the specify folder or a service folder', () => {
    for (const folder of ['docs', 'docs/specify', 'docs/specs/user-login', 'docs/specify/con']) {
      expect(isAliasFolder('monolith', folder), folder).toBe(false);
    }
    expect(isAliasFolder('microservices', 'docs/user-api')).toBe(false);
    expect(isAliasFolder('microservices', 'docs/specify/user-login')).toBe(false);
  });
});

describe('aliases', () => {
  it('accepts a slug of at most 40 characters', () => {
    expect(isAlias('user-login')).toBe(true);
    expect(isAlias('a'.repeat(40))).toBe(true);
  });

  it('refuses upper case, separators, long names, empty names and Windows device names', () => {
    expect(isAlias('User')).toBe(false);
    expect(isAlias('a'.repeat(41))).toBe(false);
    expect(isAlias('')).toBe(false);
    expect(isAlias('a/b')).toBe(false);
    expect(isAlias('user_login')).toBe(false);
    expect(isAlias('nul')).toBe(false);
    expect(isAlias('com1')).toBe(false);
  });
});

describe('allowlist of the eight kinds', () => {
  const FIVE = ['docs/project.md', 'docs/flow.md', 'docs/briefing.md', 'docs/design.md', 'docs/stack.md'];

  it('accepts the five documents in both styles', () => {
    for (const rel of FIVE) {
      expect(isAllowedPath('monolith', rel)).toBe(true);
      expect(isAllowedPath('microservices', rel)).toBe(true);
    }
  });

  it('accepts the spec files of its own style only', () => {
    expect(isAllowedPath('monolith', 'docs/specify/user-login/task.md')).toBe(true);
    expect(isAllowedPath('microservices', 'docs/user-api/specify/user-login/task.md')).toBe(true);
    expect(isAllowedPath('monolith', 'docs/user-api/specify/user-login/task.md')).toBe(false);
    expect(isAllowedPath('microservices', 'docs/specify/user-login/task.md')).toBe(false);
  });

  it('refuses every other file, the machine JSON and the legacy folder', () => {
    for (const rel of [
      'docs/project.json',
      'docs/specs.json',
      'docs/backlog.md',
      'docs/architecture.json',
      'docs/architecture.md',
      'docs/README.md',
      'docs/adr/0001.md',
      'docs/specify/user-login/spec.json',
      'docs/specify/user-login/preplan.json',
      'docs/specify/user-login/tech-spec.md',
      'docs/specify/user-login/implementation-plan.md',
      'docs/specs/user-login/spec.md',
      'docs/specify/con/spec.md',
    ]) {
      expect(isAllowedPath('monolith', rel), rel).toBe(false);
    }
  });
});

describe('target of the documents', () => {
  it('is the project repository for a monolith', () => {
    expect(docsTarget('monolith', 'kayron-hub', 'acme')).toEqual({ owner: 'acme', name: 'kayron-hub' });
  });

  it('is the central repository for microservices', () => {
    expect(docsTarget('microservices', 'kayron-hub', 'acme')).toEqual({ owner: 'acme', name: CENTRAL_REPO });
    expect(CENTRAL_REPO).toBe('artefacty');
  });

  it('refuses a project named like the central repository', () => {
    expect(() => docsTarget('monolith', 'artefacty', 'acme')).toThrow(RangeError);
  });
});

describe('GitHub owner of the project document', () => {
  it('is null when the section is missing', () => {
    expect(githubOwnerOf('# Project\n\n## Vision\n\nA product.\n')).toBeNull();
  });

  it('is null when the section is empty or still the template', () => {
    expect(githubOwnerOf('## GitHub owner\n\n')).toBeNull();
    expect(githubOwnerOf('## GitHub owner\n\n<optional override of config.json github.owner>\n')).toBeNull();
    expect(githubOwnerOf('## GitHub owner\n\n- (none)\n')).toBeNull();
  });

  it('reads a GitHub login from its section', () => {
    expect(githubOwnerOf('## GitHub owner\n\nacme-co\n\n## Principles\n')).toBe('acme-co');
  });

  it('is null when the section holds prose instead of a GitHub login', () => {
    expect(githubOwnerOf('## GitHub owner\n\nbad owner!\n')).toBeNull();
    expect(githubOwnerOf('## GitHub owner\n\n-acme\n')).toBeNull();
    expect(githubOwnerOf('## GitHub owner\n\n#### 10. Repo and owner\n\n- **Org:** prose\n')).toBeNull();
  });
});

describe('start tag', () => {
  it('names the tag of one spec', () => {
    expect(startTagOf('user-login')).toBe('dev-start/user-login');
  });

  it('refuses an alias that cannot be a tag name', () => {
    expect(() => startTagOf('con')).toThrow(RangeError);
  });
});
