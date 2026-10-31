import type { DocFile } from './draft.js';
import type { RefineState } from './state.js';

/** The order a new project refines its documents in: each stage reads only the ones before it. */
export const DOC_STAGES: readonly DocFile[] = ['flow.md', 'project.md', 'briefing.md', 'stack.md', 'design.md'];

/** The documents a stage reads: the ones before it in the order. */
export const earlierDocs = (file: DocFile): readonly DocFile[] => DOC_STAGES.slice(0, DOC_STAGES.indexOf(file));

/** The first document the owner has not moved on from; undefined once all five are done. */
export const currentStageOf = (done: readonly DocFile[]): DocFile | undefined => DOC_STAGES.find((file) => !done.includes(file));

/** Why a document cannot be reviewed or suggested now, in plain words; null when it can. Only the current stage and the finished ones are open. */
export function stageBlocked(done: readonly DocFile[], file: DocFile): string | null {
  const current = currentStageOf(done);
  if (done.includes(file) || file === current) return null;
  return `Conclua a etapa ${current} antes de trabalhar em ${file}.`;
}

/** Why the stage cannot be continued yet, in plain words; null when it can: reviewed since its last edit, with no blocking question and no suggestion of its own left open. */
export function stageReviewBlock(state: Pick<RefineState, 'reviewedStages' | 'questions' | 'patches'>, file: DocFile): string | null {
  if (!(state.reviewedStages ?? []).includes(file)) return `Revise a etapa ${file} antes de continuar.`;
  if (state.questions.some((q) => q.file === file && q.status === 'pending' && q.blocking)) return `Responda as perguntas obrigatórias da etapa ${file}.`;
  if (state.patches.some((p) => p.file === file && p.status === 'pending')) return `Aceite ou rejeite as sugestões da etapa ${file}.`;
  return null;
}
