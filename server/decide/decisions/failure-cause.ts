import type { DecideContext, Decider } from '../decider.js';
import type { Questions } from '../types.js';

/** R11.14. Only a spec problem stops a retry; the other two are told apart for the journal. */
export type FailureCause = 'code-defect' | 'environment' | 'spec-problem';

export const FAILURE_CAUSES: Record<FailureCause, string> = {
  'code-defect': 'The delivered code or its tests fail: a failing test, a failed gate, a blocked task or a criterion without evidence. Another run that sees this failure can fix it.',
  environment: 'The host failed, not the work: a container or network down, quota, login, a timeout or a full disk. Another run later can pass with no change.',
  'spec-problem': 'The criteria contradict each other or cannot be met as written, so every run fails the same way until a person changes the spec.',
};

export function failureCauseQuestions(): Questions {
  return { cause: { type: 'choice', instructions: 'A spec run failed. From the failures of its attempts, oldest first, classify the cause of the latest one.', options: FAILURE_CAUSES } };
}

export const failureCauseState = (failures: readonly string[]): string => failures.map((f, i) => `attempt ${i + 1}:\n${f}`).join('\n\n');

/** Unanswered (layer off or exhausted) gives null. */
export async function classifyFailure(failures: readonly string[], decider: Pick<Decider, 'decide'>, ctx: DecideContext): Promise<FailureCause | null> {
  const outcome = await decider.decide('failure-cause', failureCauseState(failures), failureCauseQuestions(), ctx);
  if (!outcome.answered) return null;
  const answer = outcome.answers.cause;
  return answer?.type === 'choice' && answer.value in FAILURE_CAUSES ? (answer.value as FailureCause) : null;
}

/** Without a classification nothing says another run would end differently, so an unanswered cause is not retried (live: three identical plan failures). */
export const retryable = (cause: FailureCause | null): boolean => cause !== null && cause !== 'spec-problem';
