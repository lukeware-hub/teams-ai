/** One line of the document validation checklist: whether it passes, and the text the owner reads. */
export interface StageCheck {
  id: 'processed' | 'format' | 'graphed';
  label: string;
  ok: boolean;
  /** Plain words for a failure: what the owner does about it. */
  hint: string | null;
}

export interface StageChecklistInput {
  /** The agents processed the stage at least once; what their review left open never holds the owner. */
  processed: boolean;
  /** Why the document is not in the template format, or null when it is. */
  formatProblem: string | null;
  /** The document is in the Graphify graph after its last edit. */
  graphed: boolean;
  /** The graph extraction of this document is running now. */
  graphing: boolean;
  /** The last graph extraction of this document failed, with the reason in plain words. */
  graphError: string | null;
}

/** The checks of a stage, in the order the page shows them. */
export function stageChecklist(input: StageChecklistInput): StageCheck[] {
  return [
    { id: 'processed', label: 'Revisado pelo time', ok: input.processed, hint: 'Processe esta etapa com os agentes.' },
    { id: 'format', label: 'Formato do modelo', ok: input.formatProblem === null, hint: input.formatProblem },
    // While the extraction runs it is the line that says so; a failure of an earlier run waits until the run ends.
    { id: 'graphed', label: 'No Graphify', ok: input.graphed, hint: input.graphing ? null : (input.graphError ?? 'Adicione o documento ao Graphify para avançar.') },
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
