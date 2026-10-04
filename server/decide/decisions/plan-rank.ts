import type { Plan } from '../../contracts/plan.js';
import type { Spec } from '../../contracts/spec.js';
import type { DecideContext, Decider } from '../decider.js';
import type { BackendName, Questions } from '../types.js';

/** Spec 10A.5 decision 12: one Score per candidate the SM authored; System 1 never invents a plan. */
export const PLAN_RANK_LEVELS = [
  'poor: leaves acceptance criteria uncovered or carries a high delivery risk',
  'weak: covers the criteria only partly or with risky, tangled tasks',
  'adequate: covers every criterion with an ordinary risk',
  'strong: covers every criterion with small, mostly independent tasks',
  'excellent: covers every criterion with the fewest, smallest, independent tasks and a simple deploy',
];

const key = (i: number) => `c${i}`;

export function planRankQuestions(count: number): Questions {
  return Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      key(i),
      {
        type: 'score' as const,
        instructions: `Score candidate plan ${key(i)} from the STATE on two things together: how fully its tasks cover every acceptance criterion, and how low its delivery risk is.`,
        levels: PLAN_RANK_LEVELS,
      },
    ]),
  );
}

export function planRankState(spec: Spec, candidates: readonly Plan[]): string {
  const acs = spec.acceptanceCriteria.map((c) => `- ${c.id}: Given ${c.given}, when ${c.when}, then ${c.then}`);
  const blocks = candidates.map((p, i) => [
    `candidate ${key(i)}: stack ${p.stack}, ${p.tasks.length} tasks, deploy ${p.deploy.image} on port ${p.deploy.port} (${p.deploy.manifests.length} manifests)`,
    ...p.tasks.map((t) => `  - ${t.id} [${t.owner}] ${t.title}; covers ${t.criteriaRefs.join(', ') || 'none'}; depends on ${t.dependsOn.join(', ') || 'nothing'}; ${t.affectedPaths.length} paths`),
  ].join('\n'));
  return ['acceptance criteria:', ...acs, '', ...blocks].join('\n');
}

export interface PlanRanking {
  index: number;
  source: 'rule' | 'default' | BackendName;
}

/** The SM's first plan wins a tie and every unanswered case, so ranking can only change the pick on a clear answer. */
export async function rankPlans(spec: Spec, candidates: readonly Plan[], decider: Pick<Decider, 'decide'>, ctx: DecideContext): Promise<PlanRanking> {
  if (candidates.length < 2) return { index: 0, source: 'rule' };
  const outcome = await decider.decide('plan-rank', planRankState(spec, candidates), planRankQuestions(candidates.length), ctx);
  if (!outcome.answered) return { index: 0, source: 'default' };
  let best = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const a = outcome.answers[key(i)];
    if (!a || a.type !== 'score') return { index: 0, source: 'default' };
    if (a.value > bestScore) {
      best = i;
      bestScore = a.value;
    }
  }
  return { index: best, source: outcome.backend };
}
