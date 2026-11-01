/** One line of the document validation checklist: whether it passes, and the text the owner reads. */
export interface StageCheck {
  id: 'reviewed' | 'no-question' | 'no-suggestion' | 'format' | 'graphed';
  label: string;
  ok: boolean;
  /** Plain words for a failure: what the owner does about it. */
  hint: string | null;
}

export interface StageChecklistInput {
  /** The stage review came after the last edit of the document. */
  reviewed: boolean;
  /** Mandatory questions of the stage still open. */
  openQuestions: number;
  /** Suggestions of the stage still waiting for accept or reject. */
  pendingSuggestions: number;
  /** Why the document is not in the template format, or null when it is. */
  formatProblem: string | null;
  /** The document is in the Graphify graph after its last edit. */
  graphed: boolean;
  /** The graph extraction of this document is running now. */
  graphing: boolean;
  /** The last graph extraction of this document failed, with the reason in plain words. */
  graphError: string | null;
}

/** The five checks of a stage, in the order the page shows them. */
export function stageChecklist(input: StageChecklistInput): StageCheck[] {
  return [
    { id: 'reviewed', label: 'Revisado depois da última edição', ok: input.reviewed, hint: 'Avalie esta etapa de novo.' },
    { id: 'no-question', label: 'Sem pergunta obrigatória aberta', ok: input.openQuestions === 0, hint: 'Responda a pergunta obrigatória desta etapa.' },
    { id: 'no-suggestion', label: 'Sem sugestão pendente', ok: input.pendingSuggestions === 0, hint: 'Aceite ou rejeite as sugestões desta etapa.' },
    { id: 'format', label: 'Formato do modelo', ok: input.formatProblem === null, hint: input.formatProblem },
    { id: 'graphed', label: 'No Graphify', ok: input.graphed, hint: input.graphError ?? 'Adicione o documento ao Graphify para avançar.' },
  ];
}

/** The label of the graph check while the extraction runs, and after it finished. */
export function graphLabel(input: Pick<StageChecklistInput, 'graphed' | 'graphing'>, nodes: number | null): string {
  if (input.graphing) return 'Adicionando ao Graphify…';
  if (input.graphed) return nodes === null ? 'No Graphify' : `No Graphify: ${nodes} nós`;
  return 'No Graphify';
}

/** The first failing check, which the disabled Continuar names in its hint; null when all pass. */
export function firstFailing(checks: readonly StageCheck[]): StageCheck | null {
  return checks.find((check) => !check.ok) ?? null;
}
