import type { RunningStep } from './running-steps.js';

const ROLE_NAME: Record<string, string> = { po: 'PO', sm: 'SM', front: 'Front' };

/** What a stage review is doing now, in plain words: the step in use and what the stage waits for. */
export interface StageTextInput {
  /** The stage document under review, such as project.md. */
  file: string;
  /** The steps running now. */
  running: RunningStep[];
  /** The review of this stage has ended in this round. */
  reviewed: boolean;
  /** The Jev has scored this document in this round. */
  scored: boolean;
  /** The document is being added to the Graphify graph. */
  graphing: boolean;
  /** The Jev reads the document: the project is not confidential and the owner answered that. */
  jevReads: boolean;
  /** The Jev did not answer this round. */
  jevDown: boolean;
  /** The first stage has no document before it to read as context. */
  firstStage: boolean;
}

/** The line under a stage review's title: the step in use, else what the stage is waiting for. */
export function stageText(input: StageTextInput): string {
  const { file } = input;
  if (input.jevDown) return 'Jev indisponível: confira a chave do OpenRouter. A etapa segue sem a nota dele.';
  const reshape = input.running.find((step) => step.kind === 'suggest');
  if (reshape) return `${ROLE_NAME[reshape.role] ?? reshape.role} está reorganizando ${file} no modelo do documento.`;
  const review = input.running.find((step) => step.kind === 'refine');
  if (review) {
    const who = ROLE_NAME[review.role] ?? review.role;
    return input.firstStage ? `${who} está revisando ${file}.` : `${who} está revisando só ${file}; os documentos anteriores entram como resumo, para consulta.`;
  }
  if (input.graphing) return `Graphify está extraindo só ${file}.`;
  if (input.reviewed && !input.scored) return input.jevReads ? `Jev está dando a nota de ${file}.` : `Concluindo a revisão de ${file}.`;
  return `Preparando a revisão de ${file}.`;
}
