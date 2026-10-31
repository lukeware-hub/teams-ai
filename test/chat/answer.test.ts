import { describe, expect, it } from 'vitest';
import { needsLabels, withRecordPointer } from '../../server/chat/answer.js';

describe('needsLabels', () => {
  it('asks for the three labels on a question about what happened, why or what to do', () => {
    expect(needsLabels('falhou ao intalar quais ferramentas?', 'Resposta curta.')).toBe(true);
    expect(needsLabels('O que devo fazer agora?', 'Resposta curta.')).toBe(true);
    expect(needsLabels('O que está bloqueando?', 'Resposta curta.')).toBe(true);
  });
  it('does not ask for them on a counting or a timing question, nor when the labels are there', () => {
    expect(needsLabels('Quantas execuções falharam?', '16 execuções.')).toBe(false);
    expect(needsLabels('Quanto tempo falta para terminar?', 'Não há previsão.')).toBe(false);
    expect(needsLabels('O que devo fazer agora?', '**O que está acontecendo**: x')).toBe(false);
  });
});

describe('withRecordPointer', () => {
  const pointer = 'Onde procurar: o histórico de cada execução e o arquivo de falhas da spec (falhas/<spec>.md).';
  it('says where the records are kept when an answer says a fact is not recorded and names no record', () => {
    expect(withRecordPointer('Não há previsão de prazo nos registros.')).toBe('Não há previsão de prazo nos registros.\n\n' + pointer);
  });
  it('leaves an answer alone when it names the record, or states no missing fact', () => {
    expect(withRecordPointer('Não há previsão. Segundo o histórico da execução, faltam 15 tarefas.')).not.toContain('Onde procurar');
    expect(withRecordPointer('Faltam 15 tarefas.')).toBe('Faltam 15 tarefas.');
  });
});

describe('the words that say a fact is not in the records', () => {
  it('counts "não registra" and its plural as a missing fact', () => {
    expect(withRecordPointer('O contexto não registra uma previsão de prazo.')).toContain('Onde procurar');
    expect(withRecordPointer('Os registros não registram previsão.')).toContain('Onde procurar');
  });
});
