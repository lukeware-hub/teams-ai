import type { PlanTask } from '../../contracts/plan.js';
import type { DecideContext, Decider } from '../decider.js';
import type { BackendName, Questions } from '../types.js';

/** Spec 10A.5 decision 6. Levels are ordered low → high as a score question requires. */
export const ATTEMPT_PROGRESS_LEVELS = ['diverging', 'stalled', 'converging'] as const;
export type AttemptProgress = (typeof ATTEMPT_PROGRESS_LEVELS)[number];

export const ATTEMPT_PROGRESS_DEFAULT: AttemptProgress = 'converging';
const DELTA_CHARS = 3000;

export function attemptProgressQuestions(): Questions {
  return {
    progress: {
      type: 'score',
      instructions:
        'A developer agent has failed this task more than once. Each delta below is the feedback handed to the next attempt. Judge whether the attempts are diverging (new, unrelated failures each time), stalled (the same failure repeats) or converging (fewer or smaller failures each time).',
      levels: [...ATTEMPT_PROGRESS_LEVELS],
    },
  };
}

export function attemptProgressState(task: PlanTask, attempt: number, history: readonly string[]): string {
  const deltas = history.map((h, i) => `--- delta ${i + 1} ---\n${h.length > DELTA_CHARS ? h.slice(0, DELTA_CHARS) : h}`);
  return [`task: ${task.id}`, `title: ${task.title}`, `criteria: ${task.criteriaRefs.join(', ')}`, `attempt about to start: ${attempt}`, '', ...deltas].join('\n');
}

export interface ProgressResult {
  progress: AttemptProgress;
  source: 'default' | BackendName;
}

/** The weighted level index may fall between levels; round to the nearest one. */
export async function assessAttemptProgress(
  task: PlanTask,
  attempt: number,
  history: readonly string[],
  decider: Pick<Decider, 'decide'>,
  ctx: DecideContext,
): Promise<ProgressResult> {
  const outcome = await decider.decide('attempt-progress', attemptProgressState(task, attempt, history), attemptProgressQuestions(), ctx);
  if (!outcome.answered) return { progress: ATTEMPT_PROGRESS_DEFAULT, source: 'default' };
  const answer = outcome.answers.progress;
  if (!answer || answer.type !== 'score') return { progress: ATTEMPT_PROGRESS_DEFAULT, source: 'default' };
  const idx = Math.min(ATTEMPT_PROGRESS_LEVELS.length - 1, Math.max(0, Math.round(answer.value)));
  return { progress: ATTEMPT_PROGRESS_LEVELS[idx]!, source: outcome.backend };
}
