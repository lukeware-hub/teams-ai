import type { AcceptanceCriterion } from '../../contracts/spec.js';
import type { DecideContext, Decider } from '../decider.js';
import type { BackendName, Questions } from '../types.js';

/** Spec 10A.5 decision 7. The route is a hint written into the continuation brief; PO and SM still decide. */
export type ReportRoute = 'bug-existing-ac' | 'new-requirement' | 'environment' | 'unclear';

export const REPORT_ROUTES: Record<ReportRoute, string> = {
  'bug-existing-ac': 'The service does not do what an existing acceptance criterion already promises; the fix belongs to that criterion.',
  'new-requirement': 'The human asks for behavior no existing acceptance criterion covers: a new feature, field, endpoint or rule.',
  environment: 'The problem lies in the deploy or the host (service down, wrong URL or port, missing secret, container not running), not in the behavior the criteria describe.',
  unclear: 'The report is too vague, mixes several problems, or cannot be tied to a criterion or to the environment; a human must clarify it.',
};

export function reportRoutingQuestions(): Questions {
  return {
    route: {
      type: 'choice',
      instructions: 'A human validated a delivered spec and reported a problem. From the acceptance criteria and the report, classify what kind of problem it is.',
      options: REPORT_ROUTES,
    },
  };
}

export function reportRoutingState(criteria: readonly AcceptanceCriterion[], report: string): string {
  const acs = criteria.map((c) => `- ${c.id}: Given ${c.given}, when ${c.when}, then ${c.then}`);
  return ['acceptance criteria:', ...acs, '', `report:\n${report}`].join('\n');
}

export interface ReportRouting {
  route: ReportRoute;
  confidence: number | null;
  source: BackendName;
}

/** No deterministic rule applies to free text. Unanswered (layer off or exhausted) gives null: no hint, the brief stays as before. */
export async function routeReport(
  criteria: readonly AcceptanceCriterion[],
  report: string,
  decider: Pick<Decider, 'decide'>,
  ctx: DecideContext,
): Promise<ReportRouting | null> {
  const outcome = await decider.decide('report-routing', reportRoutingState(criteria, report), reportRoutingQuestions(), ctx);
  if (!outcome.answered) return null;
  const answer = outcome.answers.route;
  if (!answer || answer.type !== 'choice' || !(answer.value in REPORT_ROUTES)) return null;
  return { route: answer.value as ReportRoute, confidence: answer.confidence, source: outcome.backend };
}
