export const RefineEvent = {
  Created: 'REFINE_CREATED',
  DocEdited: 'DOC_EDITED',
  CycleStarted: 'REFINE_CYCLE_STARTED',
  DocsValidated: 'REFINE_DOCS_VALIDATED',
  Derived: 'DERIVED',
  Evaluated: 'REFINE_EVALUATED',
  CycleFailed: 'REFINE_CYCLE_FAILED',
  PatchProposed: 'PATCH_PROPOSED',
  PatchAccepted: 'PATCH_ACCEPTED',
  PatchRejected: 'PATCH_REJECTED',
  PatchDropped: 'PATCH_DROPPED',
  QuestionAnswered: 'QUESTION_ANSWERED',
  QuestionSkipped: 'QUESTION_SKIPPED',
  SecretWritten: 'SECRET_WRITTEN',
  StartedRun: 'REFINE_STARTED_RUN',
  /** One System 1 decision of Gate 1; same type and record shape as the run journal, so the eval harness reads both. */
  DecisionMade: 'DECISION_MADE',
} as const;
export interface Question {
  questionId: string;
  role: 'po' | 'sm';
  text: string;
  blocking: boolean;
  relatedAcIds: string[];
  cycle: number;
}
/** The journal's specHash field before a spec is frozen. */
export const DRAFT_HASH = 'draft';
