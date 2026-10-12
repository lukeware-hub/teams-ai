import type { AcceptanceCriterion } from '../../contracts/spec.js';
import type { DecideContext, Decider } from '../decider.js';
import type { BackendName, Questions } from '../types.js';

/**
 * Roadmap R11.5a slice 1 (plan 53), R11.5.7 (plan 72): the route rides along the journaled cycle for the eval; only with
 * decisions.autoAnswerFloor set, measured by that eval, does a question routed `auto` get answered from the docs.
 */
export type QuestionRoute = 'auto' | 'po' | 'sm' | 'human';

export const QUESTION_ROUTES: Record<QuestionRoute, string> = {
  auto: 'teams-ai\'s own fixed delivery contract (one repository per service the docs declare, or the project repository when they declare none; each its own compose stack on the project\'s shared network; the platform containers from the docs; one e2e suite per service) or the documents already attached already answer this, without any product or technical judgement call.',
  po: 'Answering needs product judgement: scope, a persona, priority, or what the acceptance criteria should require.',
  sm: 'Answering needs technical or feasibility judgement: architecture, a dependency, a constraint teams-ai\'s pipeline imposes, or how a task would be planned.',
  human: 'A genuine open decision nothing above resolves: a business choice, a tradeoff, or information only the human has.',
};

export function questionRoutingQuestions(): Questions {
  return {
    route: {
      type: 'choice',
      instructions: 'Classify who should answer this refinement question, so the human is asked only what genuinely needs them.',
      options: QUESTION_ROUTES,
    },
  };
}

export function questionRoutingState(criteria: readonly AcceptanceCriterion[], text: string): string {
  const acs = criteria.map((c) => `- ${c.id}: Given ${c.given}, when ${c.when}, then ${c.then}`);
  return ['related acceptance criteria:', ...(acs.length ? acs : ['(none)']), '', `question:\n${text}`].join('\n');
}

export interface QuestionRouting {
  route: QuestionRoute;
  confidence: number | null;
  source: BackendName;
}

/** Unanswered (layer off, or no chain configured yet) gives null: no hint, every question still reaches the human as before. */
export async function routeQuestion(
  criteria: readonly AcceptanceCriterion[],
  text: string,
  decider: Pick<Decider, 'decide'>,
  ctx: DecideContext,
): Promise<QuestionRouting | null> {
  const outcome = await decider.decide('question-routing', questionRoutingState(criteria, text), questionRoutingQuestions(), ctx);
  if (!outcome.answered) return null;
  const answer = outcome.answers.route;
  if (!answer || answer.type !== 'choice' || !(answer.value in QUESTION_ROUTES)) return null;
  return { route: answer.value as QuestionRoute, confidence: answer.confidence, source: outcome.backend };
}
