export const RefineEvent = {
  Created: 'REFINE_CREATED',
  DocEdited: 'DOC_EDITED',
  CycleStarted: 'REFINE_CYCLE_STARTED',
  DocsValidated: 'REFINE_DOCS_VALIDATED',
  /** The Jev's score of the five documents: `{cycle, available, skipped?, model, average, docs, usage}`. */
  DocsScored: 'REFINE_DOCS_SCORED',
  Derived: 'DERIVED',
  Evaluated: 'REFINE_EVALUATED',
  CycleFailed: 'REFINE_CYCLE_FAILED',
  /** The owner clicked Avaliar or Reavaliar: the clock of one evaluation, which may run several cycles. */
  EvaluationStarted: 'REFINE_EVALUATION_STARTED',
  /** The evaluation ended; `{interrupted: true}` when a restart cut it off, which voids its record. */
  EvaluationEnded: 'REFINE_EVALUATION_ENDED',
  PatchProposed: 'PATCH_PROPOSED',
  PatchAccepted: 'PATCH_ACCEPTED',
  PatchRejected: 'PATCH_REJECTED',
  PatchDropped: 'PATCH_DROPPED',
  /** A move applied at once: text cut from one document and added to another. */
  DocMoved: 'DOC_MOVED',
  /** The owner undid a move, so both documents went back to their earlier text. */
  DocMoveUndone: 'DOC_MOVE_UNDONE',
  /** A full pass of the documents against the charter ended: `{cycle, hashes}` of each document as it stood, so the next pass reads only what changed. */
  DocsReorganized: 'DOCS_REORGANIZED',
  /** The findings of one cycle whose quotes the documents show; they replace the earlier list. */
  FindingsReported: 'FINDINGS_REPORTED',
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
/** A choice the owner can pick as the answer; `recommended` marks the one the agent suggests. */
export interface QuestionChoice {
  label: string;
  detail: string;
  recommended?: boolean;
}
export interface Question {
  questionId: string;
  role: 'po' | 'sm';
  text: string;
  blocking: boolean;
  relatedAcIds: string[];
  cycle: number;
  /** A short topic that names the decision heading in the briefing; the question text is the heading when absent. */
  subject?: string;
  /** The choices the owner can pick from; none for an open question. */
  options?: QuestionChoice[];
  /** The validator message a system question answers; its text is plain, so a repeat is recognized on this. */
  rule?: string;
}
/** The journal's specHash field before a spec is frozen. */
export const DRAFT_HASH = 'draft';
