import { describe, expect, it } from 'vitest';
import { plainOutlineQuestion } from '../../server/refine/question-choices.js';
import { outlineQuestions } from '../../server/refine/cycle.js';

const SUBSECTIONS = 'item portal-shell-case-360 cita design.md › "2. Tokens semânticos", uma seção feita só de subseções; cite as de que o item precisa: "2.1 Cores", "2.2 Tipografia, grade e ritmo", "2.3 Tokens CSS de referência"';
const EMPTY_SECTION = 'seção do flow.md sem nenhum item: "33.7 OPME (`opme`)"';

describe('plainOutlineQuestion', () => {
  it('asks which subsections an item needs, with the subsections as a choice and the rest open', () => {
    const q = plainOutlineQuestion(SUBSECTIONS);
    expect(q.text).toBe('O item portal-shell-case-360 usa a seção "2. Tokens semânticos" de design.md, mas ela só tem subseções. Quais subseções o item precisa?');
    expect(q.options).toEqual([
      { label: 'Citar todas as subseções', detail: 'O item usa: 2.1 Cores; 2.2 Tipografia, grade e ritmo; 2.3 Tokens CSS de referência.', recommended: true },
      { label: 'Citar só algumas', detail: 'Escreva na resposta quais subseções o item precisa.' },
    ]);
  });

  it('asks what to do with a flow.md section that no item covers', () => {
    const q = plainOutlineQuestion(EMPTY_SECTION);
    expect(q.text).toBe('A seção "33.7 OPME (`opme`)" do flow.md não tem nenhum item no backlog. Ela deve virar um item próprio?');
    expect(q.options.map((o) => o.label)).toEqual(['Criar um item para a seção', 'Juntar a um item que já existe', 'Deixar a seção fora do backlog']);
    expect(q.options.filter((o) => o.recommended)).toHaveLength(1);
  });

  it('keeps the old text and no choices for a mechanical rule', () => {
    const q = plainOutlineQuestion('chave duplicada: web-portal-shell');
    expect(q).toEqual({ text: 'O backlog ainda não fecha: chave duplicada: web-portal-shell. Como o backlog deve tratar isso?', options: [] });
  });
});

describe('outlineQuestions with choices', () => {
  it('keeps the validator message on the question, so a repeat is recognized after the text went plain', () => {
    const [q] = outlineQuestions([SUBSECTIONS], 5, []);
    expect(q!.rule).toBe(SUBSECTIONS);
    expect(q!.options).toHaveLength(2);
    expect(outlineQuestions([SUBSECTIONS], 6, [q!.rule!])).toEqual([]);
  });
});
