import { describe, expect, it } from 'vitest';
import { patchChangesScope, structureOf } from '../../server/refine/scope-guard.js';

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
