import type { PlanTask } from '../../contracts/plan.js';
import type { DecideContext, Decider } from '../decider.js';
import type { BackendName, Questions } from '../types.js';

/** Spec 10A.5 decisions 10 and 11: one call picks the model tier and the effort for attempt 1. */
export const MODEL_TIERS = ['small', 'medium', 'large'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

const TIER_OPTIONS: Record<ModelTier, string> = {
  small: 'Mechanical or local work: renames, config, docs, a single small function with an obvious test.',
  medium: 'Ordinary feature work inside one module with clear criteria and no cross-cutting design.',
  large: 'Cross-module changes, concurrency, data migrations, security or auth paths, or ambiguous criteria.',
};

export function modelTierQuestions(): Questions {
  return {
    tier: { type: 'choice', instructions: 'Pick the smallest model tier that can implement this task correctly on the first attempt.', options: TIER_OPTIONS },
    effort: { type: 'score', instructions: 'How much reasoning effort does this task need?', levels: [...EFFORT_LEVELS] },
  };
}

export function modelTierState(task: PlanTask, attempt: number): string {
  return [
    `task: ${task.id}`,
    `title: ${task.title}`,
    `description: ${task.description}`,
    `owner: ${task.owner}`,
    `criteria: ${task.criteriaRefs.join(', ')}`,
    `declared paths: ${task.affectedPaths.join(', ')}`,
    `attempt: ${attempt}`,
  ].join('\n');
}

export interface ModelTierResult {
  tier: ModelTier | null;
  effort: Effort | null;
  source: 'default' | BackendName;
}

const bump = <T extends readonly string[]>(levels: T, idx: number, steps: number): T[number] => levels[Math.min(levels.length - 1, idx + steps)]!;

/** Attempt 2 onward moves one tier and one effort level up, so a misclassified task self-corrects (spec 10A.5). */
export async function chooseModelTier(task: PlanTask, attempt: number, decider: Pick<Decider, 'decide'>, ctx: DecideContext): Promise<ModelTierResult> {
  const outcome = await decider.decide('model-tier', modelTierState(task, attempt), modelTierQuestions(), ctx);
  if (!outcome.answered) return { tier: null, effort: null, source: 'default' };
  const t = outcome.answers.tier;
  const e = outcome.answers.effort;
  if (!t || t.type !== 'choice' || !(t.value in TIER_OPTIONS) || !e || e.type !== 'score') return { tier: null, effort: null, source: 'default' };
  const extra = Math.max(0, attempt - 1);
  const tier = bump(MODEL_TIERS, MODEL_TIERS.indexOf(t.value as ModelTier), extra);
  const effort = bump(EFFORT_LEVELS, Math.min(EFFORT_LEVELS.length - 1, Math.max(0, Math.round(e.value))), extra);
  return { tier, effort, source: outcome.backend };
}
