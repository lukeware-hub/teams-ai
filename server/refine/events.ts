import type { DocFile } from './draft.js';
import { withRenamedTypes } from '../core/event-types.js';

export const RefineEvent = {
  Created: 'REFINE_CREATED',
  /** The owner's answer to whether the project is confidential: `{confidential}`. */
  ConfidentialityAnswered: 'REFINE_CONFIDENTIALITY_ANSWERED',
  /** The owner moved on from a document's stage: `{doc, cycle}`; the rounds of the next stage count from `cycle`. */
  StageAdvanced: 'REFINE_STAGE_ADVANCED',
  /** The text the owner passed to a stage was kept the first time the stage was processed: `{file, hash}`; Reprocessar goes back to it. */
  StagePassed: 'REFINE_STAGE_PASSED',
  /** The owner moved on from the final review to the backlog: `{}`. */
  ReviewClosed: 'REFINE_REVIEW_CLOSED',
  StageReviewed: 'REFINE_STAGE_REVIEWED',
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
  /** A stage document rewritten in its template's shape: `{reshapeId, file, cycle, role, afterHash}`. */
  DocReshaped: 'DOC_RESHAPED',
  /** The owner undid a reshape: `{reshapeId}`. */
  DocReshapeUndone: 'DOC_RESHAPE_UNDONE',
  /** The owner closed the notice of a move or a reshape, so it stays hidden: `{noticeId}`. */
  NoticeClosed: 'REFINE_NOTICE_CLOSED',
  /** A full pass of the documents against the charter ended: `{cycle, hashes}` of each document as it stood, so the next pass reads only what changed. */
  DocsReorganized: 'DOCS_REORGANIZED',
  /** The findings of one cycle whose quotes the documents show; they replace the earlier list, or with `files` only those of the documents named. */
  FindingsReported: 'FINDINGS_REPORTED',
  QuestionAnswered: 'QUESTION_ANSWERED',
  QuestionSkipped: 'QUESTION_SKIPPED',
  /** A plan question dropped as a repeat of a decided one: the question, the earlier one it repeats and that answer. */
  QuestionDropped: 'QUESTION_DROPPED',
  /** The owner asked again for a dropped question: it comes back as a pending question. */
  QuestionReasked: 'QUESTION_REASKED',
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
  /** "Preparar planos" started: `{total, inputHash}`: the steps (the constitution plus four per backlog item) and the hash of the six inputs. */
  SpeckitStarted: 'PLANS_STARTED',
  /** The steps of an earlier preparation that this one keeps: `{steps}`, each with its command, item, basis and times. */
  SpeckitReused: 'PLANS_REUSED',
  /** One plan command started: `{command, itemKey?}`, so the owner sees what runs now. */
  SpeckitStepStarted: 'PLANS_STEP_STARTED',
  /** One plan command finished: `{command, itemKey?, files}`. */
  SpeckitStepDone: 'PLANS_STEP_DONE',
  SpeckitStepRepaired: 'PLANS_STEP_REPAIRED',
  AutopilotPaused: 'AUTOPILOT_PAUSED',
  /** The plan preparation finished: `{inputHash}` of the documents and item specs it read. */
  SpeckitDone: 'SPECKIT_DONE',
  /** The implementation plans of every item are written (plan 107): `{inputHash}`. An older build ignores it and shows the preparation as not done. */
  PlansPrepared: 'PLANS_PREPARED',
  /** The plan preparation stopped: `{reason, detail?}`, the reason in plain words for the owner and its technical detail. */
  SpeckitFailed: 'PLANS_FAILED',
  /** The PO or SM read the questions of a plan step: `{results, rework?}`; `rework` names the step to run again after an answer. */
  SpeckitTriaged: 'SPECKIT_TRIAGED',
  /** The plan preparation no longer stands: an answer came after its files were written, so the next run starts over. */
  SpeckitStale: 'PLANS_STALE',
  /** The PO and the SM started answering the open plan questions, at the owner's request. */
  SpeckitAnswersStarted: 'SPECKIT_ANSWERS_STARTED',
  /** The PO and the SM stopped answering the open plan questions, whether they finished or were stopped. */
  SpeckitAnswersDone: 'SPECKIT_ANSWERS_DONE',
  /** One System 1 decision of Gate 1; same type and record shape as the run journal, so the eval harness reads both. */
  /** A stage's validated document went to the Graphify extraction: `{file}`. */
  DocGraphStarted: 'REFINE_DOC_GRAPH_STARTED',
  /** The document is in the Graphify graph: `{file, hash, nodes, links, inputTokens, outputTokens}`. */
  DocGraphed: 'REFINE_DOC_GRAPHED',
  /** The document could not be added to the graph: `{file, reason}`, in plain words for the owner. */
  DocGraphFailed: 'REFINE_DOC_GRAPH_FAILED',
  /** The architecture step started on the five documents at this hash: `{docsHash}`. */
  ArchitectureStarted: 'REFINE_ARCHITECTURE_STARTED',
  /** The architecture the documents support: `{docsHash, architecture, questions}`; the questions are the owner's to answer. */
  ArchitectureDecided: 'REFINE_ARCHITECTURE_DECIDED',
  /** The architecture could not be decided, in plain words: `{reason}`. */
  ArchitectureFailed: 'REFINE_ARCHITECTURE_FAILED',
  DecisionMade: 'DECISION_MADE',
} as const;
/** The names the journal wrote before the plan preparation was renamed, each with its current name. */
const RENAMED_EVENT_TYPES = new Map<string, string>([
  ['SPECKIT_STARTED', RefineEvent.SpeckitStarted],
  ['SPECKIT_REUSED', RefineEvent.SpeckitReused],
  ['SPECKIT_STEP_STARTED', RefineEvent.SpeckitStepStarted],
  ['SPECKIT_STEP_DONE', RefineEvent.SpeckitStepDone],
  ['SPECKIT_STEP_REPAIRED', RefineEvent.SpeckitStepRepaired],
  ['SPECKIT_FAILED', RefineEvent.SpeckitFailed],
  ['SPECKIT_STALE', RefineEvent.SpeckitStale],
]);
/** An event as the current code names it: a journal written before the rename reads with the current names. */
export const currentEvent = withRenamedTypes(RENAMED_EVENT_TYPES);
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
  /** The document of a stage review's question; absent for a question of a full round. */
  file?: DocFile;
  /** The choices the owner can pick from; none for an open question. */
  options?: QuestionChoice[];
  /** The validator message a system question answers; its text is plain, so a repeat is recognized on this. */
  rule?: string;
  /** Set on a question plan left open during its preparation, or on one the architecture step leaves open. */
  origin?: 'speckit' | 'architecture';
  /** The backlog item a plan question is about. */
  itemKey?: string;
  /** The plan command that asked a plan question. */
  command?: string;
  /** The plain words the owner reads about a plan question: what it is about and why it needs a decision. */
  context?: string;
  /** The decided questions this one repeats, each with the real difference the agent named. */
  distinctFrom?: Array<{ questionId: string; difference: string }>;
}
/** A quote of one of the six documents that backs an answer: the file, the heading above the quote, and the quote. */
export interface QuoteEvidence {
  file: string;
  heading: string;
  quote: string;
}
/** A plan question as the PO or SM left it: its card for the owner, and the answer when the documents settle it. */
export interface SpeckitTriage {
  questionId: string;
  subject: string;
  context: string;
  text: string;
  options: QuestionChoice[];
  answer?: { text: string; by: 'po' | 'sm'; evidence: QuoteEvidence[] };
}
/** The journal's specHash field before a spec is frozen. */
export const DRAFT_HASH = 'draft';
