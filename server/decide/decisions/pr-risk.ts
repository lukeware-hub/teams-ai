import type { PlanTask } from '../../contracts/plan.js';
import type { DecideContext, Decider } from '../decider.js';
import type { BackendName, Questions } from '../types.js';

/** Spec 10A.5 decision 5: risk picks the review profile; the review itself is never skipped. */
export const PR_RISK_LEVELS = ['trivial', 'low', 'medium', 'high'] as const;
export type PrRisk = (typeof PR_RISK_LEVELS)[number];
export type ReviewProfile = 'quick' | 'standard' | 'deep';

/** Graph impact radius (graphify `affected` depth) per profile; 0 means no impact context. */
export const REVIEW_PROFILE_DEPTH: Record<ReviewProfile, number> = { quick: 0, standard: 2, deep: 3 };
const PROFILE_OF: Record<PrRisk, ReviewProfile> = { trivial: 'quick', low: 'standard', medium: 'standard', high: 'deep' };
const DEFAULT_RISK: PrRisk = 'medium';
const MAX_FILES = 60;

export function prRiskQuestions(): Questions {
  return {
    risk: {
      type: 'score',
      instructions:
        'A developer agent committed a change for the task below. From the task, its acceptance criteria and the diff stat, rate how risky it is to merge: trivial (docs, config, tiny local change), low, medium, high (touches shared code, many files, data or auth paths).',
      levels: [...PR_RISK_LEVELS],
    },
  };
}

export function prRiskState(task: PlanTask, opts: { changedFiles: readonly string[]; diffStat: string }): string {
  const files = opts.changedFiles.slice(0, MAX_FILES);
  return [
    `task: ${task.id}`,
    `title: ${task.title}`,
    `description: ${task.description}`,
    `criteria: ${task.criteriaRefs.join(', ')}`,
    `declared paths: ${task.affectedPaths.join(', ')}`,
    '',
    `changed files (${opts.changedFiles.length}):`,
    ...files,
    '',
    `diff stat:\n${opts.diffStat}`,
  ].join('\n');
}

export interface PrRiskResult {
  risk: PrRisk;
  profile: ReviewProfile;
  source: 'default' | BackendName;
}

export async function choosePrRisk(
  task: PlanTask,
  opts: { changedFiles: readonly string[]; diffStat: string },
  decider: Pick<Decider, 'decide'>,
  ctx: DecideContext,
): Promise<PrRiskResult> {
  const outcome = await decider.decide('pr-risk', prRiskState(task, opts), prRiskQuestions(), ctx);
  const answer = outcome.answered ? outcome.answers.risk : undefined;
  if (!outcome.answered || !answer || answer.type !== 'score') return { risk: DEFAULT_RISK, profile: PROFILE_OF[DEFAULT_RISK], source: 'default' };
  const risk = PR_RISK_LEVELS[Math.min(PR_RISK_LEVELS.length - 1, Math.max(0, Math.round(answer.value)))]!;
  return { risk, profile: PROFILE_OF[risk], source: outcome.backend };
}
