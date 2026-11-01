import { describe, expect, it } from 'vitest';
import { ArchitectureOutput } from '../../server/agents/outputs.js';
import { Architecture, repoKind } from '../../server/contracts/architecture.js';

const monolith = {
  style: 'monolith',
  rationale: 'Um só processo.',
  repositories: [{ name: 'acme', responsibility: 'Tudo', evidence: { doc: 'project.md', quote: 'Um só processo' } }],
  integrations: [],
};

describe('Architecture schema', () => {
  it('accepts a valid monolith', () => {
    expect(Architecture.safeParse(monolith).success).toBe(true);
  });

  it('rejects an uppercase repository name', () => {
    const repositories = [{ ...monolith.repositories[0], name: 'Acme' }];
    expect(Architecture.safeParse({ ...monolith, repositories }).success).toBe(false);
  });

  it('rejects an unknown document in evidence', () => {
    const repositories = [{ ...monolith.repositories[0], evidence: { doc: 'notes.md', quote: 'Um' } }];
    expect(Architecture.safeParse({ ...monolith, repositories }).success).toBe(false);
  });
});

describe('repoKind', () => {
  it('returns monolith for a monolith', () => {
    expect(repoKind('acme', 'monolith')).toBe('monolith');
  });

  it('returns the suffix of a service', () => {
    expect(repoKind('case-evidence-api', 'microservices')).toBe('api');
    expect(repoKind('reconciliation-jobs', 'microservices')).toBe('jobs');
  });

  it('returns null when the service name has no suffix', () => {
    expect(repoKind('acme', 'microservices')).toBeNull();
  });
});

describe('ArchitectureOutput', () => {
  it('keeps the valid questions and drops a malformed one on its own', () => {
    const parsed = ArchitectureOutput.parse({ ...monolith, specHash: `sha256:${'a'.repeat(64)}`, questions: [{ text: 'Quem paga?', context: 'Não diz.', blocking: true, options: [] }, { text: '' }] });
    expect(parsed.questions.map((q) => q.text)).toEqual(['Quem paga?']);
  });
});
