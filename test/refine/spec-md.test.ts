import { describe, expect, it } from 'vitest';
import type { Spec } from '../../server/contracts/spec.js';
import { renderSpecMd } from '../../server/refine/spec-md.js';

const spec = {
  specId: 'todo-001',
  specVersion: 1,
  specHash: null,
  type: 'bug',
  bug: { actual: '500', expected: '200', reproduction: 'GET /todos' },
  objectives: ['Listar tarefas'],
  features: [],
  acceptanceCriteria: [{ id: 'AC-1', given: 'uma lista', when: 'abrir', then: 'ver os itens', smoke: false }],
  outOfScope: [],
  externalDependencies: [{ name: 'Postgres', purpose: 'dados', secretNames: ['DB_URL'] }],
  tasks: [{ title: 'Rota', description: 'Criar GET /todos' }],
  status: 'refining',
  validationReports: [],
} as Spec;

describe('renderSpecMd', () => {
  it('writes every part of the spec as Markdown', () => {
    const md = renderSpecMd(spec);
    expect(md).toContain('# Spec todo-001');
    expect(md).toContain('- AC-1: Dado uma lista, quando abrir, então ver os itens');
    expect(md).toContain('- Comportamento atual: 500');
    expect(md).toContain('- Rota: Criar GET /todos');
    expect(md).toContain('- Postgres: dados (DB_URL)');
  });

  it('says "Nenhum" for an empty list and leaves out the sections that do not apply', () => {
    const md = renderSpecMd({ ...spec, bug: undefined, tasks: undefined, externalDependencies: [] });
    expect(md).toContain('## Funcionalidades\n\n- Nenhum');
    expect(md).not.toContain('## Bug');
    expect(md).not.toContain('## Tarefas');
    expect(md).not.toContain('## Dependências externas');
  });
});
