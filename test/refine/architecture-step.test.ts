import { describe, expect, it } from 'vitest';
import type { ArchitectureOutput } from '../../server/agents/outputs.js';
import type { Architecture } from '../../server/contracts/architecture.js';
import type { DocFile } from '../../server/refine/draft.js';
import { architecturePack, checkDecision, docsHashOf, projectWithArchitecture, renderArchitectureMd, withArchitecture } from '../../server/refine/architecture-step.js';
import { makeProject } from '../fixtures/contracts.js';

const DOCS: Record<DocFile, string> = {
  'project.md': 'O hello-app entrega uma saudação ao usuário.',
  'briefing.md': 'O usuário pede uma saudação.',
  'stack.md': 'Node e TypeScript.',
  'flow.md': '```mermaid\nflowchart TD\n  A --> B\n```',
  'design.md': 'Tela simples com um botão.',
};

const MICROSERVICES: Architecture = {
  style: 'microservices',
  rationale: 'O flow.md separa o servidor da tela.',
  repositories: [
    { name: 'hello-api', responsibility: 'Responde a saudação', evidence: { doc: 'project.md', quote: 'entrega uma saudação ao usuário' } },
    { name: 'hello-web', responsibility: 'Mostra a tela', evidence: { doc: 'design.md', quote: 'Tela simples com um botão' } },
  ],
  integrations: [{ consumer: 'hello-web', provider: 'hello-api', contract: 'GET /greeting' }],
};
const MONOLITH: Architecture = {
  style: 'monolith',
  rationale: 'Uma aplicação só.',
  repositories: [{ name: 'hello-app', responsibility: 'Tudo', evidence: { doc: 'project.md', quote: 'entrega uma saudação ao usuário' } }],
  integrations: [],
};

describe('services of the architecture', () => {
  it('gives a microservices project one service per repository', () => {
    expect(withArchitecture(makeProject({ projectId: 'hello-app' }), MICROSERVICES).services).toEqual(['hello-api', 'hello-web']);
  });

  it('gives a monolith no services and no platform, its code lives in one repository', () => {
    const project = withArchitecture(makeProject({ projectId: 'hello-app', services: ['old-api'], platform: [{ name: 'db-db', image: 'postgres:16', ports: [] }] } as never), MONOLITH);
    expect(project.services).toBeUndefined();
    expect(project.platform).toBeUndefined();
  });

  it('keeps the project as it is for an unstamped draft or before the architecture is decided', () => {
    const project = makeProject({ projectId: 'hello-app', services: ['old-api'] });
    expect(projectWithArchitecture(project, { repositories: false, architecture: { decision: MICROSERVICES } })).toBe(project);
    expect(projectWithArchitecture(project, { repositories: true, architecture: null })).toBe(project);
  });

  it('applies the architecture to a stamped draft', () => {
    const project = projectWithArchitecture(makeProject({ projectId: 'hello-app' }), { repositories: true, architecture: { decision: MICROSERVICES } });
    expect(project.services).toEqual(['hello-api', 'hello-web']);
  });
});

describe('architecture hash and files', () => {
  it('changes when any of the five documents changes, and stays the same otherwise', () => {
    expect(docsHashOf(DOCS)).toBe(docsHashOf({ ...DOCS }));
    expect(docsHashOf({ ...DOCS, 'design.md': 'Outra tela.' })).not.toBe(docsHashOf(DOCS));
  });

  it('renders the style, each repository with its kind and quote, and each integration', () => {
    const md = renderArchitectureMd(MICROSERVICES);
    expect(md).toContain('# Arquitetura');
    expect(md).toContain('Microsserviços');
    expect(md).toContain('### hello-api');
    expect(md).toContain('- Tipo: api');
    expect(md).toContain('"Tela simples com um botão"');
    expect(md).toContain('hello-web → hello-api: GET /greeting');
  });
});

describe('architecture pack', () => {
  it('carries the rules, the graph context, the existing services, the owner answers and the repair notes', () => {
    const pack = architecturePack({ specHash: docsHashOf(DOCS), principles: [], docs: DOCS, graphContext: 'Nó: hello-api', existingServices: ['old-api'], answers: ['Pagamento: no hello-api'], issues: ['o repositório "hello" precisa terminar com um sufixo'] });
    expect(pack).toMatchObject({ kind: 'architecture', role: 'sm' });
    expect(pack.feedback).toContain('Choose microservices only when');
    expect(pack.feedback).toContain('Graph context');
    expect(pack.feedback).toContain('Nó: hello-api');
    expect(pack.feedback).toContain('Existing services');
    expect(pack.feedback).toContain('Pagamento: no hello-api');
    expect(pack.feedback).toContain('precisa terminar com um sufixo');
  });

  it('leaves out the optional blocks when there is nothing to put in them', () => {
    const pack = architecturePack({ specHash: docsHashOf(DOCS), principles: [], docs: DOCS, graphContext: '', existingServices: [], answers: [] });
    expect(pack.feedback).toContain('Several applications are not microservices by themselves.');
    expect(pack.feedback).not.toContain('Graph context');
    expect(pack.feedback).not.toContain('Owner answers');
    expect(pack.feedback).not.toContain('Existing services');
  });
});

describe('architecture check', () => {
  const output = (arch: Architecture): ArchitectureOutput => ({ ...arch, specHash: 'x', questions: [] }) as ArchitectureOutput;

  it('accepts a decision whose quotes are in the documents', () => {
    expect(checkDecision(output(MICROSERVICES), 'hello-app', DOCS)).toEqual([]);
  });

  it('names a quote that the cited document does not hold', () => {
    const bad = { ...MICROSERVICES, repositories: [{ ...MICROSERVICES.repositories[0]!, evidence: { doc: 'stack.md' as const, quote: 'entrega uma saudação ao usuário' } }, MICROSERVICES.repositories[1]!] };
    expect(checkDecision(output(bad), 'hello-app', DOCS).join(' ')).toContain('não existe em stack.md');
  });
});
