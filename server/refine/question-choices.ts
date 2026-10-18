import type { QuestionChoice } from './events.js';

/** A question for the owner in plain words, with the choices it offers. A rule without choices keeps its text. */
export interface PlainQuestion {
  text: string;
  options: QuestionChoice[];
}

const SUBSECTIONS_ONLY = /^item (\S+) cita (\S+) › "(.+?)", uma seção feita só de subseções; cite as de que o item precisa: (.+)$/;
const EMPTY_FLOW_SECTION = /^seção do flow\.md sem nenhum item: "(.+)"$/;

/** The outline rule an issue breaks, as a plain question; the mechanical rules keep the generic text, since no choice helps there. */
export function plainOutlineQuestion(issue: string): PlainQuestion {
  const subsections = SUBSECTIONS_ONLY.exec(issue);
  if (subsections) {
    const [, key, doc, heading, list] = subsections;
    const names = [...list!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    return {
      text: `O item ${key} usa a seção "${heading}" de ${doc}, mas ela só tem subseções. Quais subseções o item precisa?`,
      options: [
        { label: 'Citar todas as subseções', detail: `O item usa: ${names.join('; ')}.`, recommended: true },
        { label: 'Citar só algumas', detail: 'Escreva na resposta quais subseções o item precisa.' },
      ],
    };
  }
  const empty = EMPTY_FLOW_SECTION.exec(issue);
  if (empty) {
    return {
      text: `A seção "${empty[1]}" do flow.md não tem nenhum item no backlog. Ela deve virar um item próprio?`,
      options: [
        { label: 'Criar um item para a seção', detail: 'A seção ganha um item próprio no backlog.', recommended: true },
        { label: 'Juntar a um item que já existe', detail: 'Escreva na resposta o nome do item que ganha a seção.' },
        { label: 'Deixar a seção fora do backlog', detail: 'Escreva na resposta por que a seção não entra no backlog.' },
      ],
    };
  }
  return { text: `O backlog ainda não fecha: ${issue}. Como o backlog deve tratar isso?`, options: [] };
}
