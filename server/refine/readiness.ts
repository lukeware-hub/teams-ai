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

/** What the Jev answered for the documents asked for, or why it did not answer. */
export interface DocsScoreRecord {
  available: boolean;
  model: string | null;
  /** The mean of the document scores held, from 0 to 1; null when the Jev did not answer. */
  average: number | null;
  docs: Partial<Record<DocFile, DocScore>> | null;
  usage: ScoreUsage | null;
}

/** The latest score: the cycle that journaled it, why it was skipped, and whether a document changed since. */
export interface Readiness extends DocsScoreRecord {
  cycle: number;
  skipped?: 'confidential';
  outdated: boolean;
}

/** The percent a check must reach to pass in the goals of a full round; the owner has not decided it for a project. */
export const READY_PERCENT = 80;

export const UNSCORED: DocsScoreRecord = { available: false, model: null, average: null, docs: null, usage: null };

/** A score in whole percent: 79.6% rounds to 80, the number the screen shows and the gate reads. */
export const percentOf = (average: number): number => Math.round(average * 100);

/** What a document must do for each check to pass, as the agents act on it. */
export const CHECK_GOAL: Record<ScoreCheck, string> = {
  complete: 'hold every part its purpose requires',
  concrete: 'state most things as checkable facts: exact values, names, limits or observable behavior, with no placeholders or open questions',
  consistent: 'contain no two statements that contradict each other',
  scoped: 'hold only what belongs in it; content that belongs in another document is moved there',
};

/** A check at or above this share passes; a document is ready when all its checks pass. */
/** A check passes when the percent shown for it reaches READY_PERCENT, so a check shown as 80% is never below the goal. */
export const meetsGoal = (share: number): boolean => percentOf(share) >= READY_PERCENT;

/** Each check below the goal, per document, as one line for the agents: the target they must reach in this round. */
export function jevGoals(r: Readiness | undefined): string[] {
  if (!r?.docs) return [];
  return Object.entries(r.docs).flatMap(([file, doc]) => {
    const weak = SCORE_CHECKS.filter((id) => !meetsGoal(doc.checks[id]));
    if (weak.length === 0) return [];
    return [`- ${file} (${percentOf(doc.score)}%): ${weak.map((id) => `${id} ${percentOf(doc.checks[id])}%, it must ${CHECK_GOAL[id]}`).join('; ')}.`];
  });
}

export type JevVerdict = 'none' | 'skipped' | 'unavailable' | 'outdated' | 'scored';

/** The verdict of the latest score: none before any, skipped for a confidential project, outdated once a document changed, else scored. */
export function jevVerdict(r: Readiness | undefined): JevVerdict {
  if (!r) return 'none';
  if (r.skipped) return 'skipped';
  if (!r.available || r.average === null) return 'unavailable';
  if (r.outdated) return 'outdated';
  return 'scored';
}

/** The sessions whose documents the Jev scores: a new project and a backlog, not a single spec or its continuation. */
export const scoresDocs = (mode: string | null): boolean => mode === 'new-project' || mode === 'backlog';
