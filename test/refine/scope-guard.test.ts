import { describe, expect, it } from 'vitest';
import { changesNothing, patchChangesScope, structureOf } from '../../server/refine/scope-guard.js';

describe('scope guard for document patches', () => {
  it('flags a patch that adds or removes a list item', () => {
    expect(patchChangesScope('- Cadastro', '- Cadastro\n- Relatório')).toBe(true);
    expect(patchChangesScope('- Cadastro\n- Relatório', '- Cadastro')).toBe(true);
  });

  it('flags a patch that adds or removes a heading, a criterion id or a priority', () => {
    expect(patchChangesScope('## Escopo', '## Fora do escopo')).toBe(true);
    expect(patchChangesScope('Valida o login.', 'Valida o login. AC-002 bloqueia o acesso.')).toBe(true);
    expect(patchChangesScope('Prioridade P1.', 'Prioridade P2.')).toBe(true);
  });

  it('flags a change to a dependency line, which is the owner’s order of work', () => {
    expect(patchChangesScope('Depende de: cadastro', 'Depende de: cadastro e login')).toBe(true);
  });

  it('lets a rewording of a sentence through, and an identical replacement', () => {
    expect(patchChangesScope('O sistema guarda o registro.', 'O sistema grava o registro.')).toBe(false);
    expect(patchChangesScope('- Cadastro', '- Cadastro')).toBe(false);
  });

  it('reads the structure of a document, accents and case aside', () => {
    expect(structureOf('## Objetivo\n- Cadastro AC-001 P1')).toEqual(['heading:objetivo', 'item:cadastro ac-001 p1', 'criterion:AC-001', 'priority:P1']);
  });
});

describe('changesNothing: a change that only restates, reformats or drops a fragment it carries', () => {
  const stack = '## Tooling\n\n- Vitest para testes.\n\nSwagger\n\n## Documentação\n\n- Swagger para documentar a API REST.\n';
  const cited = '## Tooling\n\n- Vitest para testes.\n\n- Swagger para documentar a API REST, conforme a decisão sm-s4-0.\n\n## Documentação\n\n- Swagger para documentar a API REST.\n';

  it('refuses the citation of a decision that replaces a loose fragment the document already states', () => {
    expect(changesNothing(stack, cited)).toBe(true);
  });

  it('refuses a change of formatting, case, a final period or a citation in parentheses only', () => {
    expect(changesNothing('- Vitest para testes.\n', 'Vitest para testes\n')).toBe(true);
    expect(changesNothing('Node 18.\n', 'Node 18\n')).toBe(true);
    expect(changesNothing('## Stack\n', '## stack\n')).toBe(true);
    expect(changesNothing('- Swagger para documentar a API REST.\n', '- Swagger para documentar a API REST (sm-s4-0).\n')).toBe(true);
  });

  it('refuses a second copy of a line the document already holds', () => {
    expect(changesNothing('- Vitest para testes.\n', '- Vitest para testes.\n- Vitest para testes.\n')).toBe(true);
  });

  it('lets through a new fact, a changed value, a removed line, a reordered list and a removed duplicate', () => {
    expect(changesNothing('- Cadastro\n', '- Cadastro\n- Relatório\n')).toBe(false);
    expect(changesNothing('Node 18\n', 'Node 20\n')).toBe(false);
    expect(changesNothing('- Node 18\n- Redis\n', '- Node 18\n')).toBe(false);
    expect(changesNothing('1. Cadastro\n2. Login\n', '1. Login\n2. Cadastro\n')).toBe(false);
    expect(changesNothing('- Vitest\n- Vitest\n', '- Vitest\n')).toBe(false);
  });

  it('lets through a change of a Mermaid edge', () => {
    expect(changesNothing('A --> B\n', 'A --> C\n')).toBe(false);
  });
});
