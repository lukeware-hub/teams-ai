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
  /** Backlog mode: the human asked the agents to break the docs into a prioritized backlog of specs. */
  BacklogEnabled: 'BACKLOG_ENABLED',
  BacklogDerived: 'BACKLOG_DERIVED',
  /** The human asked for the detailing: from now on each cycle derives the spec and pre-plan of every changed item. */
  BacklogDetailEnabled: 'BACKLOG_DETAIL_ENABLED',
  /** One backlog item's spec (or why it failed): `{cycle, key, specId, inputHash, rev, spec|null, issues, highWater}`. */
  SpecDerived: 'SPEC_DERIVED',
  /** One backlog item's pre-plan (or why it failed): `{cycle, key, inputHash, specRev, preplan|null, issues}`. */
  PreplanDerived: 'PREPLAN_DERIVED',
  /** The SM's map of items that change the same code and never run together: `{inputHash, pairs}`. */
  ConflictsDerived: 'CONFLICTS_DERIVED',
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
  /** A short topic that names the decision heading in the briefing; the question text is the heading when absent. */
  subject?: string;
}
/** The journal's specHash field before a spec is frozen. */
export const DRAFT_HASH = 'draft';
