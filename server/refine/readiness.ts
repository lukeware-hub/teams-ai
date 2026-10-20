import type { DocFile } from './draft.js';

/** The four checks the Jev answers for each document, each one a probability of yes. */
export const SCORE_CHECKS = ['complete', 'concrete', 'consistent', 'scoped'] as const;
export type ScoreCheck = (typeof SCORE_CHECKS)[number];

/** One document's score: the mean of its four checks, each from 0 to 1. */
export interface DocScore {
  score: number;
  checks: Record<ScoreCheck, number>;
}

export interface ScoreUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

/** What the Jev answered for the five documents, or why it did not answer. */
export interface DocsScoreRecord {
  available: boolean;
  model: string | null;
  /** The mean of the five document scores, from 0 to 1; null when the Jev did not answer. */
  average: number | null;
  docs: Record<DocFile, DocScore> | null;
  usage: ScoreUsage | null;
}

/** The latest score: the cycle that journaled it, why it was skipped, and whether a document changed since. */
export interface Readiness extends DocsScoreRecord {
  cycle: number;
  skipped?: 'confidential';
  outdated: boolean;
}

/** The minimum score, in whole percent, that makes a project ready to develop. */
export const READY_PERCENT = 80;

export const UNSCORED: DocsScoreRecord = { available: false, model: null, average: null, docs: null, usage: null };

/** A score in whole percent: 79.6% rounds to 80, the number the screen shows and the gate reads. */
export const percentOf = (average: number): number => Math.round(average * 100);

export type JevVerdict = 'none' | 'skipped' | 'unavailable' | 'outdated' | 'below' | 'ready';

/** The verdict of the latest score: none before any, skipped for a confidential project, outdated once a document changed. */
export function jevVerdict(r: Readiness | undefined): JevVerdict {
  if (!r) return 'none';
  if (r.skipped) return 'skipped';
  if (!r.available || r.average === null) return 'unavailable';
  if (r.outdated) return 'outdated';
  return percentOf(r.average) >= READY_PERCENT ? 'ready' : 'below';
}

/** A backlog start waits for a current score at or above the minimum; no score and a confidential project never block it. */
export const jevBlocksStart = (backlogEnabled: boolean, r: Readiness | undefined): boolean =>
  backlogEnabled && ['unavailable', 'outdated', 'below'].includes(jevVerdict(r));

/** The sessions whose documents the Jev scores: a new project and a backlog, not a single spec or its continuation. */
export const scoresDocs = (mode: string | null): boolean => mode === 'new-project' || mode === 'backlog';
