import { describe, expect, it } from 'vitest';
import type { Project } from '../../server/contracts/project.js';
import { projectInfoMarkdown } from '../../server/knowledge/project-info.js';

const project = {
  projectId: 'kayron-hub',
  name: 'Kayron Hub',
  vision: 'Plataforma de governança.',
  personas: [{ name: 'Médico', description: 'Revisa a solicitação.' }],
  constraints: ['Todo serviço é escrito em Go.'],
  principles: [],
  deploy: { target: 'docker-local' },
  github: {},
  confidential: false,
  services: ['audit-service', 'rules-service'],
} as Project;

describe('projectInfoMarkdown', () => {
  it('puts each service under the services heading, so the graph has a node per service', () => {
    const md = projectInfoMarkdown(project);
    expect(md).toContain('# Kayron Hub');
    expect(md).toContain('## Serviços do projeto\nEste projeto tem 2 serviços.');
    expect(md).toContain('### audit-service\n');
    expect(md).toContain('### rules-service\n');
    expect(md).toContain('### Médico\nRevisa a solicitação.');
    expect(md).toContain('- Todo serviço é escrito em Go.');
  });

  it('has no services heading for a project without services', () => {
    expect(projectInfoMarkdown({ ...project, services: undefined })).not.toContain('Serviços do projeto');
  });
});
