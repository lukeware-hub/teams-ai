import { DOC_STAGES } from '@server/refine/doc-stages';
import type { DocFile } from '@server/refine/draft';

export type StageState = 'done' | 'current' | 'todo';

export interface StageView {
  readonly doc: DocFile;
  readonly state: StageState;
  readonly score: number | null;
  readonly outdated: boolean;
}

/** The part of the refinement state the stage view reads. */
export interface StageInput {
  doneStages?: string[];
  readiness?: { docs?: Partial<Record<DocFile, { score: number }>> | null } | null;
  graphed?: string[];
  staleBy?: Record<string, string>;
}

/** A document is outdated when an earlier document changed after its review, or when it is finished but no longer in the graph (an edit took it out). The Jev score never makes a document outdated: it only informs. */
export const stageOutdated = (st: StageInput, doc: DocFile): boolean => doc in (st.staleBy ?? {}) || ((st.doneStages ?? []).includes(doc) && !(st.graphed ?? []).includes(doc));

/** Every document is processed: finished, in the graph and not outdated. */
export const allStagesCurrent = (st: StageInput): boolean => DOC_STAGES.every((doc) => (st.doneStages ?? []).includes(doc) && !stageOutdated(st, doc));

/** The five documents in stage order, each with its state, its score and whether that score is outdated. */
export function stageViews(st: StageInput): StageView[] {
  const current = currentStage(st);
  return DOC_STAGES.map((doc) => ({
    doc,
    state: (st.doneStages ?? []).includes(doc) ? 'done' : doc === current ? 'current' : 'todo',
    score: st.readiness?.docs?.[doc]?.score ?? null,
    outdated: stageOutdated(st, doc),
  }));
}

/** The document the owner is on, or null when every stage is done. */
export const currentStage = (st: StageInput): DocFile | null => DOC_STAGES.find((doc) => !(st.doneStages ?? []).includes(doc)) ?? null;

/** The stage before a document, or null for the first one. */
export function previousStage(doc: DocFile): DocFile | null {
  const index = DOC_STAGES.indexOf(doc);
  return index > 0 ? DOC_STAGES[index - 1]! : null;
}
