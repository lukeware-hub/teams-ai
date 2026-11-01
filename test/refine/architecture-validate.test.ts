import { describe, expect, it } from 'vitest';
import type { Architecture, Repository } from '../../server/contracts/architecture.js';
import { type ArchitectureInput, validateArchitecture } from '../../server/refine/architecture-validate.js';

const normalize = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ');

const input: ArchitectureInput = {
  projectId: 'acme',
  docs: {
    'flow.md': 'Fluxo do pedido.',
    'project.md': 'Plataforma de casos. Órgão público.',
    'briefing.md': '',
    'stack.md': '',
    'design.md': '',
  },
  normalize,
};

const repo = (name: string, quote = 'Plataforma de casos'): Repository => ({
  name,
  responsibility: 'Responsabilidade',
  evidence: { doc: 'project.md', quote },
});

const microservices: Architecture = {
  style: 'microservices',
  rationale: 'Serviços separados.',
  repositories: [repo('case-evidence-api'), { ...repo('reconciliation-jobs'), evidence: { doc: 'flow.md', quote: 'Fluxo do pedido' } }],
  integrations: [{ consumer: 'reconciliation-jobs', provider: 'case-evidence-api', contract: 'HTTP /evidences' }],
};

describe('validateArchitecture', () => {
  it('accepts a valid monolith', () => {
    expect(validateArchitecture({ style: 'monolith', rationale: 'Um processo.', repositories: [repo('acme')], integrations: [] }, input)).toEqual([]);
  });

  it('accepts a valid microservices architecture', () => {
    expect(validateArchitecture(microservices, input)).toEqual([]);
  });

  it('rule a: a monolith has exactly one repository', () => {
    const arch: Architecture = { ...microservices, style: 'monolith', repositories: [repo('acme'), repo('acme-api')], integrations: [] };
    expect(validateArchitecture(arch, input)).toHaveLength(1);
  });

  it('rule a: a monolith repository is named after the project', () => {
    const arch: Architecture = { style: 'monolith', rationale: 'Um processo.', repositories: [repo('other')], integrations: [] };
    expect(validateArchitecture(arch, input)).toHaveLength(1);
  });

  it('rule a: a monolith has no integrations', () => {
    const arch: Architecture = { style: 'monolith', rationale: 'Um processo.', repositories: [repo('acme')], integrations: [{ consumer: 'acme', provider: 'acme', contract: 'x' }] };
    expect(validateArchitecture(arch, input).some((p) => p.includes('integrações'))).toBe(true);
  });

  it('rule b: microservices need at least two repositories', () => {
    expect(validateArchitecture({ ...microservices, repositories: [repo('case-evidence-api')] }, input).some((p) => p.includes('dois repositórios'))).toBe(true);
  });

  it('rule b: microservices repository names are unique', () => {
    const repositories = [repo('case-evidence-api'), repo('case-evidence-api')];
    expect(validateArchitecture({ ...microservices, repositories }, input).some((p) => p.includes('case-evidence-api'))).toBe(true);
  });

  it('rule b: every microservices repository has a suffix', () => {
    const repositories = [repo('case-evidence-api'), repo('reconciliation')];
    expect(validateArchitecture({ ...microservices, repositories }, input).some((p) => p.includes('"reconciliation"'))).toBe(true);
  });

  it('rule b: microservices need at least one integration', () => {
    expect(validateArchitecture({ ...microservices, integrations: [] }, input)).toHaveLength(1);
  });

  it('rule c: an integration names only repositories of the architecture', () => {
    const integrations = [{ consumer: 'reconciliation-jobs', provider: 'billing-api', contract: 'HTTP' }];
    expect(validateArchitecture({ ...microservices, integrations }, input)).toHaveLength(1);
  });

  it('rule c: a consumer differs from its provider', () => {
    const integrations = [{ consumer: 'case-evidence-api', provider: 'case-evidence-api', contract: 'HTTP' }];
    expect(validateArchitecture({ ...microservices, integrations }, input)).toHaveLength(1);
  });

  it('rule d: a missing evidence quote is reported with its repository', () => {
    const repositories = [repo('case-evidence-api', 'Texto inexistente'), repo('reconciliation-jobs')];
    expect(validateArchitecture({ ...microservices, repositories }, input)).toEqual([
      'a citação do repositório "case-evidence-api" não existe em project.md.',
    ]);
  });

  it('rule d: a quote matches the document after normalization', () => {
    const repositories = [repo('case-evidence-api', 'ORGAO PUBLICO'), repo('reconciliation-jobs')];
    expect(validateArchitecture({ ...microservices, repositories }, input)).toEqual([]);
  });
});
