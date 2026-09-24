import type { PlanTask } from '../../contracts/plan.js';
import type { DecideContext, Decider } from '../decider.js';
import type { BackendName, NoulQuestion, Questions } from '../types.js';

/** Spec 10A.5 decision 9: high drift forces the deep review profile; the review is never skipped or failed here. */
export type ScopeDrift = 'none' | 'low' | 'high';

const MAX_FILES = 20;
const FILE_REQUIRED_MIN = 0.5;
const UNREQUIRED_LOW = 0.4;
const UNREQUIRED_HIGH = 0.7;

export function fileKey(path: string): string {
  return `file:${path}`;
}

export function scopeDriftQuestions(outOfScope: readonly string[]): Questions {
  const questions: Questions = {};
  for (const path of outOfScope.slice(0, MAX_FILES)) {
    const q: NoulQuestion = {
      type: 'noul',
      instructions: `The file ${path} is outside the task's declared paths. Is changing it required to satisfy the task and its acceptance criteria?`,
      criteria: { true: 'The task cannot be completed without this change.', false: 'The change is unrelated, opportunistic or could live inside the declared paths.' },
    };
    questions[fileKey(path)] = q;
  }
  questions.unrequired = {
    type: 'noul',
    instructions: 'Does the change set contain work that none of the referenced acceptance criteria require (refactors, extra features, unrelated fixes)?',
    criteria: { true: 'Some changes are not required by any referenced criterion.', false: 'Every change serves a referenced criterion.' },
  };
  return questions;
}

export interface ScopeDriftInput {
  changedFiles: readonly string[];
  outOfScope: readonly string[];
  scopeJustification?: string | undefined;
  diffStat: string;
}

export function scopeDriftState(task: PlanTask, opts: ScopeDriftInput): string {
  return [
    `task: ${task.id}`,
    `title: ${task.title}`,
    `description: ${task.description}`,
    `criteria: ${task.criteriaRefs.join(', ')}`,
    `declared paths: ${task.affectedPaths.join(', ')}`,
    '',
    `changed files (${opts.changedFiles.length}):`,
    ...opts.changedFiles.slice(0, MAX_FILES * 3),
    '',
    `outside declared paths (${opts.outOfScope.length}):`,
    ...opts.outOfScope.slice(0, MAX_FILES),
    '',
    `developer's scope justification: ${opts.scopeJustification?.trim() || '(none given)'}`,
    '',
    `diff stat:\n${opts.diffStat}`,
  ].join('\n');
}

export interface ScopeDriftResult {
  drift: ScopeDrift;
  /** Out-of-scope files judged not required by the task. */
  unrequired: string[];
  source: 'default' | BackendName;
}

export async function assessScopeDrift(
  task: PlanTask,
  opts: ScopeDriftInput,
  decider: Pick<Decider, 'decide'>,
  ctx: DecideContext,
): Promise<ScopeDriftResult> {
  const outcome = await decider.decide('scope-drift', scopeDriftState(task, opts), scopeDriftQuestions(opts.outOfScope), ctx);
  if (!outcome.answered) return { drift: 'none', unrequired: [], source: 'default' };
  const unrequired = opts.outOfScope.slice(0, MAX_FILES).filter((path) => {
    const a = outcome.answers[fileKey(path)];
    return a?.type === 'noul' && a.value < FILE_REQUIRED_MIN;
  });
  const general = outcome.answers.unrequired;
  const pUnrequired = general?.type === 'noul' ? general.value : 0;
  const drift: ScopeDrift = unrequired.length > 0 || pUnrequired >= UNREQUIRED_HIGH ? 'high' : pUnrequired >= UNREQUIRED_LOW ? 'low' : 'none';
  return { drift, unrequired, source: outcome.backend };
}
