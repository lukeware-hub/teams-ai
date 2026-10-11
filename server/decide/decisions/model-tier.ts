import { SCAFFOLD_TASK_ID, type PlanTask } from '../../contracts/plan.js';
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
  source: 'default' | 'heuristic' | BackendName;
}

/**
 * Work whose mistakes are costly and subtle, judged by what the task is called and where it writes: a description names
 * `package-lock`, `crypto.randomUUID` or `docker login` in passing, which says nothing about the work (todo-api-r12).
 */
const RISKY = /\b(auth\w*|login|session|password|token|crypt\w*|permission|payment|billing|migrat\w*|schema|concurren\w*|transaction)\b/i;

/**
 * R11.13 slice 6: a free, deterministic stand-in for the decision backends (which are off, or cost money): the tier from
 * what the plan already says about the task. It only reads the task, so the same plan always routes the same way. Only the
 * project scaffold, risky work and unusually big tasks go large; attempt 2 onward moves a tier up like the decision does,
 * so a task that was sized too small corrects itself.
 */
export function heuristicTier(task: PlanTask, attempt: number): ModelTierResult {
  const where = `${task.title} ${task.affectedPaths.join(' ')}`;
  let tier: ModelTier = 'medium';
  if (task.id === SCAFFOLD_TASK_ID || RISKY.test(where) || task.affectedPaths.length >= 8 || task.criteriaRefs.length >= 6 || task.description.length > 2500) tier = 'large';
  else if (task.criteriaRefs.length <= 1 && task.affectedPaths.length <= 3 && task.description.length <= 1000) tier = 'small';
  return { tier: bump(MODEL_TIERS, MODEL_TIERS.indexOf(tier), Math.max(0, attempt - 1)), effort: null, source: 'heuristic' };
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
