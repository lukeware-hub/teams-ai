import type { Role } from '../config/config.js';

/** Spec 10A.0: the chain order is jev → local → claude; a decision's config may drop entries. */
export const BACKEND_NAMES = ['jev', 'local', 'claude'] as const;
export type BackendName = (typeof BACKEND_NAMES)[number];

/** Spec 10A.5: phase 1 ships decision 1 only; decisions 2–9 append here in phase 3. */
export const DECISION_IDS = ['gate-triage'] as const;
export type DecisionId = (typeof DECISION_IDS)[number];

/**
 * System One models understand structure (docs.typesafe.ai/primitives/advanced): an instruction,
 * an option description or a level may be a string, a JSON object or an array, sent as is.
 */
export type Entry = string | Record<string, unknown> | unknown[];

export interface ChoiceQuestion {
  type: 'choice';
  instructions: Entry;
  /** option name → description; both reach the model, so descriptions must separate the options. */
  options: Record<string, Entry>;
}
export interface ScoreQuestion {
  type: 'score';
  instructions: Entry;
  /** Ordered low → high; 2–10 entries. */
  levels: Entry[];
}
export interface NoulQuestion {
  type: 'noul';
  instructions: Entry;
  criteria?: { true: Entry; false: Entry };
}
export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;
export type Questions = Record<string, Question>;

export interface ChoiceAnswer {
  type: 'choice';
  value: string;
  probabilities: Record<string, number>;
  confidence: number | null;
}
export interface ScoreAnswer {
  type: 'score';
  /** Probability-weighted level index; may fall between levels. */
  value: number;
  probabilities: Record<string, number>;
  confidence: number | null;
}
export interface NoulAnswer {
  type: 'noul';
  /** P(yes). */
  value: number;
  probabilities: { yes: number; no: number };
  confidence: number | null;
}
export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;
export type Answers = Record<string, Answer>;

export interface BackendUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export type BackendResult =
  | { ok: true; answers: Answers; model: string; usage: BackendUsage }
  | { ok: false; reason: 'unavailable' | 'invalid'; message: string };

export interface BackendInput {
  state: string;
  questions: Questions;
  /** Role that answers when this input reaches the Claude backend (spec 10A.5 "Escalates to"). */
  escalateTo: Role;
}

export interface DecisionBackend {
  readonly name: BackendName;
  evaluate(input: BackendInput): Promise<BackendResult>;
}

export interface DecisionConfig {
  enabled: boolean;
  chain: BackendName[];
  /** Per backend because Jev is calibrated and the local model is not (spec 10A.0). */
  thresholds: { jev: number; local: number };
  escalateTo: Role;
}

export type AttemptOutcome = 'answered' | 'low-confidence' | 'unavailable' | 'invalid' | 'skipped-confidential' | 'missing-backend';

export interface DecisionAttempt {
  backend: BackendName;
  outcome: AttemptOutcome;
  confidence: number | null;
  model: string | null;
  usage: BackendUsage | null;
  /** Redacted failure reason from the backend, for diagnosis (spec 10A.0 logging). */
  message: string | null;
}

/** One line per decision in the event store; later joined with the real outcome (spec 10A.4). */
export interface DecisionRecord {
  decisionId: DecisionId;
  backend: BackendName | null;
  model: string | null;
  escalated: boolean;
  answers: Answers | null;
  /** One entry per backend visited; `usage` is set when the backend answered (even below threshold), `message` when it failed. */
  attempts: DecisionAttempt[];
  /** Sum of every attempt's usage. */
  usage: BackendUsage;
  stateChars: number;
  stateTruncated: boolean;
  durationMs: number;
  at: string;
}

export type DecisionOutcome =
  | { answered: true; answers: Answers; backend: BackendName; escalated: boolean }
  | { answered: false; reason: 'disabled' | 'exhausted' };

export function noulConfidence(p: number): number {
  return Math.max(p, 1 - p);
}

/** 1 − normalized Shannon entropy over the levels (spec 10A.1); a single level is fully certain. */
export function scoreConfidence(probabilities: Record<string, number>): number {
  const ps = Object.values(probabilities).filter((p) => p > 0);
  const n = Object.keys(probabilities).length;
  if (n <= 1) return 1;
  const entropy = -ps.reduce((acc, p) => acc + p * Math.log(p), 0);
  return Math.max(0, Math.min(1, 1 - entropy / Math.log(n)));
}

export function answerConfidence(a: Answer): number {
  return a.confidence ?? 0;
}

export function minConfidence(answers: Answers): number {
  const values = Object.values(answers);
  if (values.length === 0) return 0;
  return Math.min(...values.map(answerConfidence));
}
