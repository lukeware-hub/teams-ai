// Shared with the web page, so this file imports no Node module.
import { buildSpecsIndex } from './specs-index.js';
import type { RefineState } from './state.js';

/** The part of the session a preparation reads: the detailed backlog, or the single spec it derived. */
export type PlanSource = Pick<RefineState, 'backlog' | 'derived' | 'featureKey' | 'repositories' | 'architecture'>;

/** One backlog item, or the single spec, which gets one plan. */
export interface PlanItem {
  key: string;
  specId: string;
  title: string;
  /** The repository the spec changes, when its draft has an architecture. */
  repository?: string;
}

/** The plans to write: each backlog item, or the single spec as one item. */
export function planItems(draftId: string, source: PlanSource): PlanItem[] {
  if (source.backlog?.enabled) return buildSpecsIndex(draftId, source.backlog).specs;
  return source.derived ? [{ key: source.featureKey ?? draftId, specId: draftId, title: source.derived.spec.objectives[0]! }] : [];
}
